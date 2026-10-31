// AWX workflow → flow document (M9, D-31, ADR-0015): a one-time copy that starts a design.
// AWX edges are per job, flow ports per host; the mapping keeps what AWX does with each job:
// - success → ok_hosts (approved), failure → failed_hosts (rejected, and timeout when set);
// - always is a failure handler in AWX, so its children hang off both of those ports (the flow's
//   own always port would leave failed_hosts open and raise the banner for a handled failure);
// - several children on one edge → a parallel node; several root nodes → start → parallel;
// - convergence "all" → a join (all) in front of the node; "any" → several wires into `in`;
// - a failure no edge handles stays open: AWX fails the workflow there too.
// Values that are encrypted or look secret are imported by name only.
import { duration } from '../engine/util';
import { type IdFactory, slugify, uniqueKey } from '../flow/ids';
import type {
  BoundaryExit,
  Contract,
  ContractField,
  ContractType,
  Edge,
  FlowDocument,
  FlowNode,
  NodeSettings,
  Ulid,
} from '../flow/types';
import { flatPlays, importPlaybook } from '../import/playbook';
import type { ImportResult } from '../import/result';
import { cleanVars, isSecret } from '../import/secrets';
import type { PlaybookForm } from '../import/source';
import type { SurveyQuestion, WorkflowNodeSource, WorkflowSource } from './workflow';

export interface ImportOptions {
  key: string;
  newId: IdFactory;
  /** Whether a playbook (a repository path) exists in the target repository. */
  hasPlaybook(ref: string): boolean;
  /** AWX id of the source workflow; left out for an export file. */
  sourceId?: number;
  /**
   * Playbooks read from the repository, by ref (AFD-26): a job node whose playbook is here becomes
   * a subflow of its steps instead of one playbook step.
   */
  playbooks?: Map<string, PlaybookForm>;
  /** What the flow records it was imported from (default: an AWX workflow). */
  kind?: 'awx_workflow' | 'awx_job_template';
}

/**
 * Whether a playbook can be expanded into steps: not one the designer generated (it targets
 * `afd_hosts` and routes hosts itself), so it stays a playbook step.
 */
