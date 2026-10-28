// Option A code generation (handoff 05, ADR-0003, ADR-0009): one playbook per flow level, one play
// per node, host sets routed between plays with group_by, and a final outcome play that fails the
// hosts left on open ports or failed end nodes (no host ever fails inside a node play).
import { buildModel, type FlowModel, type Level, ROOT } from '../flow/model';
import { isFailPort, legalPorts, portsFor } from '../flow/ports';
import type { Edge, FlowDocument, FlowNode, Ulid } from '../flow/types';
import type { Finding } from '../flow/validate';
import type {
  Engine,
  GeneratedFile,
  GenerateOptions,
  GenerateResult,
  PlayRange,
  Route,
} from './types';
import { checksum, durationSeconds, groupPart } from './util';
import { comment, flow, type Out, type OutMap, writeBlock } from './yamlWriter';

export const CHECKSUM_PREFIX = '# Checksum: ';

/** include_role options; every other role param becomes a role var. */
const INCLUDE_OPTIONS = new Set([
  'tasks_from',
  'vars_from',
  'defaults_from',
  'handlers_from',
  'public',
  'allow_duplicates',
  'rolespec_validate',
]);

interface LevelCtx {
  level: Level;
  /** Keys of the enclosing subflow nodes, outermost first. */
  path: string[];
  file: string;
  /** Host pattern of a start node (root) or of the subflow's entry (inner levels). */
  entry: string;
  parent?: { node: FlowNode; ctx: LevelCtx };
}

interface Chunk {
  node?: Ulid;
  lines: string[];
}

interface OutcomeEntry {
  order: number;
  groups: string[];
  name: string;
  msg: string;
}

class Generator {
  private readonly model: FlowModel;
  private readonly findings: Finding[] = [];
  private readonly routes: Record<string, Route> = {};
  private readonly outcome: OutcomeEntry[] = [];
  private readonly targets = new Map<string, string>();
  private readonly files: { ctx: LevelCtx; chunks: Chunk[] }[] = [];
  private order = 0;
  private todo = false;

  constructor(
    private readonly doc: FlowDocument,
    private readonly opts: GenerateOptions,
  ) {
    this.model = buildModel(doc);
  }

  run(): GenerateResult {
    const root = this.model.levels.get(ROOT);
    const start = this.startPattern();
    if (!root || !start) return this.result(false);
    const ctx: LevelCtx = { level: root, path: [], file: `${this.doc.flow.key}.yml`, entry: start };
    if (!this.level(ctx)) return this.result(false);
    const outcome = this.outcomePlay();
    if (outcome) this.files[0]?.chunks.push({ lines: outcome });
    return this.result(true);
  }

  // ---- inputs and routing -------------------------------------------------------------------

  /** The flow input that seeds start (decision 23): `targets: true`, else the first host_list. */
  private startPattern(): string | undefined {
    const inputs = Object.entries(this.doc.flow?.inputs ?? {});
    const hostLists = inputs.filter(([, f]) => f?.type === 'host_list');
    const chosen = hostLists.find(([, f]) => f.targets) ?? hostLists[0];
    if (!chosen) {
      this.finding('codegen-no-targets', 'error', 'The flow needs a host_list input to target', [
        'flow',
        'inputs',
      ]);
      return undefined;
    }
    return `{{ ${chosen[0]} | join(',') }}`;
  }

  private group(path: string[], key: string, port: string): string {
    return `flow_${[...path, key].map(groupPart).join('__')}_${groupPart(port)}`;
  }

  /**
   * Group a node's output port routes into: its own group when wired (or open), the parent's port
   * group when the port leaves a subflow level through its boundary or bubbles up (ADR-0004).
   * An open fail port is recorded for the outcome play.
   */
  private target(ctx: LevelCtx, node: FlowNode, port: string): string {
    const memo = `${node.id}|${port}`;
    const known = this.targets.get(memo);
    if (known) return known;
    const own = this.group(ctx.path, node.key, port);
    let target = own;
    const wired = ctx.level.edges.some((e) => e?.from?.node === node.id && e.from.port === port);
    const parent = ctx.parent;
    if (!wired && parent) {
      const exported = Object.entries(parent.node.subflow?.boundary?.outputs ?? {}).find(
        ([, refs]) => (refs ?? []).some((r) => r?.node === node.id && r.port === port),
      );
      if (exported) target = this.target(parent.ctx, parent.node, exported[0]);
      else if (isFailPort(port) && portsFor(parent.node).some((p) => p.name === port))
        target = this.target(parent.ctx, parent.node, port);
    }
    if (target === own) {
      this.routes[own] = { node: node.id, port };
      if (!wired && isFailPort(port)) this.openPort(node, port, own);
    }
    this.targets.set(memo, target);
    return target;
  }

