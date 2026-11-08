// Playbooks → flow document, as is (AFD-26, ADR-0021): one step per task, in source order, a
// one-time copy that starts a design.
// - one play is the top level; several plays (or import_playbook) are one subflow each;
// - a block with rescue/always is a subflow: its failed_hosts lead to the rescue steps, and the
//   always steps run after both paths, with a copy for hosts that failed (they fail after it);
// - roles are steps bound to the role; a role whose main only includes task files is a subflow
//   bound to the role with a step per file (include_role tasks_from);
// - handlers are steps at each flush point, run when a notifying step changed something;
// - registered and set variables become outputs, and the steps that read them get inputs.
// A failure nothing handles stays open: Ansible stops that host there too. Secrets are imported by
// name only.
import { duration } from '../engine/util';
import { importedFlow, LevelBuilder } from '../flow/builder';
import { groupPart } from '../flow/dataNames';
import { type IdFactory, slugify } from '../flow/ids';
import { exprRefs, refsIn, templated } from '../flow/jinja';
import { keywordReads } from '../flow/keywords';
import type {
  BoundaryExit,
  Contract,
  ContractType,
  FlowNode,
  ImplBinding,
  NodeSettings,
  PortRef,
  Ulid,
} from '../flow/types';
import { bareParams, MAGIC_VARS } from '../flow/validate';
import { walkNodes } from '../flow/walk';
import { shortName } from './builtins';
import { basename, relative } from './read';
import { stepDesign } from './reimport';
import type { ImportResult } from './result';
import { isSecret, SECRET, VAULT } from './secrets';
import type {
  BlockForm,
  ImportPlaybookForm,
  IncludeForm,
  Item,
  MetaForm,
  PlaybookForm,
  PlayForm,
  RoleForm,
  TaskForm,
} from './source';

export interface PlaybookImportOptions {
  key: string;
  newId: IdFactory;
  /** Repository path of the folder the flow's playbooks are generated into (flows/<key>/generated). */
  generatedDir: string;
  /** The flow name; default: the first play's name, else the file name. */
  name?: string;
}

/** A level being built: nodes, wires, and the ports the next step hangs off. */
class Level extends LevelBuilder {
  cursor: PortRef[] = [];
  entry?: Ulid;
  readonly exits: Record<string, BoundaryExit[]> = {};
  failedEnd?: FlowNode;
  /** Steps of the current play section, for play settings (serial, any_errors_fatal). */
  constructor(
    newId: IdFactory,
    readonly parents: FlowNode[],
    readonly top: boolean,
  ) {
    super(newId, top ? ['start', 'done', 'failed'] : []);
  }
}

/** What the data pass needs per step. */
interface StepInfo {
  seq: number;
  level: Level;
  node: FlowNode;
  produces: Map<string, 'register' | 'fact'>;
}

/** Handlers of the play being built, and what notified them since the last flush. */
interface Handlers {
  list: { form: TaskForm; topics: Set<string> }[];
  notified: Map<number, Set<string>>;
}

const typeOf = (v: unknown): ContractType =>
  typeof v === 'string'
    ? 'string'
    : typeof v === 'boolean'
      ? 'boolean'
      : typeof v === 'number'
        ? Number.isInteger(v)
          ? 'integer'
          : 'any'
        : Array.isArray(v)
          ? 'list'
          : v && typeof v === 'object'
            ? 'dict'
            : 'any';

const keyBase = (text: string, fallback: string) =>
  slugify(text, fallback).slice(0, 40).replace(/-+$/, '') || fallback;

class PlaybookImporter {
  readonly notes: string[] = [];
  private readonly hidden = new Set<string>();
  private readonly inputs: Contract = {};
  private readonly varValues = new Map<string, unknown[]>();
  private readonly steps = new Map<Ulid, StepInfo>();
  private seq = 0;
  private targets = 'devices';
  private hosts?: string;
  private readonly unknownReads = new Set<string>();
  /** Tasks seen per file and name, for their re-import identity (AFD-61). */
  private readonly occurrences = new Map<string, number>();

  constructor(private readonly opts: PlaybookImportOptions) {}