export function expandable(ref: string, book: PlaybookForm): boolean {
  if (/^\.?\/?flows\/[^/]+\/generated\//.test(ref)) return false;
  return !flatPlays(book).some((p) => p.hosts.includes('afd_hosts'));
}

export type { ImportResult };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KIND_LABEL: Record<string, string> = {
  project_update: 'AWX project sync',
  inventory_update: 'AWX inventory sync',
  system_job: 'AWX system job',
};

export { duration };

function typeOf(v: unknown): ContractType {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'any';
  if (Array.isArray(v)) return 'list';
  if (v && typeof v === 'object') return 'dict';
  return 'any';
}

const SURVEY_TYPE: Record<string, ContractType> = {
  text: 'string',
  textarea: 'string',
  password: 'string',
  multiplechoice: 'string',
  multiselect: 'list',
  integer: 'integer',
  float: 'any',
};

const uniq = (xs: string[]) => [...new Set(xs)];

class Importer {
  readonly notes: string[] = [];
  private readonly hidden = new Set<string>();
  private readonly playbookInputs: Contract = {};
  private steps = 0;
  private implemented = 0;
  private drafts = 0;

  constructor(private readonly opts: ImportOptions) {}

  run(src: WorkflowSource): ImportResult {
    const level = this.level(src, true);
    const inputs = this.inputs(src);
    // Variables of expanded playbooks join the flow inputs; AWX extra vars and surveys win.
    for (const [k, f] of Object.entries(this.playbookInputs)) if (!(k in inputs)) inputs[k] = f;
    const doc: FlowDocument = {
      schema_version: 1,
      flow: {
        id: this.opts.newId(),
        key: this.opts.key,
        name: src.name,
        version: 1,
        ...(src.description ? { goal: src.description } : {}),
        imported_from: {
          kind: this.opts.kind ?? 'awx_workflow',
          template: src.name,
          ...(this.opts.sourceId !== undefined ? { id: this.opts.sourceId } : {}),
          ...(this.opts.kind === 'awx_job_template' && src.nodes[0]?.job?.playbook
            ? { path: src.nodes[0].job.playbook }
            : {}),
        },
        inputs,
      },
      nodes: level.nodes,
      edges: level.edges,
    };
    if (this.hidden.size)
      this.notes.push(
        `Imported by name only (encrypted or secret-looking): ${[...this.hidden].sort().join(', ')}.`,
      );
    return {
      doc,
      notes: this.notes,
      counts: { steps: this.steps, implemented: this.implemented, drafts: this.drafts },
    };
  }

  /** Copy without encrypted or secret-looking entries (their names go to the notes). */
  private clean(m: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    return cleanVars(m, this.hidden);
  }

  private inputs(src: WorkflowSource): Contract {
    const taken = new Set([
      ...(src.survey ?? []).map((q) => q.variable),
      ...Object.keys(src.extraVars ?? {}),
    ]);
    const targets = ['devices', 'targets', 'hosts'].find((n) => !taken.has(n)) ?? 'flow_targets';
    const inputs: Contract = {
      [targets]: {
        type: 'host_list',
        required: true,
        targets: true,
        // A plain list of groups or hosts; other patterns (`edge:&prod`) stay one entry.
        ...(src.limit
          ? {
              default: /^[\w.-]+([,:][\w.-]+)*$/.test(src.limit)
                ? src.limit.split(/[,:]/)
                : [src.limit],
            }
          : {}),
      },
    };
    for (const q of src.survey ?? []) if (q?.variable) inputs[q.variable] = this.question(q);
    const vars = this.clean(src.extraVars) ?? {};
    for (const [k, v] of Object.entries(src.extraVars ?? {}))
      if (!(k in inputs)) inputs[k] = { type: typeOf(v), ...(k in vars ? { default: v } : {}) };
    return inputs;
  }

  private question(q: SurveyQuestion): ContractField {
    const field: ContractField = { type: SURVEY_TYPE[q.type] ?? 'any' };
    if (q.required) field.required = true;
    let value = q.default;
    if (q.type === 'multiselect' && typeof value === 'string')
      value = value.split('\n').filter(Boolean);
    const secret = q.type === 'password' || isSecret(q.variable, value);
    if (secret) {
      if (value !== undefined && value !== '') this.hidden.add(q.variable);
    } else if (value !== undefined && value !== '' && !(Array.isArray(value) && !value.length))
      field.default = value;
    return field;
  }

  private level(
    src: WorkflowSource,
    top: boolean,
  ): {
    nodes: FlowNode[];
    edges: Edge[];
    entry?: Ulid;
    outputs?: Record<string, BoundaryExit[]>;
  } {
    const newId = this.opts.newId;
    const keys = new Set<string>(top ? ['start', 'done'] : []);
    const nodes: FlowNode[] = [];
    const edges: Edge[] = [];
    const edge = (from: FlowNode, port: string, to: FlowNode) =>
      edges.push({
        id: newId(),
        from: { node: from.id, port },
        to: { node: to.id, port: 'in' },
      });
    const start: FlowNode | undefined = top
      ? { id: newId(), key: 'start', type: 'start', title: 'Start' }
      : undefined;
    if (start) nodes.push(start);

    const mapped = new Map<string, FlowNode>();
    for (const n of src.nodes) {
      const f = this.node(n, keys);
      mapped.set(n.identifier, f);
      nodes.push(f);
    }
    const incoming = new Map<string, { node: FlowNode; port: string }[]>();
    const arrive = (target: string, node: FlowNode, port: string): void => {
      incoming.set(target, [...(incoming.get(target) ?? []), { node, port }]);
    };
    const parallel = (title: string, base: string, count: number): FlowNode => {
      const key = uniqueKey(slugify(base, 'parallel'), keys);
      keys.add(key);
      const p: FlowNode = { id: newId(), key, type: 'parallel', title, branches: count };
      nodes.push(p);
      return p;
    };
    /** Wires `ports` of `from` to the targets (through a parallel node for several); false if none. */
    const fanOut = (from: FlowNode, ports: string[], targets: string[]): boolean => {
      const known = targets.filter((t) => mapped.has(t));
      if (known.length === 0) return false;
      if (known.length === 1) {
        for (const port of ports) arrive(known[0] as string, from, port);
        return true;
      }
      const p = parallel(`After ${from.title}`, `after-${from.key}`, known.length);
      for (const port of ports) edge(from, port, p);
      for (const [i, t] of known.entries()) arrive(t, p, `branch_${i + 1}`);
      return true;
    };

    const children = new Set(src.nodes.flatMap((n) => [...n.success, ...n.failure, ...n.always]));
    const roots = src.nodes.filter((n) => !children.has(n.identifier)).map((n) => n.identifier);
    const openOk: { node: FlowNode; port: string }[] = [];
    const openFail: { node: FlowNode; port: string }[] = [];
    let entry: Ulid | undefined;
    if (start) {
      if (!fanOut(start, ['ok_hosts'], roots)) openOk.push({ node: start, port: 'ok_hosts' });
    } else if (roots.length === 1) {
      entry = mapped.get(roots[0] as string)?.id;
    } else if (roots.length > 1) {
      const p = parallel('Start in parallel', 'start-in-parallel', roots.length);
      entry = p.id;
      for (const [i, r] of roots.entries()) arrive(r, p, `branch_${i + 1}`);
    }

    for (const n of src.nodes) {
      const f = mapped.get(n.identifier) as FlowNode;
      const approval = f.type === 'approval';
      const okPort = approval ? 'approved' : 'ok_hosts';
      if (!fanOut(f, [okPort], uniq([...n.success, ...n.always])))
        openOk.push({ node: f, port: okPort });
      const failPorts = approval
        ? ['rejected', ...(f.ports?.includes('timeout') ? ['timeout'] : [])]
        : ['failed_hosts'];
      if (!fanOut(f, failPorts, uniq([...n.failure, ...n.always])))
        openFail.push(...failPorts.map((port) => ({ node: f, port })));
    }

    for (const n of src.nodes) {
      const f = mapped.get(n.identifier) as FlowNode;
      const from = incoming.get(n.identifier) ?? [];
      if (n.converge && new Set(from.map((i) => i.node.id)).size >= 2) {
        const key = uniqueKey(slugify(`join ${f.key}`, 'join'), keys);
        keys.add(key);
        const j: FlowNode = {
          id: newId(),
          key,
          type: 'join',
          title: `Join for ${f.title}`,
          join_mode: 'all',
        };
        nodes.push(j);
        for (const i of from) edge(i.node, i.port, j);
        edge(j, 'ok_hosts', f);
      } else for (const i of from) edge(i.node, i.port, f);
    }

    if (top) {
      if (openOk.length) {
        const done: FlowNode = {
          id: newId(),
          key: 'done',
          type: 'end',
          title: 'Done',
          outcome: 'success',
        };
        nodes.push(done);
        for (const o of openOk) edge(o.node, o.port, done);
      }
      // Open fail ports stay open: the banner shows the failures AWX does not handle either.
      return { nodes, edges };
    }
    // Inside a subflow, outcomes leave through the parent's ok_hosts; failed_hosts bubbles up by
    // itself (decision 10), approval problems need an explicit exit.
    const outputs: Record<string, BoundaryExit[]> = {};
    if (openOk.length) outputs.ok_hosts = openOk.map((o) => ({ node: o.node.id, port: o.port }));
    const exits = openFail.filter((o) => o.port !== 'failed_hosts');
    if (exits.length) outputs.failed_hosts = exits.map((o) => ({ node: o.node.id, port: o.port }));
    return { nodes, edges, entry, outputs };
  }

  private node(n: WorkflowNodeSource, keys: Set<string>): FlowNode {
    const title = n.name || 'Missing template';
    const key = uniqueKey(
      slugify(n.identifier && !UUID.test(n.identifier) ? n.identifier : title, 'step'),
      keys,
    );
    keys.add(key);
    const id = this.opts.newId();
    const label = `"${key}"`;
    if (n.kind === 'approval') {
      this.steps++;
      this.drafts++;
      const timed = (n.timeout ?? 0) > 0 && n.failure.length + n.always.length > 0;
      return {
        id,
        key,
        type: 'approval',
        title,
        ...(n.description ? { intent: n.description } : {}),
        ...(timed ? { ports: ['timeout'] } : {}),
        ...((n.timeout ?? 0) > 0 ? { settings: { timeout: duration(n.timeout as number) } } : {}),
      };
    }
    if (n.kind === 'workflow') {
      const node: FlowNode = {
        id,
        key,
        type: 'subflow',
        title,
        ...(n.description ? { intent: n.description } : {}),
      };
      if (n.workflow?.nodes.length) {
        const inner = this.level(n.workflow, false);
        node.subflow = {
          nodes: inner.nodes,
          edges: inner.edges,
          boundary: {
            ...(inner.entry ? { in: inner.entry } : {}),
            ...(inner.outputs && Object.keys(inner.outputs).length
              ? { outputs: inner.outputs }
              : {}),
          },
        };
      } else {
        // A subflow without inner steps is a step of its own.
        this.steps++;
        this.drafts++;
        if (n.unresolved)
          this.notes.push(`${label} nests "${title}", but ${n.unresolved}: no inner steps.`);
      }
      return node;
    }
    const book =
      n.kind === 'job' && n.job?.playbook ? this.opts.playbooks?.get(n.job.playbook) : undefined;
    if (book && n.job?.playbook && expandable(n.job.playbook, book))
      return this.expand(n, book, { id, key, title, label });
    this.steps++;
    if (n.kind !== 'job') {
      this.drafts++;
      const intent =
        n.kind === 'missing'
          ? 'The AWX node has no template (deleted, or not visible to this token); AWX treats it as failed'
          : `${KIND_LABEL[n.kind]}: ${title}`;
      if (n.kind === 'missing') this.notes.push(`${label} has no template in AWX: a draft task.`);
      return { id, key, type: 'task', title, intent, status: 'draft' };
    }

    const jt = n.job;
    const node: FlowNode = {
      id,
      key,
      type: 'task',
      title,
      ...(n.description || jt?.description ? { intent: n.description ?? jt?.description } : {}),
      status: 'draft',
    };
    if (!jt) {
      this.notes.push(`${label}: the job template "${title}" is not in the source, so no binding.`);
      this.drafts++;
      return node;
    }
    if (jt.playbook) {
      const params = this.clean(n.extraData);
      node.impl = { kind: 'playbook', ref: jt.playbook, ...(params ? { params } : {}) };
      if (this.opts.hasPlaybook(jt.playbook)) node.status = 'implemented';
      else
        this.notes.push(
          `${label}: ${jt.playbook}${jt.project ? ` (project ${jt.project}${jt.scmUrl ? `, ${jt.scmUrl}` : ''})` : ''} is not in this repository: draft; its play cannot load until the playbook is added or the binding changes. With the project checked out here, import again to get its steps.`,
        );
    }
    if (node.status === 'implemented') this.implemented++;
    else this.drafts++;
    const settings = this.settings(n);
    if (settings) node.settings = settings;
    return node;
  }

  /**
   * A job template node as a subflow of its playbook's steps (AFD-26): the playbook imported as is,
   * its start and ends replaced by the subflow's entry and exits. The node's credential, EE, limit
   * and tags stay on the subflow; become, timeout and the node's extra vars reach every step.
   */
  private expand(
    n: WorkflowNodeSource,
    book: PlaybookForm,
    at: { id: Ulid; key: string; title: string; label: string },
  ): FlowNode {
    const sub = importPlaybook(book, {
      key: this.opts.key,
      newId: this.opts.newId,
      generatedDir: `flows/${this.opts.key}/generated`,
    });
    const doc = sub.doc;
    const ends = new Map(
      doc.nodes.filter((x) => x.type === 'start' || x.type === 'end').map((x) => [x.id, x]),
    );
    const start = doc.nodes.find((x) => x.type === 'start');
    const entry = doc.edges.find((e) => e.from.node === start?.id)?.to.node;
    const outputs: Record<string, BoundaryExit[]> = {};
    for (const e of doc.edges) {
      const end = ends.get(e.to.node);
      if (!end || ends.has(e.from.node)) continue;
      const failed = end.outcome === 'failed';
      const exit = failed ? 'failed_hosts' : 'ok_hosts';
      outputs[exit] = [
        ...(outputs[exit] ?? []),
        { ...e.from, ...(failed && end.intent ? { reason: end.intent } : {}) },
      ];
    }
    const nodes = doc.nodes.filter((x) => !ends.has(x.id));
    const edges = doc.edges.filter((e) => !ends.has(e.from.node) && !ends.has(e.to.node));
    const jt = n.job;
    const extra = this.clean(n.extraData);
    const visit = (list: FlowNode[]) => {
      for (const x of list) {
        if (x.subflow?.nodes) visit(x.subflow.nodes);
        if (x.type !== 'task') continue;
        const s: NodeSettings = { ...x.settings };
        if (jt?.become) s.become = true;
        if (jt?.timeout && !s.timeout) s.timeout = duration(jt.timeout);
        if (Object.keys(s).length) x.settings = s;
        // The node's extra vars outrank everything in AWX: task vars (role vars for roles).
        if (extra && x.impl?.kind === 'role') x.impl.params = { ...x.impl.params, ...extra };
        else if (extra && x.impl)
          x.impl.keywords = {
            ...x.impl.keywords,
            vars: { ...(x.impl.keywords?.vars as Record<string, unknown> | undefined), ...extra },
          };
      }
    };
    visit(nodes);
    for (const [k, f] of Object.entries(doc.flow.inputs ?? {}))
      if (!f.targets && !(k in this.playbookInputs)) this.playbookInputs[k] = f;
    this.notes.push(...sub.notes.map((note) => `${at.label} (${jt?.playbook}): ${note}`));
    this.steps += sub.counts.steps;
    this.implemented += sub.counts.implemented;
    this.drafts += sub.counts.drafts;
    const { timeout: _t, become: _b, ...settings } = this.settings(n) ?? {};
    return {
      id: at.id,
      key: at.key,
      type: 'subflow',
      title: at.title,
      intent: n.description ?? jt?.description ?? `Runs ${jt?.playbook} (job template ${at.title})`,
      status: sub.counts.drafts === 0 ? 'implemented' : 'draft',
      ...(Object.keys(settings).length ? { settings } : {}),
      subflow: {
        nodes,
        edges,
        boundary: {
          ...(entry ? { in: entry } : {}),
          ...(Object.keys(outputs).length ? { outputs } : {}),
        },
      },
    };
  }

  private settings(n: WorkflowNodeSource): NodeSettings | undefined {
    const jt = n.job;
    const s: NodeSettings = {};
    if (jt?.timeout) s.timeout = duration(jt.timeout);
    if (jt?.become) s.become = true;
    const machine = jt?.credentials.find((c) => c.kind === 'ssh' || c.kind === 'net');
    const credential =
      n.credentials?.[0] ??
      machine?.name ??
      jt?.credentials.find((c) => c.kind !== 'vault' && !c.kind?.startsWith('cloud'))?.name;
    if (credential) s.credential = credential;
    if (jt?.executionEnvironment) s.execution_environment = jt.executionEnvironment;
    const target = n.limit ?? jt?.limit;
    if (target) s.inventory_target = target;
    const tags = n.jobTags
      ?.split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags?.length) s.tags = tags;
    return Object.keys(s).length ? s : undefined;
  }
}

export function importWorkflow(src: WorkflowSource, opts: ImportOptions): ImportResult {
  return new Importer(opts).run(src);
}