  private openPort(node: FlowNode, port: string, group: string): void {
    const decision = (this.doc.decisions ?? []).find(
      (d) => d?.node === node.id && d.port === port && d.kind === 'open_on_purpose',
    );
    const where = `[${node.key}] ${node.title}`;
    this.outcome.push({
      order: this.order,
      groups: [group],
      name: decision ? `[${node.key}] ${port} open on purpose` : `[${node.key}] ${port} is open`,
      msg: decision
        ? `Stopped at ${where}: ${port} open on purpose (${oneLine(decision.reason ?? 'no reason')})`
        : `Stopped at ${where}: ${port} is not wired`,
    });
  }

  private sources(ctx: LevelCtx, node: FlowNode, edges: Edge[]): string[] {
    const out: string[] = [];
    for (const e of edges) {
      if (e.to.node !== node.id || e.to.port !== 'in') continue;
      const from = this.model.nodes.get(e.from.node)?.node;
      if (!from) continue;
      out.push(from.type === 'start' ? ctx.entry : this.target(ctx, from, e.from.port));
    }
    if (ctx.parent && ctx.parent.node.subflow?.boundary?.in === node.id) out.push(ctx.entry);
    return [...new Set(out)];
  }

  // ---- levels ----------------------------------------------------------------------------------

  private level(ctx: LevelCtx): boolean {
    const nodes = ctx.level.nodes.filter((n): n is FlowNode => !!n && typeof n === 'object');
    const ids = new Set(nodes.map((n) => n.id));
    const edges = ctx.level.edges.filter(
      (e): e is Edge => !!e?.from && !!e.to && ids.has(e.from.node) && ids.has(e.to.node),
    );
    const order = topoOrder(nodes, edges);
    if (!order) {
      const where = ctx.parent ? `level [${ctx.parent.node.key}]` : 'top level';
      this.finding('codegen-cycle', 'error', `The ${where} has a cycle; plays need an order`, []);
      return false;
    }
    const file = { ctx, chunks: [] as Chunk[] };
    this.files.push(file);
    for (const node of order) {
      this.order++;
      if (node.type === 'start') continue;
      if (node.type === 'end') {
        this.endNode(ctx, node, edges);
        continue;
      }
      const hosts = this.sources(ctx, node, edges);
      if (hosts.length === 0) {
        this.finding(
          'codegen-no-input',
          'warning',
          `Nothing leads to "${node.title}": no play is generated for it`,
          this.model.nodes.get(node.id)?.path ?? [],
          node.id,
        );
        continue;
      }
      if (node.type === 'subflow' && (node.subflow?.nodes?.length ?? 0) > 0) {
        if (!this.subflowLevel(ctx, node, hosts, file.chunks)) return false;
        continue;
      }
      const play = this.play(ctx, node, hosts, edges);
      file.chunks.push({ node: node.id, lines: writeBlock([play], 0) });
    }
    return true;
  }

  private subflowLevel(ctx: LevelCtx, node: FlowNode, hosts: string[], chunks: Chunk[]): boolean {
    const level = this.model.levels.get(node.id);
    if (!level) return true;
    const path = [...ctx.path, node.key];
    const file = `${this.doc.flow.key}.${path.join('.')}.yml`;
    chunks.push({
      node: node.id,
      lines: [
        `# [${node.key}] ${oneLine(node.title)}: subflow level, see ${file}`,
        ...writeBlock([{ import_playbook: file, tags: flow([`node_${node.id}`]) }], 0),
      ],
    });
    // Ports of the subflow node itself: wired ones feed this level, open ones reach the outcome.
    for (const p of portsFor(node)) if (p.direction === 'out') this.target(ctx, node, p.name);
    return this.level({ level, path, file, entry: hosts.join(':'), parent: { node, ctx } });
  }