  run(book: PlaybookForm, readNotes: string[]): ImportResult {
    this.notes.push(...readNotes);
    const plays = flatPlays(book);
    const names = new Set(
      plays.flatMap((p) => [...Object.keys(p.vars), ...p.varsPrompt.map((v) => v.name)]),
    );
    this.targets = ['devices', 'targets', 'hosts'].find((n) => !names.has(n)) ?? 'flow_targets';
    const first = plays[0];
    this.hosts = first?.hosts;
    this.collectVars(plays);

    const top = new Level(this.opts.newId, [], true);
    const start = top.start();
    top.cursor = [{ node: start.id, port: 'ok_hosts' }];
    this.book(book, top, plays.length > 1);
    const done: FlowNode = {
      id: this.opts.newId(),
      key: 'done',
      type: 'end',
      title: 'Done',
      outcome: 'success',
    };
    this.place(top, done);
    this.wireData(top);

    const inputs: Contract = {
      [this.targets]: {
        type: 'host_list',
        required: true,
        targets: true,
        ...(this.hosts && /^[\w.-]+([,:][\w.-]+)*$/.test(this.hosts)
          ? { default: this.hosts.split(/[,:]/) }
          : {}),
      },
      ...this.inputs,
    };
    if (this.hosts && !/^[\w.-]+([,:][\w.-]+)*$/.test(this.hosts))
      this.notes.push(
        `The first play targets "${this.hosts}", a pattern the flow cannot use as a default: give ${this.targets} when running.`,
      );
    if (this.hidden.size)
      this.notes.push(
        `Imported by name only (vault, prompted or secret-looking): ${[...this.hidden].sort().join(', ')}. Give them when running.`,
      );
    if (this.unknownReads.size)
      this.notes.push(
        `Read but not set in the playbook (inventory, role defaults or extra vars): ${[...this.unknownReads].sort().join(', ')}. The banner shows them as unknown variables.`,
      );
    // What each step looks like as imported: a re-import tells the designer's edits by it.
    for (const n of walkNodes(top.nodes)) if (n.origin) n.origin.design = stepDesign(n);
    const doc = importedFlow(
      this.opts.newId(),
      {
        key: this.opts.key,
        // A playbook of imports (site.yml) is named after its file, a playbook of plays after the first.
        name:
          this.opts.name ??
          ((book.plays[0]?.kind === 'play' && first?.name) ||
            basename(book.path).replace(/\.ya?ml$/, '')),
        imported_from: { kind: 'playbook', path: book.path },
        inputs,
      },
      top,
    );
    return { doc, notes: this.notes, counts: this.counts(top.nodes) };
  }

  // ---- variables ---------------------------------------------------------------------------------

  /** Play vars and prompts become flow inputs; a name with different values stays per play. */
  private collectVars(plays: PlayForm[]): void {
    for (const p of plays)
      for (const [k, v] of Object.entries(p.vars)) {
        const list = this.varValues.get(k) ?? [];
        list.push(v);
        this.varValues.set(k, list);
      }
    for (const [name, values] of this.varValues) {
      const value = values[0];
      if (isSecret(name, value)) {
        this.inputs[name] = { type: 'string', required: true };
        this.hidden.add(name);
        continue;
      }
      const same = values.every((v) => JSON.stringify(v) === JSON.stringify(value));
      this.inputs[name] = { type: typeOf(value), default: value };
      if (!same)
        this.notes.push(
          `Variable ${name} has different values in different plays: the flow input defaults to the first, and the other plays' steps set their own in keywords.vars.`,
        );
    }
    for (const p of plays)
      for (const q of p.varsPrompt) {
        if (!q.name || this.inputs[q.name]) continue;
        const secret = q.private || SECRET.test(q.name);
        this.inputs[q.name] = {
          type: typeOf(q.default ?? ''),
          ...(secret || q.default === undefined ? { required: true } : { default: q.default }),
        };
        if (secret) this.hidden.add(q.name);
      }
  }

  /** A secret value inside params or keywords becomes a read of a flow input of that name. */
  /** Source task identity for a re-import (AFD-61): its file, its name, its occurrence there. */
  private origin(path: string, name: string): { task: string; design: string } {
    const id = `${path}#${name}`;
    const n = (this.occurrences.get(id) ?? 0) + 1;
    this.occurrences.set(id, n);
    // The fingerprint is taken once the import is done (`run`): later passes add data wiring.
    return { task: `${id}#${n}`, design: '' };
  }

