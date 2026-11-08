// Option A code generation (handoff 05, ADR-0003, ADR-0009): one playbook per flow level, one play
// per node, host sets routed between plays with group_by, and a final outcome play that fails the
// hosts left on open ports or failed end nodes (no host ever fails inside a node play).
import {
  bubbles,
  type LevelTaken,
  levelTaken,
  portKey,
  unreachableBubbles,
} from '../flow/bubbling';
import {
  capturedOutputs,
  captureTaskName,
  groupPart,
  outputVar,
  registerName,
} from '../flow/dataNames';
import { portAccepted } from '../flow/decisions';
import { privilegeOf } from '../flow/inherit';
import { conditionExpr } from '../flow/jinja';
import { buildModel, type FlowModel, type Level, ROOT } from '../flow/model';
import { isFailPort, legalPorts, portsFor } from '../flow/ports';
import { rollingObstacles } from '../flow/rolling';
import { planSegments, type Segment } from '../flow/segments';
import type { Edge, FlowDocument, FlowNode, Ulid } from '../flow/types';
import type { Finding } from '../flow/validate';
import { plainText } from '../view/markdown';
import { bindingTask, inputVars, stubFacts } from './binding';
import { effectiveTargets } from './targets';
import type {
  Engine,
  GeneratedFile,
  GenerateOptions,
  GenerateResult,
  HostTerm,
  PlanStep,
  PlayRange,
  Route,
  RunPlan,
  SegmentFile,
} from './types';
import { checksum, jinjaLiteral, timeoutValue } from './util';
import {
  Comment,
  comment,
  commentLine,
  flow,
  type Out,
  type OutMap,
  oneLine,
  writeBlock,
} from './yamlWriter';

export const CHECKSUM_PREFIX = '# Checksum: ';

interface LevelCtx {
  level: Level;
  /** Keys of the enclosing subflow nodes, outermost first. */
  path: string[];
  file: string;
  /** Host pattern of a start node (root) or of the subflow's entry (inner levels). */
  entry: string;
  parent?: { node: FlowNode; ctx: LevelCtx };
}

/** Every line break YAML (1.1 and 1.2) knows: a Note's text is split on all of them (AFD-66). */
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/;

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

/** A segment build: the segment and the whole flow's outcome (failed only in leaf segments). */
interface SegmentRun {
  seg: Segment;
  outcome: OutcomeEntry[];
}

class Generator {
  private readonly model: FlowModel;
  private readonly findings: Finding[] = [];
  private readonly routes: Record<string, Route> = {};
  private readonly outcome: OutcomeEntry[] = [];
  private readonly targets = new Map<string, string>();
  private readonly takenOf = new Map<Level, LevelTaken>();
  private readonly files: { ctx: LevelCtx; chunks: Chunk[] }[] = [];
  private order = 0;
  private todo = false;
  /** Approvals a local run passes unless afd_approvals says otherwise (AFD-21). */
  private approvals: string[] = [];
  /** Work nodes that run on an inventory_target (AFD-14). */
  private readonly overrides: Map<Ulid, string>;
  /** AFD-114: the plays of a scenario build, as the simulator runs them. */
  private readonly steps: PlanStep[] = [];
  private startInput?: string;
  /** The rolling subflow whose play the steps are blocks of (AFD-55): events land on it. */
  private rollingSub?: Ulid;

  constructor(
    private readonly doc: FlowDocument,
    private readonly opts: GenerateOptions,
    private readonly segment?: SegmentRun,
  ) {
    this.model = buildModel(doc);
    this.overrides = effectiveTargets(this.model);
  }