  private endNode(ctx: LevelCtx, node: FlowNode, edges: Edge[]): void {
    const groups = edges
      .filter((e) => e.to.node === node.id)
      .map((e) => {
        const from = this.model.nodes.get(e.from.node)?.node;
        return from && from.type !== 'start' ? this.target(ctx, from, e.from.port) : undefined;
      })
      .filter((g): g is string => !!g);
    if (node.outcome !== 'failed' || groups.length === 0) return;
    this.outcome.push({
      order: this.order,
      groups: [...new Set(groups)],
      name: `[${node.key}] ${oneLine(node.title)}`,
      msg: `Ended at [${node.key}] ${oneLine(node.title)} (outcome: failed)`,
    });
  }

  // ---- plays -----------------------------------------------------------------------------------

  private play(ctx: LevelCtx, node: FlowNode, hosts: string[], edges: Edge[]): OutMap {
    const tag = `node_${node.id}`;
    const vars: OutMap = { flow_node_id: node.id };
    if (this.opts.simulate) {
      const key = [...ctx.path, node.key].join('/');
      vars.afd_sim = `{{ (afd_simulate | default({}))['${key}'] | default({}) }}`;
    }
    const settings = node.settings ?? {};
    let tasks: Out[];
    switch (node.type) {
      case 'decision':
        tasks = this.decisionTasks(ctx, node);
        break;
      case 'approval':
        tasks = this.approvalTasks(ctx, node);
        break;
      case 'parallel':
        tasks = legalPorts(node)
          .filter((p) => p.enabled && p.name.startsWith('branch_'))
          .map((p) => route(node, p.name, this.target(ctx, node, p.name)));
        break;
      case 'join':
        tasks = this.joinTasks(ctx, node, edges);
        break;
      default:
        tasks = this.taskTasks(ctx, node, tag);
    }
    return {
      name: `[${node.key}] ${oneLine(node.title)}`,
      hosts: hosts.join(':'),
      gather_facts: false,
      serial: settings.serial,
      become: settings.become ? true : undefined,
      tags: flow([tag, ...(settings.tags ?? [])]),
      vars,
      tasks,
    };
  }