  private scrub(value: unknown, name: string): unknown {
    if (value === VAULT) {
      const input = name.replace(/[^A-Za-z0-9_]/g, '_') || 'secret';
      if (!this.inputs[input]) this.inputs[input] = { type: 'string', required: true };
      this.hidden.add(input);
      return `{{ ${input} }}`;
    }
    if (Array.isArray(value)) return value.map((v) => this.scrub(v, name));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.scrub(v, k)]));
    return value;
  }

  // ---- levels ------------------------------------------------------------------------------------

  private info(node: FlowNode, level: Level): StepInfo {
    const info: StepInfo = { seq: this.seq++, level, node, produces: new Map() };
    this.steps.set(node.id, info);
    return info;
  }

  private key(level: Level, text: string, fallback: string): string {
    return level.key(keyBase(text, fallback));
  }

  /** Adds a node after the cursor; it becomes the cursor (its ok_hosts, or approved). */
  private place(level: Level, node: FlowNode, extraPorts: string[] = []): void {
    level.nodes.push(node);
    if (!this.steps.has(node.id)) this.info(node, level);
    if (level.cursor.length) for (const from of level.cursor) level.wire(from, node.id);
    else if (!level.top && !level.entry) level.entry = node.id;
    if (node.type === 'end') {
      level.cursor = [];
      return;
    }
    const out = node.type === 'approval' ? 'approved' : 'ok_hosts';
    level.cursor = [out, ...extraPorts].map((port) => ({ node: node.id, port }));
  }

  /** Hosts that must fail here: the shared end `failed`, or inside a subflow its failed_hosts exit. */
  private failExit(level: Level, ports: PortRef[], reason: string): void {
    if (!ports.length) return;
    if (level.top) {
      if (!level.failedEnd) {
        level.failedEnd = {
          id: this.opts.newId(),
          key: 'failed',
          type: 'end',
          title: 'Failed',
          outcome: 'failed',
          intent: reason,
        };
        level.nodes.push(level.failedEnd);
        this.info(level.failedEnd, level);
      }
      for (const p of ports) level.wire(p, level.failedEnd.id);
      return;
    }
    const list = level.exits.failed_hosts ?? [];
    list.push(...ports.map((p) => ({ ...p, reason })));
    level.exits.failed_hosts = list;
  }

  /** A subflow node whose inner level `build` fills; placed after the cursor. */
  private subflow(
    level: Level,
    title: string,
    build: (inner: Level) => void,
    extra: Partial<FlowNode> = {},
  ): FlowNode {
    const node: FlowNode = {
      id: this.opts.newId(),
      key: this.key(level, title, 'subflow'),
      type: 'subflow',
      title: title || 'Subflow',
      ...extra,
    };
    this.info(node, level);
    const inner = new Level(this.opts.newId, [...level.parents, node], false);
    build(inner);
    const outputs: Record<string, BoundaryExit[]> = { ...inner.exits };
    if (inner.cursor.length) outputs.ok_hosts = [...(outputs.ok_hosts ?? []), ...inner.cursor];
    node.subflow = {
      nodes: inner.nodes,
      edges: inner.edges,
      boundary: {
        ...(inner.entry ? { in: inner.entry } : {}),
        ...(Object.keys(outputs).length ? { outputs } : {}),
      },
    };
    node.status = inner.nodes.length && inner.nodes.every(isDone) ? 'implemented' : 'draft';
    this.place(level, node);
    return node;
  }

  // ---- playbooks and plays -----------------------------------------------------------------------

  private book(book: PlaybookForm, level: Level, several: boolean): void {
    for (const entry of book.plays) {
      if (entry.kind === 'import_playbook') this.imported(entry, level);
      else if (several || book.plays.length > 1) {
        this.subflow(level, entry.name || `Play ${book.plays.indexOf(entry) + 1}`, (inner) =>
          this.play(entry, inner),
        );
        this.playTarget(entry, level);
      } else {
        this.play(entry, level);
        if (entry.hosts !== this.hosts)
          this.notes.push(
            `Play "${entry.name}" targets ${entry.hosts}; the flow runs it on the hosts that arrive.`,
          );
      }
    }
  }

  /** A later play with its own hosts runs there (settings.inventory_target on its subflow). */
  private playTarget(play: PlayForm, level: Level): void {
    const node = level.nodes[level.nodes.length - 1];
    if (!node || play.hosts === this.hosts) return;
    node.settings = { ...node.settings, inventory_target: play.hosts };
  }

  private imported(entry: ImportPlaybookForm, level: Level): void {
    const book = entry.playbook;
    if (!book) {
      const node = this.draft(level, entry.name, `import_playbook ${entry.file}: ${entry.missing}`);
      this.notes.push(
        `${node.key}: ${entry.file} could not be read (${entry.missing}): a draft step.`,
      );
      return;
    }
    if (Object.keys(entry.keywords).length)
      this.notes.push(
        `import_playbook ${entry.file} has ${Object.keys(entry.keywords).join(', ')}: not applied to its steps.`,
      );
    const title = entry.name || basename(entry.file).replace(/\.ya?ml$/, '');
    const plays = book.plays;
    if (plays.length === 1 && plays[0]?.kind === 'play') {
      const play = plays[0];
      this.subflow(level, play.name || title, (inner) => this.play(play, inner));
      this.playTarget(play, level);
    } else this.subflow(level, title, (inner) => this.book(book, inner, true));
  }

  private play(play: PlayForm, level: Level): void {
    const before = new Set(this.steps.keys());
    const handlers: Handlers = {
      list: play.handlers
        .filter((h): h is TaskForm => {
          if (h.kind === 'task') return true;
          this.notes.push(`Play "${play.name}": a handler that is not a plain task was skipped.`);
          return false;
        })
        .map((form) => ({ form, topics: new Set([form.name, ...form.listen].filter(Boolean)) })),
      notified: new Map(),
    };
    for (const f of play.varsFiles) {
      if (!f.path) {
        this.notes.push(
          `Play "${play.name}": vars file ${f.file} was not found or is templated; not loaded.`,
        );
        continue;
      }
      const node = this.module(level, {
        title: `Load ${basename(f.file)}`,
        intent: `Load the variables of ${f.file}`,
        ref: 'ansible.builtin.include_vars',
        params: { file: `{{ playbook_dir }}/${relative(this.opts.generatedDir, f.path)}` },
      });
      const info = this.steps.get(node.id);
      for (const k of f.keys) info?.produces.set(k, 'fact');
    }
    if (play.gatherFacts)
      this.module(level, {
        title: 'Gather facts',
        intent: 'Gather the facts of the hosts (the play gathered them)',
        ref: 'ansible.builtin.gather_facts',
        params: play.gatherParams,
      });
    this.items(play.preTasks, level, handlers);
    this.flush(level, handlers);
    this.items(play.roles, level, handlers);
    this.items(play.tasks, level, handlers);
    this.flush(level, handlers);
    this.items(play.postTasks, level, handlers);
    this.flush(level, handlers);

    // Play-wide settings go onto each of its steps (Option A runs a play per step).
    const own = [...this.steps.values()].filter(
      (s) => !before.has(s.node.id) && (s.node.type === 'task' || s.node.type === 'approval'),
    );
    const settings: NodeSettings = {};
    if (play.serial !== undefined) settings.serial = play.serial;
    if (play.anyErrorsFatal) settings.max_fail_percentage = 0;
    else if (play.maxFailPercentage !== undefined)
      settings.max_fail_percentage = play.maxFailPercentage;
    if (Object.keys(settings).length) {
      for (const s of own) s.node.settings = { ...settings, ...s.node.settings };
      this.notes.push(
        `Play "${play.name}": ${Object.keys(settings).join(' and ')} now apply to each of its steps, not to the play as a whole${play.anyErrorsFatal ? ' (any_errors_fatal became max_fail_percentage 0)' : ''}.`,
      );
    }
    if (play.dropped.length)
      this.notes.push(`Play "${play.name}": ${play.dropped.join(', ')} have no place in a flow.`);
    if (play.collections.length)
      this.notes.push(
        `Play "${play.name}" searches collections ${play.collections.join(', ')}: steps are bound by full name where it was known.`,
      );
    // Variables this play sets differently from the flow input reach its steps through vars.
    for (const [name, values] of this.varValues) {
      if (values.length < 2 || !(name in play.vars) || isSecret(name, play.vars[name])) continue;
      if (JSON.stringify(play.vars[name]) === JSON.stringify(values[0])) continue;
      for (const s of own) {
        const impl = s.node.impl;
        if (!impl) continue;
        if (impl.kind === 'role') impl.params = { ...impl.params, [name]: play.vars[name] };
        else
          impl.keywords = {
            ...impl.keywords,
            vars: { ...(impl.keywords?.vars as object), [name]: play.vars[name] },
          };
      }
    }
  }

  // ---- items -------------------------------------------------------------------------------------

  private items(list: Item[], level: Level, handlers: Handlers, suffix = ''): void {
    for (const item of list) this.item(item, level, handlers, suffix);
  }

  private item(item: Item, level: Level, handlers: Handlers, suffix: string): void {
    switch (item.kind) {
      case 'task':
        this.task(item, level, handlers, suffix);
        return;
      case 'block':
        this.block(item, level, handlers, suffix);
        return;
      case 'include':
        this.include(item, level, handlers, suffix);
        return;
      case 'role':
        this.role(item, level, suffix);
        return;
      case 'meta':
        this.meta(item, level, handlers);
        return;
    }
  }

  private task(t: TaskForm, level: Level, handlers: Handlers, suffix: string, when?: string): void {
    if (shortName(t.module) === 'pause' && typeof t.params.prompt === 'string') {
      const node: FlowNode = {
        id: this.opts.newId(),
        key: this.key(level, `${t.name || 'approval'}${suffix}`, 'approval'),
        type: 'approval',
        title: t.name || 'Approval',
        intent: t.params.prompt,
        status: 'draft',
      };
      this.place(level, node);
      this.notes.push(
        `${node.key}: the pause with a prompt became an approval (approved locally, asked in AWX).`,
      );
      return;
    }
    const key = this.key(level, `${t.name || shortName(t.module)}${suffix}`, 'step');
    const origin = this.origin(t.origin.path, t.name || t.module);
    const notifies = t.notify.length > 0;
    const register = t.register ?? (notifies ? `${groupPart(key)}_result` : undefined);
    const params: Record<string, unknown> = { ...t.params };
    for (const f of t.files) {
      if (f.path) {
        const local = `{{ playbook_dir }}/${relative(this.opts.generatedDir, f.path)}`;
        params[f.param] =
          f.param === 'cmd' && typeof params.cmd === 'string'
            ? params.cmd.replace(f.written, local)
            : local;
      } else
        this.notes.push(
          `${key}: ${f.written} (${f.param}) was not found next to ${t.origin.path}; kept as written.`,
        );
    }
    let keywords = { ...t.keywords };
    if (when) {
      const list = [...(keywords.when === undefined ? [] : [keywords.when].flat()), when];
      keywords.when = list.length === 1 ? list[0] : list;
    }
    keywords = this.scrub(keywords, 'keywords') as Record<string, unknown>;
    const ref = t.fqcn ?? t.module;
    const impl: ImplBinding = {
      kind: 'module',
      ref,
      ...(Object.keys(params).length
        ? { params: this.scrub(params, 'params') as Record<string, unknown> }
        : {}),
      ...(register ? { register } : {}),
      ...(Object.keys(keywords).length ? { keywords } : {}),
    };
    const settings: NodeSettings = {};
    if (t.become) settings.become = true;
    if (t.tags.length) settings.tags = [...new Set(t.tags)];
    if (t.timeout)
      settings.timeout = typeof t.timeout === 'number' ? duration(t.timeout) : t.timeout;
    if (t.retries !== undefined) settings.retries = t.retries;
    if (t.delay !== undefined) settings.delay = t.delay;
    if (t.until) settings.until = t.until;
    const node: FlowNode = {
      id: this.opts.newId(),
      key,
      type: 'task',
      title: t.name || shortName(ref),
      intent: t.name || `Runs ${ref}`,
      status: t.fqcn ? 'implemented' : 'draft',
      impl,
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(t.ignoreUnreachable ? { ports: ['unreachable'] } : {}),
      origin,
    };
    if (!t.fqcn)
      this.notes.push(
        `${key}: module ${t.module} is not fully qualified and not known here; check the binding (draft).`,
      );
    if (t.dropped.length)
      this.notes.push(
        `${key}: ${[...new Set(t.dropped)].join(', ')} have no place in a flow and were left out.`,
      );
    const info = this.info(node, level);
    if (register) info.produces.set(register, 'register');
    if (shortName(ref) === 'set_fact')
      for (const k of Object.keys(t.params)) if (k !== 'cacheable') info.produces.set(k, 'fact');
    this.place(level, node, t.ignoreUnreachable ? ['unreachable'] : []);
    // Notifications: what each handler waits for until the next flush.
    for (const topic of t.notify)
      handlers.list.forEach((h, i) => {
        if (!h.topics.has(topic) || !register) return;
        const set = handlers.notified.get(i) ?? new Set<string>();
        set.add(register);
        handlers.notified.set(i, set);
      });
  }

  /** A step bound to a module that the import adds itself (vars files, facts). */
  private module(
    level: Level,
    spec: { title: string; intent: string; ref: string; params: Record<string, unknown> },
  ): FlowNode {
    const node: FlowNode = {
      id: this.opts.newId(),
      key: this.key(level, spec.title, 'step'),
      type: 'task',
      title: spec.title,
      intent: spec.intent,
      status: 'implemented',
      impl: {
        kind: 'module',
        ref: spec.ref,
        ...(Object.keys(spec.params).length ? { params: spec.params } : {}),
      },
    };
    this.place(level, node);
    return node;
  }

  private draft(level: Level, title: string, intent: string): FlowNode {
    const node: FlowNode = {
      id: this.opts.newId(),
      key: this.key(level, title, 'step'),
      type: 'task',
      title: title || 'Step',
      intent,
      status: 'draft',
    };
    this.place(level, node);
    return node;
  }

  /** Handlers notified since the last flush run now, once each, in the order they are defined. */
  private flush(level: Level, handlers: Handlers): void {
    handlers.list.forEach((h, i) => {
      const regs = handlers.notified.get(i);
      if (!regs?.size) return;
      const when = [...regs].map((r) => `(${r} | default({})) is changed`).join(' or ');
      this.task(h.form, level, { list: [], notified: new Map() }, '', when);
    });
    handlers.notified.clear();
  }

  private block(b: BlockForm, level: Level, handlers: Handlers, suffix: string): void {
    if (!b.rescue.length && !b.always.length) {
      this.items(b.items, level, handlers, suffix);
      return;
    }
    const title = b.name || 'Block';
    const sub = this.subflow(level, `${title}${suffix}`, (inner) =>
      this.items(b.items, inner, handlers, suffix),
    );
    if (suffix) sub.title = `${title} (after a failure)`;
    const ok: PortRef[] = [{ node: sub.id, port: 'ok_hosts' }];
    let failed: PortRef[] = [{ node: sub.id, port: 'failed_hosts' }];
    if (b.rescue.length) {
      level.cursor = failed;
      const first = level.nodes.length;
      this.items(b.rescue, level, handlers, suffix);
      ok.push(...level.cursor);
      // Hosts that fail inside the rescue still run the always steps, then fail.
      failed = level.nodes
        .slice(first)
        .filter((n) => n.type === 'task' || n.type === 'subflow')
        .map((n) => ({ node: n.id, port: 'failed_hosts' }));
    }
    if (!b.always.length) {
      level.cursor = ok;
      return;
    }
    level.cursor = ok;
    this.items(b.always, level, handlers, suffix);
    const after = level.cursor;
    level.cursor = failed;
    this.items(b.always, level, handlers, `${suffix}-after-failure`);
    this.failExit(level, level.cursor, `${title}: failed before the always steps`);
    level.cursor = after;
  }

  private include(inc: IncludeForm, level: Level, handlers: Handlers, suffix: string): void {
    if (!inc.items) {
      const node = this.draft(
        level,
        inc.name || `Include ${inc.file}`,
        `Includes ${inc.file} (not read in: ${inc.dynamic})`,
      );
      this.notes.push(
        `${node.key}: ${inc.file} is not read in because ${inc.dynamic}: a draft step.`,
      );
      return;
    }
    const title = inc.name || basename(inc.file).replace(/\.ya?ml$/, '');
    // AFD-149: include_tasks checks its `when` once, before the file runs: a decision whose
    // false side goes around the file's subflow (import_tasks puts it on each task instead).
    const gate = inc.when?.length ? this.includeGate(level, title, suffix, inc.when) : undefined;
    this.subflow(level, `${title}${suffix}`, (inner) =>
      this.items(inc.items ?? [], inner, handlers, suffix),
    );
    if (gate) level.cursor = [...level.cursor, { node: gate.id, port: 'false' }];
  }

  /** A decision that lets the hosts for which an include's `when` holds into the include. */
  private includeGate(level: Level, title: string, suffix: string, when: unknown[]): FlowNode {
    const parts = when.map((w) => (typeof w === 'string' ? w.trim() : JSON.stringify(w)));
    const condition =
      parts.length === 1 ? (parts[0] as string) : parts.map((p) => `(${p})`).join(' and ');
    const gate: FlowNode = {
      id: this.opts.newId(),
      key: this.key(level, `${title} when${suffix}`, 'decision'),
      type: 'decision',
      title: `Run ${title}?`,
      condition,
      status: 'implemented',
    };
    this.place(level, gate);
    level.cursor = [{ node: gate.id, port: 'true' }];
    this.notes.push(
      `${gate.key}: include_tasks checks its when once, before ${title} runs: a decision (true runs it, false goes around it).`,
    );
    return gate;
  }

  private role(r: RoleForm, level: Level, suffix: string): void {
    const settings: NodeSettings = {};
    if (r.become) settings.become = true;
    if (r.tags.length) settings.tags = [...new Set(r.tags)];
    const params = this.scrub(r.params, 'params') as Record<string, unknown>;
    const keywords = this.scrub(r.keywords, 'keywords') as Record<string, unknown>;
    const found = !!r.dir || r.onRolesPath;
    const status = found ? 'implemented' : 'draft';
    if (!found)
      this.notes.push(`Role ${r.ref} was not found in the repository: its step is a draft.`);
    else if (!r.onRolesPath)
      this.notes.push(
        `Role ${r.ref} is in ${r.dir}, which generated plays do not search: add its folder to roles_path in ansible.cfg.`,
      );
    if (r.dropped.length)
      this.notes.push(
        `Role ${r.ref}: ${[...new Set(r.dropped)].join(', ')} have no place in a flow.`,
      );
    const binding = (extra: Record<string, unknown>, kw: Record<string, unknown>): ImplBinding => ({
      kind: 'role',
      ref: r.ref,
      ...(Object.keys({ ...params, ...extra }).length ? { params: { ...params, ...extra } } : {}),
      ...(Object.keys(kw).length ? { keywords: kw } : {}),
    });
    if (r.split) {
      const split = r.split;
      const sub = this.subflow(
        level,
        `${r.name}${suffix}`,
        (inner) => {
          split.forEach((step, i) => {
            const node: FlowNode = {
              id: this.opts.newId(),
              key: this.key(inner, step.name, 'step'),
              type: 'task',
              title: step.name,
              intent: `${r.ref}: tasks/${step.tasksFrom}`,
              status,
              impl: binding({ tasks_from: step.tasksFrom }, { ...keywords, ...step.keywords }),
              ...(step.tags.length ? { settings: { tags: step.tags } } : {}),
            };
            const info = this.info(node, inner);
            // What the role sets is attributed to its last step.
            if (i === split.length - 1) for (const o of r.outputs) info.produces.set(o, 'fact');
            this.place(inner, node);
          });
        },
        {
          impl: { kind: 'role', ref: r.ref },
          intent: `Runs role ${r.ref}, one step per task file`,
        },
      );
      if (Object.keys(settings).length) sub.settings = settings;
      return;
    }
    const node: FlowNode = {
      id: this.opts.newId(),
      key: this.key(level, `${r.name}${suffix}`, 'role'),
      type: 'task',
      title: r.name,
      intent: `Runs role ${r.ref}`,
      status,
      impl: binding({}, keywords),
      ...(Object.keys(settings).length ? { settings } : {}),
    };
    const info = this.info(node, level);
    for (const o of r.outputs) info.produces.set(o, 'fact');
    this.place(level, node);
  }

  private meta(m: MetaForm, level: Level, handlers: Handlers): void {
    if (m.action === 'flush_handlers') {
      this.flush(level, handlers);
      return;
    }
    if (m.action === 'noop') return;
    const node = this.draft(level, m.name || `meta ${m.action}`, `meta: ${m.action}`);
    this.notes.push(
      `${node.key}: meta ${m.action} has no flow equivalent: a draft step that lets hosts through.`,
    );
  }

  // ---- data --------------------------------------------------------------------------------------

  /**
   * Every variable a step reads that an earlier step registered or set becomes an input of the
   * reader (`from: <producer>.<name>`); the producer gets the output, lifted out of the subflows in
   * between. Flow inputs read directly get `from: flow.<name>`.
   */
  private wireData(top: Level): void {
    const ordered = [...this.steps.values()].sort((a, b) => a.seq - b.seq);
    const latest = new Map<string, StepInfo>();
    for (const step of ordered) {
      for (const name of readsOf(step.node)) {
        if (MAGIC_VARS.test(name) || step.node.inputs?.[name]) continue;
        const producer = latest.get(name);
        if (producer && producer !== step) this.connect(producer, step, name);
        else if (name in this.inputs)
          this.addInput(step.node, name, `flow.${name}`, this.inputs[name]?.type ?? 'any');
        else this.unknownReads.add(name);
      }
      for (const [name] of step.produces) latest.set(name, step);
    }
    void top;
  }

  private addInput(node: FlowNode, name: string, from: string, type: ContractType): void {
    node.inputs = { ...node.inputs, [name]: { type, from } };
  }

  private connect(producer: StepInfo, consumer: StepInfo, name: string): void {
    const kind = producer.produces.get(name);
    const p = producer.node;
    if (!p.outputs?.[name])
      p.outputs = {
        ...p.outputs,
        [name]: kind === 'register' ? { type: 'dict', from: 'impl.register' } : { type: 'any' },
      };
    // The common level: the deepest subflow both are inside.
    const pp = producer.level.parents;
    const cp = consumer.level.parents;
    let k = 0;
    while (k < pp.length && k < cp.length && pp[k]?.id === cp[k]?.id) k++;
    // Lift the output through the producer's subflows below the common level.
    let child = p;
    for (let i = pp.length - 1; i >= k; i--) {
      const sub = pp[i] as FlowNode;
      if (!sub.outputs?.[name])
        sub.outputs = { ...sub.outputs, [name]: { type: 'any', from: `${child.key}.${name}` } };
      child = sub;
    }
    const type = p.outputs[name]?.type ?? 'any';
    // A key on a level between the consumer and the common level would shadow the producer's.
    const shadowed = cp
      .slice(k)
      .some((sub) =>
        (sub.subflow?.nodes ?? []).some((n) => n.key === child.key && n.id !== child.id),
      );
    if (!shadowed) {
      this.addInput(consumer.node, name, `${child.key}.${name}`, type);
      return;
    }
    // Pass it down through the consumer's subflows' inputs instead.
    let from = `${child.key}.${name}`;
    for (let i = k; i < cp.length; i++) {
      const sub = cp[i] as FlowNode;
      if (!sub.inputs?.[name]) this.addInput(sub, name, from, type);
      from = `${sub.key}.${name}`;
    }
    this.addInput(consumer.node, name, from, type);
  }

  private counts(nodes: FlowNode[]): ImportResult['counts'] {
    const counts = { steps: 0, implemented: 0, drafts: 0 };
    for (const n of walkNodes(nodes)) {
      if (n.type === 'subflow' && n.subflow?.nodes?.length) continue;
      if (n.type === 'task' || n.type === 'approval' || n.type === 'subflow') {
        counts.steps++;
        if (n.status === 'implemented') counts.implemented++;
        else counts.drafts++;
      }
    }
    return counts;
  }
}