  /** become and become_user for a node's play (AFD-52: inherited from subflows in format 2). */
  private privilege(node: FlowNode): { become?: true; become_user?: string } {
    const p = privilegeOf(this.model, node);
    return {
      ...(p.become ? { become: true as const } : {}),
      ...(p.become_user ? { become_user: p.become_user } : {}),
    };
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

  /** What the outcome play of the whole flow fails (segment builds reuse it). */
  outcomeEntries(): OutcomeEntry[] {
    return [...this.outcome];
  }

  // ---- AWX segments (AFD-11, ADR-0016) ---------------------------------------------------------

  /**
   * One segment's root playbook: restore the carried host sets (continuations), the segment's top-
   * level plays (subflow levels are the shared level files), then either carry the hosts waiting
   * at the gate and those bound for the outcome to the next segment, or, in a leaf, the outcome.
   */
  segmentRun(): GenerateResult {
    const { seg, outcome } = this.segment as SegmentRun;
    const root = this.model.levels.get(ROOT);
    const start = this.startPattern();
    if (!root || !start) return this.result(false);
    const ctx: LevelCtx = {
      level: root,
      path: [],
      file: `${this.doc.flow.key}.seg_${seg.name}.yml`,
      entry: start,
    };
    if (seg.finish) this.files.push({ ctx, chunks: [] });
    else if (!this.level(ctx)) return this.result(false);
    const chunks = this.files[0]?.chunks ?? [];
    chunks.unshift(...this.prelude(ctx, seg));
    // Segments never fail hosts themselves: the whole flow's outcome runs in the leaves.
    this.outcome.length = 0;
    this.outcome.push(...outcome);
    if (seg.gate) chunks.push({ lines: writeBlock([this.carry(seg.gate)], 0) });
    else {
      const play = this.outcomePlay();
      if (play) chunks.push({ lines: play });
    }
    return this.result(true);
  }

  private prelude(ctx: LevelCtx, seg: Segment): Chunk[] {
    if (!seg.entry && !seg.finish) return [];
    const tag = flow([`flow_${this.doc.flow.id}`]);
    const out: Chunk[] = [
      {
        lines: writeBlock(
          [
            {
              name: `[${this.doc.flow.key}] Segment ${seg.name}: restore host sets`,
              hosts: 'localhost',
              gather_facts: false,
              tags: tag,
              tasks: [
                {
                  name: 'restore the host sets the previous segment carried',
                  'ansible.builtin.add_host': { name: '{{ item.1 }}', groups: '{{ item.0.key }}' },
                  loop: "{{ (afd_hostsets | default({})) | dict2items | subelements('value') }}",
                  loop_control: { label: '{{ item.0.key }}: {{ item.1 }}' },
                },
                ...(seg.finish
                  ? [
                      {
                        name: 'only after an approval no host reached',
                        'ansible.builtin.fail': {
                          msg: 'A segment before this one did not finish: see its AWX job',
                        },
                        when: 'not (afd_gate_empty | default(false) | bool)',
                      },
                    ]
                  : []),
              ],
            },
          ],
          0,
        ),
      },
    ];
    const gate = seg.entry ? this.model.nodes.get(seg.entry.approval)?.node : undefined;
    if (gate && seg.entry) {
      const port = seg.entry.outcome;
      const waiting = this.group([], gate.key, 'waiting');
      out.push({
        node: gate.id,
        lines: writeBlock(
          [
            {
              // The route suffix maps AWX events back to the approval node.
              name: `[${gate.key}] ${jinjaLiteral(oneLine(gate.title))}: route`,
              hosts: `{{ groups['${waiting}'] | default([]) | join(',') or 'afd_no_hosts' }}`,
              gather_facts: false,
              tags: flow([`node_${gate.id}`]),
              vars: { flow_node_id: gate.id },
              tasks: [route(gate, port, this.target(ctx, gate, port))],
            },
          ],
          0,
        ),
      });
    }
    return out;
  }

  /** set_stats for the next segment, then stop this job when nobody waits at the gate. */
  private carry(gateId: Ulid): OutMap {
    const gate = this.model.nodes.get(gateId)?.node as FlowNode;
    const waiting = this.group([], gate.key, 'waiting');
    const groups = [...new Set([...this.outcome.flatMap((e) => e.groups), waiting])];
    const empty = `groups['${waiting}'] | default([]) | length == 0`;
    return {
      name: `[${this.doc.flow.key}] Segment ${this.segment?.seg.name}: carry host sets`,
      hosts: 'localhost',
      gather_facts: false,
      tags: flow([`flow_${this.doc.flow.id}`]),
      tasks: [
        {
          name: 'carry the hosts waiting for approval and those bound for the outcome',
          'ansible.builtin.set_stats': {
            data: {
              afd_hostsets: Object.fromEntries(
                groups.map((g) => [g, `{{ groups['${g}'] | default([]) }}`]),
              ),
              afd_gate_empty: `{{ ${empty} }}`,
            },
            per_host: false,
            aggregate: false,
          },
        },
        {
          name: `[${gate.key}] no host reached ${jinjaLiteral(oneLine(gate.title))}`,
          'ansible.builtin.fail': {
            msg: `No host reached [${gate.key}] ${jinjaLiteral(oneLine(gate.title))}: the approval is skipped and the flow finishes`,
          },
          when: empty,
        },
      ],
    };
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
    // A list from the run inputs, or the comma-separated text an AWX survey answers (AFD-59).
    const name = chosen[0];
    this.startInput = name;
    return `{{ ${name} if ${name} is string else ${name} | join(',') }}`;
  }

  /** What takes the ports of the level's steps, once per level. */
  private taken(ctx: LevelCtx): LevelTaken {
    let taken = this.takenOf.get(ctx.level);
    if (!taken) {
      taken = levelTaken(ctx.level.edges, ctx.parent?.node);
      this.takenOf.set(ctx.level, taken);
    }
    return taken;
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
    const taken = this.taken(ctx);
    const wired = taken.wired.has(portKey(node.id, port));
    const parent = ctx.parent;
    if (!wired && parent) {
      const exported = Object.entries(parent.node.subflow?.boundary?.outputs ?? {}).find(
        ([, refs]) => (refs ?? []).some((r) => r?.node === node.id && r.port === port),
      );
      if (exported) target = this.target(parent.ctx, parent.node, exported[0]);
      else if (bubbles(parent.node, node.id, port, taken))
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
    const decision = portAccepted(this.doc, node.id, port);
    const where = `[${node.key}] ${jinjaLiteral(oneLine(node.title))}`;
    this.outcome.push({
      order: this.order,
      groups: [group],
      name: decision ? `[${node.key}] ${port} open on purpose` : `[${node.key}] ${port} is open`,
      msg: decision
        ? `Stopped at ${where}: ${port} open on purpose (${jinjaLiteral(oneLine(decision.reason ?? 'no reason'))})`
        : `Stopped at ${where}: ${port} is not wired`,
    });
  }

  private sources(ctx: LevelCtx, node: FlowNode, edges: Edge[]): string[] {
    const out: string[] = [];
    for (const e of edges) {
      if (e.to.node !== node.id || e.to.port !== 'in') continue;
      const from = this.model.nodes.get(e.from.node)?.node;
      if (!from) continue;
      // A continuation segment starts at its approval, not at the flow targets.
      if (from.type === 'start' && this.segment?.seg.entry && !ctx.parent) continue;
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
      if (this.segment && !ctx.parent && !this.segment.seg.nodes.has(node.id)) continue;
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
      // Its own target or an enclosing subflow's; decisions, approvals, parallels and joins
      // always run on the arriving hosts.
      const over = this.overrides.get(node.id);
      if (over) {
        // A blank line between the node's plays; a comment stays with the play it describes.
        const plays = this.overridePlays(ctx, node, hosts, over);
        file.chunks.push({
          node: node.id,
          lines: plays.flatMap((p, i) => [
            ...(i > 0 && !(plays[i - 1] instanceof Comment) ? [''] : []),
            ...writeBlock([p], 0),
          ]),
        });
        continue;
      }
      if (node.impl?.kind === 'playbook' && node.impl.ref && !this.opts.stubAll) {
        file.chunks.push({ node: node.id, lines: this.playbookNode(ctx, node, hosts) });
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
        commentLine(`[${node.key}] ${oneLine(node.title)}: subflow level, see ${file}`),
        ...writeBlock([{ import_playbook: file, tags: flow([`node_${node.id}`]) }], 0),
      ],
    });
    // Ports of the subflow node itself: wired ones feed this level, open ones reach the outcome.
    for (const p of portsFor(node)) if (p.direction === 'out') this.target(ctx, node, p.name);
    // A segment imports the level file the whole-flow build writes.
    if (this.segment) return true;
    const inner: LevelCtx = { level, path, file, entry: hosts.join(':'), parent: { node, ctx } };
    const rolling = node.settings?.rolling;
    if (rolling === undefined) return this.level(inner);
    const obstacles = rollingObstacles(this.model, node).map((o) => `${o.node.title}: ${o.why}`);
    for (const n of level.nodes)
      if (n && this.overrides.has(n.id) && !obstacles.some((o) => o.startsWith(`${n.title}:`)))
        obstacles.push(`${n.title}: it runs on an inventory_target, in plays of its own`);
    if (obstacles.length === 0) return this.rollingLevel(inner, rolling);
    this.finding(
      'rolling-unsupported',
      'error',
      `"${node.title}" cannot roll (${obstacles.join('; ')}): its steps run play by play`,
      this.model.nodes.get(node.id)?.path ?? [],
      node.id,
    );
    return this.level(inner);
  }

  /**
   * A rolling subflow's level (AFD-55): one play with `serial`, so each batch of hosts goes through
   * every step before the next batch starts. Each step is a block for the hosts that arrived at it
   * (its routing groups, as the play-per-step level uses), with the vars, tags and privilege its
   * own play would have; its routing, rescue and captures are the same tasks.
   */
  private rollingLevel(ctx: LevelCtx, batch: string | number): boolean {
    const sub = ctx.parent?.node as FlowNode;
    const nodes = ctx.level.nodes.filter((n): n is FlowNode => !!n && typeof n === 'object');
    const ids = new Set(nodes.map((n) => n.id));
    const edges = ctx.level.edges.filter(
      (e): e is Edge => !!e?.from && !!e.to && ids.has(e.from.node) && ids.has(e.to.node),
    );
    const order = topoOrder(nodes, edges);
    if (!order) {
      this.finding(
        'codegen-cycle',
        'error',
        `The level [${sub.key}] has a cycle; plays need an order`,
        [],
      );
      return false;
    }
    const blocks: Out[] = [];
    this.rollingSub = sub.id;
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
      const play = this.play(ctx, node, hosts, edges);
      for (const t of this.noteLines(node.id)) blocks.push(comment(t));
      // Every host of the play enters at the entry; the others arrive through their groups.
      const groups = hosts.filter((h) => h !== ctx.entry);
      blocks.push({
        name: play.name,
        block: play.tasks,
        vars: play.vars,
        become: play.become,
        become_user: play.become_user,
        tags: play.tags,
        when: hosts.includes(ctx.entry)
          ? undefined
          : `inventory_hostname in (${groups.map((g) => `groups['${g}'] | default([])`).join(' + ')})`,
      });
    }
    this.rollingSub = undefined;
    this.files.push({
      ctx,
      chunks: [
        {
          node: sub.id,
          lines: writeBlock(
            [
              {
                name: `[${sub.key}] ${jinjaLiteral(oneLine(sub.title))}: rolling, ${batch} at a time`,
                hosts: ctx.entry,
                gather_facts: false,
                serial: batch,
                tags: flow([`node_${sub.id}`]),
                vars: { flow_node_id: sub.id },
                tasks: blocks,
              },
            ],
            0,
          ),
        },
      ],
    });
    return true;
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
      name: `[${node.key}] ${jinjaLiteral(oneLine(node.title))}`,
      msg: `Ended at [${node.key}] ${jinjaLiteral(oneLine(node.title))} (outcome: failed)`,
    });
  }

  // ---- inventory_target (AFD-14) -------------------------------------------------------------

  /**
   * A node that runs on its inventory_target (AFD-14): the arriving hosts are marked, the binding
   * runs once on the target, and the arriving hosts leave together. They take ok_hosts when every
   * target host finished (or the failed share stays within max_fail_percentage), else failed_hosts
   * (timeout when a target host timed out and the port is enabled). A target that matches no host
   * fails them too: the work never ran.
   */
  private overridePlays(ctx: LevelCtx, node: FlowNode, hosts: string[], target: string): Out[] {
    const tag = `node_${node.id}`;
    // AFD-145: a play name is rendered too; Ansible stops the whole run on an undefined name.
    const title = `[${node.key}] ${jinjaLiteral(oneLine(node.title))}`;
    const settings = node.settings ?? {};
    const own = (part: string) => this.group(ctx.path, node.key, part);
    const arrived = own('arriving');
    const done = own('target_done');
    const timedOut = own('target_timeout');
    const failedOnTarget = own('target_failed');
    const enabled = new Set(portsFor(node).map((p) => p.name));
    const path = this.model.nodes.get(node.id)?.path ?? [];
    const impl = node.impl?.ref ? node.impl : undefined;
    const kind = this.opts.stubAll ? 'todo' : (impl?.kind ?? 'todo');
    const sim = this.opts.simulate && kind === 'todo';
    for (const p of portsFor(node)) if (p.direction === 'out') this.target(ctx, node, p.name);
    const never = ['unreachable', 'unchanged'].filter((p) => enabled.has(p));
    if (kind === 'playbook' && enabled.has('timeout')) never.push('timeout');
    if (never.length > 0)
      this.finding(
        'codegen-target-ports',
        'warning',
        `"${node.title}" runs on its inventory_target (${target}): arriving hosts never take ${never.join(', ')}`,
        path,
        node.id,
      );
    const timeoutPort = enabled.has('timeout') && kind !== 'playbook';
    const arriving = `{{ groups['${arrived}'] | default([]) }}`;
    const guard: OutMap = {
      name: `[${node.key}] no host arrived`,
      'ansible.builtin.meta': 'end_play',
      when: 'afd_arriving | length == 0',
    };
    const plays: Out[] = [
      {
        name: `${title}: arriving hosts`,
        hosts: hosts.join(':'),
        gather_facts: false,
        tags: flow([tag]),
        vars: { flow_node_id: node.id },
        tasks: [{ name: `[${node.key}] arriving`, 'ansible.builtin.group_by': { key: arrived } }],
      },
    ];
    const inputs = inputVars(this.model, ctx.level.id, node, 'hostvars[afd_arriving | first]');

    if (kind === 'playbook') {
      const root = (this.opts.root ?? '../../..').replace(/\/+$/, '');
      const ref = (impl?.ref ?? '').replace(/^\.?\//, '');
      plays.push(
        comment(
          `${title}: playbook ${ref} on ${target}; its plays should target "{{ afd_hosts }}"`,
        ),
        {
          import_playbook: `${root}/${ref}`,
          vars: {
            afd_target_pattern: target,
            afd_arriving: arriving,
            afd_hosts: `{{ (afd_arriving | length > 0) | ternary(afd_target_pattern, 'afd_no_hosts') }}`,
            ...((impl?.params ?? {}) as OutMap),
            ...inputs,
          },
          tags: flow([tag]),
        },
        {
          // Hosts that failed inside the playbook left the run; the rest finished.
          name: `${title}: target done`,
          hosts: target,
          gather_facts: false,
          tags: flow([tag]),
          vars: { flow_node_id: node.id, afd_arriving: arriving },
          tasks: [
            guard,
            ...this.captures(node),
            { name: `[${node.key}] target done`, 'ansible.builtin.group_by': { key: done } },
          ],
        },
      );
    } else {
      const vars: OutMap = { flow_node_id: node.id, afd_arriving: arriving, ...inputs };
      if (this.opts.simulate) {
        const key = [...ctx.path, node.key].join('/');
        vars.afd_sim = `{{ (afd_simulate | default({}))['${key}'] | default({}) }}`;
      }
      const timeout = timeoutValue(settings.timeout);
      const reg = registerName(node, impl);
      const extra: Out[] = [];
      let body: OutMap;
      if (impl && kind !== 'todo') body = bindingTask(node, impl, timeout);
      else {
        const facts = stubFacts(node);
        if (facts) extra.push(facts);
        this.todo = true;
        const failing = ['failed', ...(enabled.has('timeout') ? ['timeout'] : [])];
        body = {
          name: `[${node.key}] TODO`,
          'ansible.builtin.debug': {
            msg: `TODO: ${jinjaLiteral(oneLine(node.intent || node.title))}`,
          },
          failed_when: sim
            ? `inventory_hostname in ${failing.map((p) => `afd_sim.${p} | default([])`).join(' + ')}`
            : undefined,
        };
      }
      const finished: OutMap = {
        name: `[${node.key}] target done`,
        'ansible.builtin.group_by': {
          key:
            kind === 'module'
              ? `{{ '${failedOnTarget}' if (${reg}.unreachable | default(false)) else '${done}' }}`
              : done,
        },
      };
      const timedTest = sim
        ? simIn('timeout')
        : '(ansible_failed_result.timedout | default(false))';
      plays.push({
        name: title,
        hosts: target,
        gather_facts: false,
        serial: settings.serial,
        ...this.privilege(node),
        tags: flow([tag, ...(settings.tags ?? [])]),
        vars,
        tasks: [
          guard,
          {
            block: [body, ...extra, ...this.captures(node), finished],
            rescue: [
              {
                name: `[${node.key}] target failed`,
                'ansible.builtin.group_by': {
                  key: timeoutPort
                    ? `{{ '${timedOut}' if ${timedTest} else '${failedOnTarget}' }}`
                    : failedOnTarget,
                },
              },
            ],
          },
        ],
      });
    }

    // Route the arriving hosts on the target's result; outputs come from the first finished host.
    const limit = settings.max_fail_percentage;
    const failed =
      typeof limit === 'number'
        ? `afd_target | length == 0 or (afd_target_failed | length) * 100 > ${limit} * (afd_target | length)`
        : 'afd_target | length == 0 or afd_target_failed | length > 0';
    const failedGroup = this.target(ctx, node, 'failed_hosts');
    const failGroup = timeoutPort
      ? `('${this.target(ctx, node, 'timeout')}' if (groups['${timedOut}'] | default([]) | length > 0) else '${failedGroup}')`
      : `'${failedGroup}'`;
    const outputs = [
      ...new Set(
        Object.keys(node.outputs ?? {})
          .map((o) => outputVar(this.model, node, o).split(/[.[]/)[0] as string)
          .filter(Boolean),
      ),
    ];
    const failPorts = ['failed_hosts', ...(timeoutPort ? ['timeout'] : [])];
    const tasks: Out[] = [
      {
        name: `[${node.key}] target matched no host`,
        'ansible.builtin.debug': {
          msg: 'inventory_target {{ afd_target_pattern }} matched no host: every arriving host takes failed_hosts',
        },
        when: 'afd_target | length == 0',
        run_once: true,
      },
      {
        name: `[${node.key}] target hosts that did not finish`,
        'ansible.builtin.debug': { msg: "{{ afd_target_failed | join(', ') }}" },
        when: 'afd_target_failed | length > 0',
        run_once: true,
      },
    ];
    // One per variable, only when the target host set it, as a step's captures (AFD-53): a stub
    // registers nothing, and an unguarded read failed every arriving host (found by AFD-114).
    for (const o of outputs)
      tasks.push({
        name: `[${node.key}] outputs from the target (${o})`,
        'ansible.builtin.set_fact': { [o]: `{{ hostvars[afd_target_done | first].${o} }}` },
        when: `afd_target_done | length > 0 and hostvars[afd_target_done | first].${o} is defined`,
      });
    tasks.push(...failPorts.flatMap((p) => this.portComment(ctx, node, p)), {
      name: `[${node.key}] route ${['ok_hosts', ...failPorts].join(', ')}`,
      'ansible.builtin.group_by': {
        key: `{{ ${failGroup} if (${failed}) else '${this.target(ctx, node, 'ok_hosts')}' }}`,
      },
    });
    if (enabled.has('always')) tasks.push(route(node, 'always', this.target(ctx, node, 'always')));
    plays.push({
      name: `${title}: route`,
      hosts: arrived,
      gather_facts: false,
      tags: flow([tag]),
      vars: {
        flow_node_id: node.id,
        afd_target_pattern: target,
        afd_target: "{{ query('ansible.builtin.inventory_hostnames', afd_target_pattern) }}",
        afd_target_done: `{{ groups['${done}'] | default([]) }}`,
        afd_target_failed: '{{ afd_target | difference(afd_target_done) }}',
      },
      tasks,
    });
    if (this.planning)
      this.steps.push({
        ...this.stepBase(ctx, node, hosts),
        kind: 'target',
        pattern: target,
        todo: `TODO: ${oneLine(node.intent || node.title)}`,
        ...(typeof limit === 'number' ? { maxFail: limit } : {}),
      });
    return plays;
  }

  // ---- the plan of a scenario build (AFD-114) ------------------------------------------------

  /** A scenario build (simulate, every step a stub) of the whole flow records its plan. */
  private get planning(): boolean {
    return !!this.opts.simulate && !!this.opts.stubAll && !this.segment;
  }

  /** The output ports of a node the generator routed, with their (resolved) groups. */
  private routedPorts(node: FlowNode): Record<string, string> {
    const out: Record<string, string> = {};
    const prefix = `${node.id}|`;
    for (const [memo, group] of this.targets)
      if (memo.startsWith(prefix)) out[memo.slice(prefix.length)] = group;
    return out;
  }

  private stepBase(ctx: LevelCtx, node: FlowNode, hosts: string[]) {
    const terms: HostTerm[] = hosts
      .flatMap((h) => h.split(':'))
      .filter(Boolean)
      .map((h) => (h.startsWith('{{') ? { start: true as const } : { group: h }));
    return {
      node: node.id,
      attribute: this.rollingSub ?? node.id,
      key: [...ctx.path, node.key].join('/'),
      label: `[${node.key}] ${oneLine(node.title)}`,
      hosts: terms,
      ports: this.routedPorts(node),
      serial: node.settings?.serial !== undefined,
    };
  }

  private record(ctx: LevelCtx, node: FlowNode, hosts: string[], edges: Edge[]): void {
    if (!this.planning) return;
    const base = this.stepBase(ctx, node, hosts);
    switch (node.type) {
      case 'decision':
      case 'approval':
      case 'parallel':
        this.steps.push({ ...base, kind: node.type });
        return;
      case 'join': {
        const members: string[] = [];
        for (const e of edges) {
          const from = e.to.node === node.id ? this.model.nodes.get(e.from.node)?.node : undefined;
          const group =
            from && from.type !== 'start' && this.targets.get(`${from.id}|${e.from.port}`);
          if (group) members.push(group);
        }
        this.steps.push({
          ...base,
          kind: 'join',
          mode: node.join_mode === 'any' ? 'any' : 'all',
          members,
        });
        return;
      }
      default: {
        const limit = node.settings?.max_fail_percentage;
        this.steps.push({
          ...base,
          kind: 'task',
          todo: `TODO: ${oneLine(node.intent || node.title)}`,
          // AFD-144: the hosts this step fails, as the generated code counts them.
          ...(typeof limit === 'number' ? { maxFail: { limit } } : {}),
        });
      }
    }
  }

  // ---- plays -----------------------------------------------------------------------------------

  /**
   * A playbook binding: `import_playbook` cannot sit inside a play, so the node is the import (its
   * plays target `afd_hosts`, the hosts arriving here) and a play that routes the hosts still
   * active to ok_hosts. Hosts that fail inside the playbook stop there (ADR-0011).
   */
  private playbookNode(ctx: LevelCtx, node: FlowNode, hosts: string[]): string[] {
    const tag = `node_${node.id}`;
    const root = (this.opts.root ?? '../../..').replace(/\/+$/, '');
    const ref = (node.impl?.ref ?? '').replace(/^\.?\//, '');
    const pattern = hosts.join(':');
    if (
      portsFor(node).some(
        (p) => p.name !== 'failed_hosts' && p.direction === 'out' && p.name !== 'ok_hosts',
      )
    )
      this.finding(
        'codegen-playbook-ports',
        'warning',
        `"${node.title}" runs a playbook: only ok_hosts can be routed, other ports stay empty`,
        this.model.nodes.get(node.id)?.path ?? [],
        node.id,
      );
    for (const p of portsFor(node)) if (p.direction === 'out') this.target(ctx, node, p.name);
    return [
      commentLine(
        `[${node.key}] ${oneLine(node.title)}: playbook ${oneLine(ref)}; its plays should target "{{ afd_hosts }}"`,
      ),
      ...writeBlock(
        [
          {
            import_playbook: `${root}/${ref}`,
            vars: {
              afd_hosts: pattern,
              ...((node.impl?.params ?? {}) as OutMap),
              ...inputVars(this.model, ctx.level.id, node),
            },
            tags: flow([tag]),
          },
          {
            name: `[${node.key}] ${jinjaLiteral(oneLine(node.title))}: route`,
            hosts: pattern,
            gather_facts: false,
            tags: flow([tag]),
            tasks: [
              ...this.captures(node),
              route(node, 'ok_hosts', this.target(ctx, node, 'ok_hosts')),
            ],
          },
        ],
        0,
      ),
    ];
  }

  private play(ctx: LevelCtx, node: FlowNode, hosts: string[], edges: Edge[]): OutMap {
    const tag = `node_${node.id}`;
    const vars: OutMap = { flow_node_id: node.id, ...inputVars(this.model, ctx.level.id, node) };
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
        tasks =
          this.segment?.seg.gate === node.id && !ctx.parent
            ? [
                {
                  name: `[${node.key}] wait for approval in AWX`,
                  'ansible.builtin.group_by': { key: this.group([], node.key, 'waiting') },
                },
              ]
            : this.approvalTasks(ctx, node, vars);
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
        tasks = this.taskTasks(ctx, node);
    }
    this.record(ctx, node, hosts, edges);
    return {
      name: `[${node.key}] ${jinjaLiteral(oneLine(node.title))}`,
      hosts: hosts.join(':'),
      gather_facts: false,
      serial: settings.serial,
      ...this.privilege(node),
      tags: flow([tag, ...(settings.tags ?? [])]),
      vars,
      tasks,
    };
  }

  /**
   * A step's outputs that are not its register, copied into its own variables for the hosts that
   * finished it (AFD-53), so another step setting the same fact cannot change what readers get. An
   * output the code did not set stays unset, and its reader fails as it would have.
   */
  private captures(node: FlowNode): Out[] {
    return capturedOutputs(this.model, node).map(([out, name]) => ({
      name: captureTaskName(node.key, out),
      'ansible.builtin.set_fact': { [name]: `{{ ${out} }}` },
      when: `${out} is defined`,
    }));
  }

  private taskTasks(ctx: LevelCtx, node: FlowNode): Out[] {
    const enabled = new Set(portsFor(node).map((p) => p.name));
    const impl = node.impl?.ref ? node.impl : undefined;
    const kind =
      !this.opts.stubAll && (impl?.kind === 'module' || impl?.kind === 'role') ? impl.kind : 'todo';
    const sim = this.opts.simulate && kind === 'todo';
    const timeout = timeoutValue(node.settings?.timeout);
    const reg = registerName(node, impl);
    const on = (port: string) => this.target(ctx, node, port);

    let body: OutMap;
    const extra: Out[] = [];
    if (kind !== 'todo' && impl) {
      body = bindingTask(node, impl, timeout);
    } else {
      const facts = stubFacts(node);
      if (facts) extra.push(facts);
      this.todo = true;
      const failing = ['failed', ...(enabled.has('timeout') ? ['timeout'] : [])];
      body = {
        name: `[${node.key}] TODO`,
        'ansible.builtin.debug': {
          msg: `TODO: ${jinjaLiteral(oneLine(node.intent || node.title))}`,
        },
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
    // AFD-144: max_fail_percentage counts the hosts this step failed, in a group of its own. The
    // port groups can be a parent subflow's, which already hold the hosts other steps failed.
    const limit = node.settings?.max_fail_percentage;
    const failedHere =
      typeof limit === 'number' ? this.group(ctx.path, node.key, 'failed_here') : undefined;
    const unreachableHere = okChoices.find((c) => c.port === 'unreachable');
    const counted: Out[] = failedHere
      ? [
          {
            name: `[${node.key}] count the failure`,
            'ansible.builtin.group_by': { key: failedHere },
          },
        ]
      : [];
    const rescue: Out[] = [
      ...['failed_hosts', ...failChoices.map((c) => c.port)].flatMap((p) =>
        this.portComment(ctx, node, p),
      ),
      ...counted,
      choose(node, failChoices, { group: on('failed_hosts'), port: 'failed_hosts' }),
    ];
    const countUnreachable: Out[] =
      failedHere && unreachableHere
        ? [
            {
              name: `[${node.key}] count the unreachable`,
              'ansible.builtin.group_by': { key: failedHere },
              when: unreachableHere.test,
            },
          ]
        : [];
    const block: OutMap = {
      block: [body, ...extra, ...this.captures(node), okRoute, ...countUnreachable],
      rescue,
    };
    if (enabled.has('always')) block.always = [route(node, 'always', on('always'))];
    const tasks: Out[] = [block];

    if (typeof limit === 'number' && failedHere) {
      const count = `groups['${failedHere}'] | default([]) | length`;
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
    if (parent && unreachableBubbles(parent.node))
      return this.target(parent.ctx, parent.node, 'unreachable');
    const group = this.group(ctx.path, node.key, 'unreachable');
    if (!this.routes[group]) {
      this.routes[group] = { node: node.id, port: 'unreachable' };
      this.outcome.push({
        order: this.order,
        groups: [group],
        name: `[${node.key}] unreachable`,
        msg: `Stopped at [${node.key}] ${jinjaLiteral(oneLine(node.title))}: host unreachable (the unreachable port is not enabled)`,
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
    if (this.taken(ctx).wired.has(portKey(node.id, port))) return [];
    const decided = !!portAccepted(this.doc, node.id, port);
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
    if (!condition || this.opts.stubAll) {
      this.todo = true;
      const choices = this.opts.simulate
        ? [{ test: simIn('false'), group: no, port: 'false' }]
        : [];
      const pick = choose(node, choices, { group: yes, port: 'true' });
      return [
        {
          name: `[${node.key}] TODO`,
          'ansible.builtin.debug': {
            msg: condition
              ? `Scenario: ${jinjaLiteral(oneLine(node.title))} takes true unless afd_simulate sends a host to false`
              : `TODO: ${jinjaLiteral(oneLine(node.title))} has no condition yet, so every host takes true`,
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
      msg: `Stopped at [${node.key}] ${jinjaLiteral(oneLine(node.title))}: the condition could not be evaluated`,
    });
    return [
      {
        block: [
          choose(node, [{ test: `not (${conditionExpr(condition)})`, group: no, port: 'false' }], {
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

  private approvalTasks(ctx: LevelCtx, node: FlowNode, vars: OutMap): Out[] {
    const enabled = new Set(portsFor(node).map((p) => p.name));
    const ports = ['approved', ...['rejected', 'timeout'].filter((p) => enabled.has(p))];
    // A local run approves unless the extra var afd_approvals names another outcome for this
    // approval (AFD-21); AWX workflow runs wait in a real approval node (AFD-11).
    const key = [...ctx.path, node.key].join('/');
    this.approvals.push(key);
    vars.afd_approval = `{{ (afd_approvals | default({}))['${key}'] | default('approved') }}`;
    const pick = 'afd_approval';
    const choices: Choice[] = ports
      .slice(1)
      .map((port) => ({ test: `${pick} == '${port}'`, group: this.target(ctx, node, port), port }));
    if (this.opts.simulate) {
      for (const port of ['rejected', 'timeout'])
        if (enabled.has(port))
          choices.push({ test: simIn(port), group: this.target(ctx, node, port), port });
    }
    return [
      {
        name: `[${node.key}] local approval`,
        'ansible.builtin.debug': {
          msg: `${jinjaLiteral(oneLine(node.title))}: {{ afd_approval }} in this local run (afd_approvals chooses; AWX workflow runs wait in an approval node)`,
        },
        run_once: true,
      },
      {
        name: `[${node.key}] afd_approvals outcome`,
        'ansible.builtin.fail': {
          msg: `afd_approvals['${key}'] must be one of ${ports.join(', ')}`,
        },
        when: `${pick} not in [${ports.map((p) => `'${p}'`).join(', ')}]`,
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

  /**
   * The Notes on a node as comment text (AFD-66): Markdown made plain, one line per line. Every
   * YAML line break is a split, so no text can end the comment and become code.
   */
  private noteLines(id: Ulid): string[] {
    const level = this.model.levels.get(this.model.nodes.get(id)?.level ?? '');
    const out: string[] = [];
    for (const a of level?.annotations ?? []) {
      if (!a || (a.kind ?? 'note') !== 'note' || a.on !== id) continue;
      const lines = plainText(String(a.text ?? ''))
        .split(LINE_BREAK)
        .map((l) => l.trimEnd())
        .filter((l, i, all) => l !== '' || (i > 0 && i < all.length - 1));
      lines.forEach((l, i) => {
        out.push(i === 0 ? `Note: ${l}` : `  ${l}`.trimEnd());
      });
    }
    return out;
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
          // AFD-66: the Notes on the node, above its code (outside its play range).
          if (chunk.node) body.push(...this.noteLines(chunk.node).map(commentLine));
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
    const plan: RunPlan | undefined =
      ok && this.planning
        ? {
            ...(this.startInput ? { start: this.startInput } : {}),
            steps: this.steps,
            outcome: [...this.outcome]
              .sort((a, b) => a.order - b.order)
              .map(({ groups, name, msg }) => ({ groups, name, msg })),
          }
        : undefined;
    return {
      ok,
      files,
      findings: this.findings,
      routes: this.routes,
      plays,
      ...(plan ? { plan } : {}),
    };
  }

  private header(ctx: LevelCtx): string[] {
    const f = this.doc.flow;
    const level = ctx.parent
      ? `, level [${ctx.parent.node.key}] ${oneLine(ctx.parent.node.title)}`
      : '';
    const lines = [
      commentLine(
        `GENERATED by Ansible Flow Designer from ../${oneLine(this.opts.source)} (flow ${oneLine(String(f.key))}, version ${oneLine(String(f.version))}${level}).`,
      ),
      '# Do not edit by hand: change the flow and save it. Option A engine (ADR-0009).',
    ];
    if (this.segment)
      lines.push(
        commentLine(
          `AWX workflow segment "${oneLine(this.segment.seg.name)}" (ADR-0016): the workflow runs it, with the host sets of the segment before it.`,
        ),
      );
    else if (!ctx.parent && this.todo)
      lines.push('# Unbound nodes run TODO messages: run with --check until every node is bound.');
    if (!this.segment && !ctx.parent && this.approvals.length > 0)
      lines.push(
        `# Local runs pass approvals ${this.approvals.map((k) => `[${k}]`).join(', ')} automatically; choose another outcome with -e '{"afd_approvals": {"${this.approvals[0]}": "rejected"}}'.`,
      );
    if (this.opts.simulate)
      lines.push('# SIMULATION build: afd_simulate sends chosen hosts down other ports.');
    if (this.opts.stubAll)
      lines.push('# SCENARIO build: every step runs as its stub; no binding runs (AFD-58).');
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
  generate: (doc, options) => {
    const whole = new Generator(doc, options);
    const result = whole.run();
    if (!result.ok) return result;
    const plan = planSegments(buildModel(doc));
    if (!plan) return result;
    if (plan.problems.length > 0 || plan.segments.length === 0)
      return {
        ...result,
        findings: [
          ...result.findings,
          ...plan.problems.map((p) => ({
            code: 'codegen-segments',
            severity: 'warning' as const,
            message: `${p.message}; local and skeleton runs approve automatically`,
            path: [],
            node: p.node,
          })),
        ],
      };
    const outcome = whole.outcomeEntries();
    const files = [...result.files];
    const segments: SegmentFile[] = [];
    for (const seg of plan.segments) {
      const r = new Generator(doc, options, { seg, outcome }).segmentRun();
      const file = r.files[0];
      if (!r.ok || !file) return { ...result, findings: [...result.findings, ...r.findings] };
      files.push(file);
      segments.push({
        name: seg.name,
        file: file.name,
        gate: seg.gate,
        entry: seg.entry,
        parent: seg.parent,
        finish: seg.finish,
      });
    }
    return { ...result, files, segments };
  },
};