  private taskTasks(ctx: LevelCtx, node: FlowNode, tag: string): Out[] {
    const enabled = new Set(portsFor(node).map((p) => p.name));
    const impl = node.impl?.ref ? node.impl : undefined;
    const kind = impl?.kind === 'module' || impl?.kind === 'role' ? impl.kind : 'todo';
    if (impl?.kind === 'playbook') {
      this.finding(
        'codegen-playbook-binding',
        'warning',
        `"${node.title}" is bound to a playbook, which cannot route host sets yet: it runs as a TODO until M5`,
        this.model.nodes.get(node.id)?.path ?? [],
        node.id,
      );
    }
    const sim = this.opts.simulate && kind === 'todo';
    const timeout = durationSeconds(node.settings?.timeout);
    const reg = impl?.register ?? `${groupPart(node.key)}_result`;
    const on = (port: string) => this.target(ctx, node, port);

    let body: OutMap;
    if (kind === 'module' && impl) {
      const retries = node.settings?.retries;
      body = {
        name: `[${node.key}] ${oneLine(node.title)}`,
        [impl.ref]: (impl.params ?? {}) as Out,
        register: reg,
        ignore_unreachable: true,
        timeout,
        retries,
        until: retries ? `${reg} is succeeded` : undefined,
      };
    } else if (kind === 'role' && impl) {
      const options: OutMap = { name: impl.ref };
      const roleVars: OutMap = {};
      for (const [k, v] of Object.entries(impl.params ?? {}))
        (INCLUDE_OPTIONS.has(k) ? options : roleVars)[k] = v as Out;
      options.apply = { tags: flow([tag]), timeout };
      body = {
        name: `[${node.key}] Apply role`,
        'ansible.builtin.include_role': options,
        vars: Object.keys(roleVars).length > 0 ? roleVars : undefined,
      };
    } else {
      this.todo = true;
      const failing = ['failed', ...(enabled.has('timeout') ? ['timeout'] : [])];
      body = {
        name: `[${node.key}] TODO`,
        'ansible.builtin.debug': { msg: `TODO: ${oneLine(node.intent || node.title)}` },
        failed_when: sim
          ? `inventory_hostname in ${failing.map((p) => `afd_sim.${p} | default([])`).join(' + ')}`
          : undefined,
      };
    }

    // ok_hosts, refined by unchanged (module results or simulation) and unreachable (module
    // results ignore unreachable so the host stays routable, ADR-0009).
    const okChoices: Choice[] = [];
    if (kind === 'module') {
      const group = enabled.has('unreachable')
        ? on('unreachable')
        : this.unreachableNotEnabled(ctx, node);
      okChoices.push({ test: `(${reg}.unreachable | default(false))`, group, port: 'unreachable' });
      if (enabled.has('unchanged'))
        okChoices.push({ test: `not ${reg}.changed`, group: on('unchanged'), port: 'unchanged' });
    } else if (sim) {
      for (const port of ['unreachable', 'unchanged'])
        if (enabled.has(port)) okChoices.push({ test: simIn(port), group: on(port), port });
    }
    const okRoute = choose(node, okChoices, { group: on('ok_hosts'), port: 'ok_hosts' });

    const failChoices: Choice[] = [];
    if (enabled.has('timeout')) {
      const test = sim ? simIn('timeout') : '(ansible_failed_result.timedout | default(false))';
      failChoices.push({ test, group: on('timeout'), port: 'timeout' });
    }
    const rescue: Out[] = [
      ...['failed_hosts', ...failChoices.map((c) => c.port)].flatMap((p) =>
        this.portComment(ctx, node, p),
      ),
      choose(node, failChoices, { group: on('failed_hosts'), port: 'failed_hosts' }),
    ];
    const block: OutMap = { block: [body, okRoute], rescue };
    if (enabled.has('always')) block.always = [route(node, 'always', on('always'))];
    const tasks: Out[] = [block];

    const limit = node.settings?.max_fail_percentage;
    if (typeof limit === 'number') {
      const groups = [
        on('failed_hosts'),
        ...okChoices.filter((c) => c.port === 'unreachable').map((c) => c.group),
        ...failChoices.map((c) => c.group),
      ];
      const count = groups.map((g) => `groups['${g}'] | default([]) | length`).join(' + ');
      tasks.push({
        name: `[${node.key}] max_fail_percentage ${limit} exceeded`,
        'ansible.builtin.fail': {
          msg: `Flow stopped at [${node.key}]: {{ ${count} }} of {{ ansible_play_hosts_all | length }} hosts failed`,
        },
        when: `(${count}) * 100 > ${limit} * (ansible_play_hosts_all | length)`,
      });
    }
    return tasks;
  }

  /**
   * Module hosts that turn unreachable on a node without the port: they bubble to an enclosing
   * subflow's `unreachable` when it has one, else they fail in the outcome play.
   */
  private unreachableNotEnabled(ctx: LevelCtx, node: FlowNode): string {
    const parent = ctx.parent;
    if (parent && portsFor(parent.node).some((p) => p.name === 'unreachable'))
      return this.target(parent.ctx, parent.node, 'unreachable');
    const group = this.group(ctx.path, node.key, 'unreachable');
    if (!this.routes[group]) {
      this.routes[group] = { node: node.id, port: 'unreachable' };
      this.outcome.push({
        order: this.order,
        groups: [group],
        name: `[${node.key}] unreachable`,
        msg: `Stopped at [${node.key}] ${oneLine(node.title)}: host unreachable (the unreachable port is not enabled)`,
      });
    }
    return group;
  }

  /** Comment in the rescue saying where an open, decided or bubbling fail port leads. */
  private portComment(ctx: LevelCtx, node: FlowNode, port: string): Out[] {
    const target = this.target(ctx, node, port);
    const own = this.group(ctx.path, node.key, port);
    if (target !== own) {
      const r = this.routes[target];
      const owner = r ? this.model.nodes.get(r.node)?.node : undefined;
      return owner ? [comment(`${port} leaves this level as [${owner.key}] ${r?.port}`)] : [];
    }
    if (ctx.level.edges.some((e) => e?.from?.node === node.id && e.from.port === port)) return [];
    const decided = (this.doc.decisions ?? []).some(
      (d) => d?.node === node.id && d.port === port && d.kind === 'open_on_purpose',
    );
    return [
      comment(
        decided
          ? `${port} is open on purpose: these hosts stop in the outcome play`
          : `${port} is open: these hosts fail in the outcome play`,
      ),
    ];
  }