/**
 * Variables a step reads in its params and keywords, without the names it defines itself. AFD-112:
 * and in its Timing given at run time and its until, which read the step's inputs too.
 */
function readsOf(node: FlowNode): string[] {
  const impl = node.impl;
  if (!impl) return [];
  const kw = keywordReads(impl);
  const own = new Set([...kw.own, ...(impl.register ? [impl.register] : [])]);
  const s = node.settings ?? {};
  const read = [
    ...refsIn(impl.params ?? {}),
    ...exprRefs(bareParams(impl)),
    ...kw.templated,
    ...kw.bare,
    ...exprRefs([s.retries, s.delay, s.timeout].filter((v) => templated(v))),
    ...(s.until ? exprRefs(s.until) : []),
  ];
  return [...new Set(read)].filter((n) => !own.has(n));
}

const isDone = (n: FlowNode): boolean =>
  n.type === 'subflow'
    ? n.status === 'implemented'
    : n.type === 'task'
      ? n.status === 'implemented'
      : n.type !== 'approval';

/** Plays in source order, imported ones included. */
export function flatPlays(book: PlaybookForm): PlayForm[] {
  return book.plays.flatMap((p) =>
    p.kind === 'play' ? [p] : p.playbook ? flatPlays(p.playbook) : [],
  );
}

/** A playbook (as read by readPlaybook) as a flow. */
export function importPlaybook(
  book: PlaybookForm,
  opts: PlaybookImportOptions,
  readNotes: string[] = [],
): ImportResult {
  return new PlaybookImporter(opts).run(book, readNotes);
}