  private decisionTasks(ctx: LevelCtx, node: FlowNode): Out[] {
    const yes = this.target(ctx, node, 'true');
    const no = this.target(ctx, node, 'false');
    const condition = node.condition?.trim();
    if (!condition) {
      this.todo = true;
      const choices = this.opts.simulate
        ? [{ test: simIn('false'), group: no, port: 'false' }]
        : [];
      const pick = choose(node, choices, { group: yes, port: 'true' });
      return [
        {
          name: `[${node.key}] TODO`,
          'ansible.builtin.debug': {
            msg: `TODO: ${oneLine(node.title)} has no condition yet, so every host takes true`,
          },
        },
        pick,
      ];
    }
    const error = this.group(ctx.path, node.key, 'condition_error');
    this.routes[error] = { node: node.id, port: 'condition_error' };
    this.outcome.push({
      order: this.order,
      groups: [error],
      name: `[${node.key}] condition error`,
      msg: `Stopped at [${node.key}] ${oneLine(node.title)}: the condition could not be evaluated`,
    });
    return [
      {
        block: [
          choose(node, [{ test: `not (${oneLine(condition)})`, group: no, port: 'false' }], {
            group: yes,
            port: 'true',
          }),
        ],
        rescue: [
          {
            name: `[${node.key}] condition could not be evaluated`,
            'ansible.builtin.group_by': { key: error },
          },
        ],
      },
    ];
  }

  private approvalTasks(ctx: LevelCtx, node: FlowNode): Out[] {
    this.todo = true;
    const enabled = new Set(portsFor(node).map((p) => p.name));
    const choices: Choice[] = [];
    if (this.opts.simulate) {
      for (const port of ['rejected', 'timeout'])
        if (enabled.has(port))
          choices.push({ test: simIn(port), group: this.target(ctx, node, port), port });
    }
    return [
      {
        name: `[${node.key}] TODO approval`,
        'ansible.builtin.debug': {
          msg: `TODO: ${oneLine(node.title)} is approved automatically in local runs (AWX approval node in M7)`,
        },
        run_once: true,
      },
      choose(node, choices, { group: this.target(ctx, node, 'approved'), port: 'approved' }),
    ];
  }

  private joinTasks(ctx: LevelCtx, node: FlowNode, edges: Edge[]): Out[] {
    const ok = this.target(ctx, node, 'ok_hosts');
    if (node.join_mode === 'any') return [route(node, 'ok_hosts', ok)];
    const member: string[] = [];
    for (const e of edges) {
      const from = e.to.node === node.id ? this.model.nodes.get(e.from.node)?.node : undefined;
      if (from && from.type !== 'start')
        member.push(
          `inventory_hostname in groups['${this.target(ctx, from, e.from.port)}'] | default([])`,
        );
    }
    const all = member.join(' and ') || 'true';
    if (portsFor(node).some((p) => p.name === 'failed_hosts')) {
      const failed = this.target(ctx, node, 'failed_hosts');
      return [
        choose(node, [{ test: `not (${all})`, group: failed, port: 'failed_hosts' }], {
          group: ok,
          port: 'ok_hosts',
        }),
      ];
    }
    return [{ ...route(node, 'ok_hosts', ok), when: all }];
  }

  // ---- outcome and files -------------------------------------------------------------------------

  private outcomePlay(): string[] | undefined {
    if (this.outcome.length === 0) return undefined;
    const entries = [...this.outcome].sort((a, b) => a.order - b.order);
    const groups = [...new Set(entries.flatMap((e) => e.groups))];
    const play: OutMap = {
      name: `[${this.doc.flow.key}] Outcome`,
      hosts: groups.join(':'),
      gather_facts: false,
      tags: flow([`flow_${this.doc.flow.id}`]),
      tasks: entries.map((e) => ({
        name: e.name,
        'ansible.builtin.fail': { msg: e.msg },
        when: e.groups
          .map((g) => `inventory_hostname in groups['${g}'] | default([])`)
          .join(' or '),
      })),
    };
    return [
      '# Hosts left on open ports or failed end nodes fail here, after every branch ran (ADR-0009).',
      ...writeBlock([play], 0),
    ];
  }

  private result(ok: boolean): GenerateResult {
    const eol = this.opts.eol ?? '\n';
    const files: GeneratedFile[] = [];
    const plays: Record<Ulid, PlayRange> = {};
    if (ok) {
      for (const { ctx, chunks } of this.files) {
        const header = this.header(ctx);
        const body: string[] = [];
        for (const chunk of chunks) {
          body.push('');
          const start = header.length + 1 + body.length;
          body.push(...chunk.lines);
          if (chunk.node)
            plays[chunk.node] = { file: ctx.file, start, end: start + chunk.lines.length };
        }
        const bodyText = body.map((l) => `${l}\n`).join('');
        const lines = [...header, `${CHECKSUM_PREFIX}${checksum(bodyText)}`, ...body];
        files.push({ name: ctx.file, text: lines.join(eol) + eol, level: ctx.level.id });
      }
    }
    return { ok, files, findings: this.findings, routes: this.routes, plays };
  }

  private header(ctx: LevelCtx): string[] {
    const f = this.doc.flow;
    const level = ctx.parent
      ? `, level [${ctx.parent.node.key}] ${oneLine(ctx.parent.node.title)}`
      : '';
    const lines = [
      `# GENERATED by Ansible Flow Designer from ../${this.opts.source} (flow ${f.key}, version ${f.version}${level}).`,
      '# Do not edit by hand: change the flow and save it. Option A engine (ADR-0009).',
    ];
    if (!ctx.parent && this.todo)
      lines.push('# Unbound nodes run TODO messages: run with --check until every node is bound.');
    if (this.opts.simulate)
      lines.push('# SIMULATION build: afd_simulate sends chosen hosts down other ports.');
    return lines;
  }

  private finding(
    code: string,
    severity: Finding['severity'],
    message: string,
    path: Finding['path'],
    node?: Ulid,
  ): void {
    this.findings.push({ code, severity, message, path, node });
  }
}

/** Kahn's algorithm; ties keep document order. Undefined when the level has a cycle. */
function topoOrder(nodes: FlowNode[], edges: Edge[]): FlowNode[] | undefined {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indegree.set(e.to.node, (indegree.get(e.to.node) ?? 0) + 1);
  const ready = nodes.filter((n) => indegree.get(n.id) === 0);
  const out: FlowNode[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
    const n = ready.shift() as FlowNode;
    out.push(n);
    for (const e of edges) {
      if (e.from.node !== n.id) continue;
      const left = (indegree.get(e.to.node) ?? 0) - 1;
      indegree.set(e.to.node, left);
      if (left === 0) ready.push(nodes[index.get(e.to.node) ?? 0] as FlowNode);
    }
  }
  return out.length === nodes.length ? out : undefined;
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function simIn(port: string): string {
  return `inventory_hostname in afd_sim.${port} | default([])`;
}

interface Choice {
  test: string;
  group: string;
  port: string;
}

function route(node: FlowNode, port: string, group: string): OutMap {
  return { name: `[${node.key}] route ${port}`, 'ansible.builtin.group_by': { key: group } };
}

/** A group_by whose key picks the first matching choice, else the fallback port's group. */
function choose(
  node: FlowNode,
  choices: Choice[],
  fallback: { group: string; port: string },
): OutMap {
  if (choices.length === 0) return route(node, fallback.port, fallback.group);
  const expr = choices.reduceRight(
    (rest, c) => `'${c.group}' if ${c.test} else ${rest}`,
    `'${fallback.group}'`,
  );
  const ports = [fallback.port, ...choices.map((c) => c.port)];
  return {
    name: `[${node.key}] route ${[...new Set(ports)].join(', ')}`,
    'ansible.builtin.group_by': { key: `{{ ${expr} }}` },
  };
}

export const optionA: Engine = {
  id: 'option-a',
  generate: (doc, options) => new Generator(doc, options).run(),
};
