// Design vs code (M6, D-29, 05 "Code to design"): matches generated plays to nodes by their
// `node_<ULID>` tag (D-28), compares bindings with the code they run, and lists drift both ways.
// Nothing here resolves anything: every item carries a design-side and a code-side action.

import { acceptedAll } from '../flow/decisions';
import { type FlowModel, modelOf } from '../flow/model';
import { isFailPort } from '../flow/ports';
import type { ContractField, ContractType, FlowDocument, FlowNode, Ulid } from '../flow/types';
import { roleName } from './stub';
import type {
  CodeOrigin,
  CodePlay,
  CodeScan,
  CodeTask,
  CompiledRole,
  DriftAction,
  DriftItem,
  DriftReport,
  NodeCode,
} from './types';

const NODE_TAG = /^node_([0-9A-HJKMNP-TV-Z]{26})$/;
const MAX_CHOICES = 3;
/** The binding changed after the last sync: its code was not compiled yet. */
const NOT_SCANNED = 'not scanned';

const SPEC_TYPES: Record<string, ContractType> = {
  str: 'string',
  raw: 'any',
  path: 'string',
  int: 'integer',
  float: 'any',
  bool: 'boolean',
  list: 'list',
  dict: 'dict',
};

export function tasksFromOf(node: FlowNode): string | null {
  const t = node.impl?.params?.tasks_from;
  return typeof t === 'string' && t ? t : null;
}

function compiledRole(
  scan: CodeScan,
  name: string,
  tasksFrom: string | null,
): CompiledRole | undefined {
  return scan.roles.find((r) => r.name === name && (r.tasks_from ?? null) === tasksFrom);
}

/** Variables a role leaves behind for later plays: registers, set_fact and set_stats keys. */
function produced(tasks: CodeTask[]): string[] {
  const out = new Set<string>();
  for (const t of tasks) for (const v of [...t.register, ...t.facts, ...t.stats]) out.add(v);
  return [...out];
}

const list = (names: string[]) => names.map((n) => `\`${n}\``).join(', ');

function firstOrigin(tasks: CodeTask[], pick?: (t: CodeTask) => boolean): CodeOrigin | undefined {
  return (
    (tasks.find((t) => t.origin && (!pick || pick(t))) ?? tasks.find((t) => t.origin))?.origin ??
    undefined
  );
}

function wiredFromFailPort(model: FlowModel, node: FlowNode): boolean {
  const entry = model.nodes.get(node.id);
  const edges = entry ? (model.levels.get(entry.level)?.edges ?? []) : [];
  return edges.some((e) => e?.to?.node === node.id && isFailPort(e.from?.port ?? ''));
}

function hasIncoming(model: FlowModel, node: FlowNode): boolean {
  const entry = model.nodes.get(node.id);
  const level = entry ? model.levels.get(entry.level) : undefined;
  if (!level) return false;
  if (level.edges.some((e) => e?.to?.node === node.id)) return true;
  const parent = level.parent ? model.nodes.get(level.parent)?.node : undefined;
  return parent?.subflow?.boundary?.in === node.id;
}

/** The tasks of the node's binding, as the scan compiled them. */
function nodeCode(scan: CodeScan, node: FlowNode, plays: CodePlay[], inner: NodeCode[]): NodeCode {
  const own = plays.find((p) => p.name.startsWith(`[${node.key}]`)) ?? plays[0];
  const base = { node: node.id, matched: plays.length > 0, play: own?.origin ?? undefined };
  const impl = node.impl?.ref ? node.impl : undefined;
  if (node.type === 'subflow' && (node.subflow?.nodes?.length ?? 0) > 0) {
    const tasks = inner.flatMap((c) => c.tasks);
    const steps = `${inner.length} step${inner.length === 1 ? '' : 's'}`;
    return {
      ...base,
      artifact: impl ? `${impl.kind}: ${impl.ref} · ${steps}` : steps,
      tasks,
      dynamic: inner.reduce((n, c) => n + c.dynamic, 0),
    };
  }
  if (!impl) {
    const artifact = node.type === 'task' || node.type === 'subflow' ? 'not bound' : node.type;
    return { ...base, artifact, tasks: [], dynamic: 0 };
  }
  if (impl.kind === 'module') {
    const tasks = plays.flatMap((p) => p.tasks).filter((t) => t.action === impl.ref);
    return { ...base, artifact: `module: ${impl.ref}`, tasks, dynamic: 0 };
  }
  if (impl.kind === 'role') {
    const tf = tasksFromOf(node);
    const role = compiledRole(scan, impl.ref, tf);
    const tasks = (role?.tasks ?? []).filter((t) => !t.auto);
    return {
      ...base,
      artifact: `role: ${impl.ref}${tf ? ` · ${tf}` : ''}`,
      tasks,
      dynamic: tasks.filter((t) => t.dynamic).length,
      missing: role?.error ?? (role ? undefined : NOT_SCANNED),
    };
  }
  const book = scan.playbooks.find((b) => b.path === impl.ref.replace(/^\.\//, ''));
  const tasks = (book?.plays ?? []).flatMap((p) => p.tasks).filter((t) => !t.auto);
  return {
    ...base,
    artifact: `playbook: ${impl.ref.split('/').pop()}`,
    tasks,
    dynamic: tasks.filter((t) => t.dynamic).length,
    missing: book ? book.error : NOT_SCANNED,
  };
}

export function computeDrift(doc: FlowDocument, scan: CodeScan): DriftReport {
  const model = modelOf(doc);
  const items: DriftItem[] = [];
  const ignored = new Map<string, { reason?: string; by?: string }>();
  for (const a of acceptedAll(doc))
    if (a.area === 'drift') ignored.set(`${a.node}|${a.what}`, { reason: a.reason, by: a.by });

  const add = (item: DriftItem) => {
    const mark = item.node ? ignored.get(`${item.node}|${item.id}`) : undefined;
    if (!mark) {
      if (item.node)
        item.actions.push({
          label: 'Accept with Reason…',
          action: { kind: 'ignore', node: item.node, item: item.id },
        });
      items.push(item);
      return;
    }
    items.push({
      ...item,
      ignored: mark,
      actions: [
        {
          label: 'Reopen',
          action: { kind: 'unignore', node: item.node as Ulid, item: item.id },
        },
      ],
    });
  };

  // ---- matching by ID (D-28) -------------------------------------------------------------------
  const tagged = new Map<Ulid, CodePlay[]>();
  const generated = scan.generated;
  for (const play of generated.plays) {
    for (const tag of play.tags) {
      const id = NODE_TAG.exec(tag)?.[1];
      if (!id) continue;
      if (model.nodes.has(id)) tagged.set(id, [...(tagged.get(id) ?? []), play]);
      else
        items.push({
          id: `orphan-play:${id}:${play.name}`,
          kind: 'code_without_design',
          title: play.name,
          label: 'play without a node',
          detail: `\`${play.name}\` is tagged for a node that is not in this flow (node_${id}).`,
          severity: 'warning',
          actions: [
            { label: 'Regenerate', action: { kind: 'regenerate' } },
            ...(play.origin
              ? [
                  {
                    label: 'Open Code',
                    action: { kind: 'openCode', ...play.origin } as DriftAction,
                  },
                ]
              : []),
          ],
        });
    }
  }
  if (generated.error || generated.plays.length === 0) {
    const missing = generated.error === 'not found' || !generated.error;
    items.push({
      id: 'generated',
      kind: 'design_without_code',
      title: model.doc.flow.name,
      label: missing ? 'no generated code' : 'generated code does not compile',
      detail: missing
        ? `${generated.path} does not exist yet: save the flow to generate it.`
        : `${generated.path}: ${generated.error}`,
      severity: 'warning',
      actions: [
        { label: 'Regenerate', action: { kind: 'regenerate' } },
        ...(missing
          ? []
          : [
              {
                label: 'Open Code',
                action: { kind: 'openCode', path: generated.path } as DriftAction,
              },
            ]),
      ],
    });
  }

  // ---- node by node, inner levels first so subflows can sum them ------------------------------
  const nodes: Record<Ulid, NodeCode> = {};
  const flowInputs = model.doc.flow?.inputs ?? {};
  const visit = (node: FlowNode): NodeCode => {
    const inner = (node.subflow?.nodes ?? []).filter((n): n is FlowNode => !!n?.id).map(visit);
    const code = nodeCode(scan, node, tagged.get(node.id) ?? [], inner);
    nodes[node.id] = code;
    return code;
  };
  for (const n of doc.nodes ?? []) if (n?.id) visit(n);

  let matched = 0;
  let matchable = 0;
  for (const { node } of model.nodes.values()) {
    if (node.type === 'start' || node.type === 'end') continue;
    const code = nodes[node.id];
    if (!code) continue;
    matchable++;
    if (code.matched) matched++;
    else if (!generated.error && generated.plays.length > 0)
      add({
        id: `unmatched:${node.id}`,
        kind: 'design_without_code',
        node: node.id,
        title: node.title,
        label: 'not in generated code',
        detail: hasIncoming(model, node)
          ? `No play in ${generated.path} is tagged node_${node.id}: save the flow to regenerate it.`
          : 'Nothing leads to this node, so no play is generated for it.',
        severity: hasIncoming(model, node) ? 'warning' : 'info',
        actions: [
          { label: 'Regenerate', action: { kind: 'regenerate' } },
          { label: 'Open Code', action: { kind: 'openCode', path: generated.path } },
        ],
      });
    checkNode(model, scan, node, code, flowInputs, add);
  }
  return { items, nodes, matched, matchable };
}

function checkNode(
  model: FlowModel,
  scan: CodeScan,
  node: FlowNode,
  code: NodeCode,
  flowInputs: Record<string, ContractField>,
  add: (item: DriftItem) => void,
): void {
  const impl = node.impl?.ref ? node.impl : undefined;
  const hasInner = (node.subflow?.nodes?.length ?? 0) > 0;
  const bindable = node.type === 'task' || (node.type === 'subflow' && !hasInner);
  const id = node.id;
  const title = node.title;

  // Design without code: nothing bound, or the bound role or playbook is missing.
  if (bindable && !impl) {
    add({
      id: `unbound:${id}`,
      kind: 'design_without_code',
      node: id,
      title,
      label: 'no code yet',
      detail: wiredFromFailPort(model, node)
        ? 'Designed and wired to a fail port, but nothing is bound.'
        : 'Nothing is bound: it runs as a TODO stub.',
      severity: 'warning',
      actions: [
        {
          label: 'Generate Stub',
          action: { kind: 'generateStub', node: id, role: roleName(node.key) },
        },
        { label: 'Bind Role', action: { kind: 'bind', node: id, bindKind: 'role' } },
      ],
    });
    return;
  }
  if (!impl) return;
  if (code.missing === NOT_SCANNED) {
    add({
      id: `unscanned:${id}`,
      kind: 'design_without_code',
      node: id,
      title,
      label: 'not scanned yet',
      detail: `${impl.kind} ${impl.ref} was bound after the last sync.`,
      severity: 'info',
      actions: [{ label: 'Re-sync', action: { kind: 'resync' } }],
    });
    return;
  }
  if (impl.kind === 'playbook' && code.missing) {
    add({
      id: `missing:${id}`,
      kind: 'design_without_code',
      node: id,
      title,
      label: 'playbook missing',
      detail: `${impl.ref} ${code.missing === 'not found' ? 'does not exist' : `does not load: ${code.missing}`}.`,
      severity: 'warning',
      actions: [
        { label: 'Bind Playbook', action: { kind: 'bind', node: id, bindKind: 'playbook' } },
      ],
    });
    return;
  }
  if (impl.kind === 'role') {
    const info = scan.roleInfo.find((r) => r.name === impl.ref);
    if (!info || (code.missing && /not found|was not found/i.test(code.missing))) {
      add({
        id: `missing:${id}`,
        kind: 'design_without_code',
        node: id,
        title,
        label: 'role missing',
        detail: `Role ${impl.ref} is not in roles_path.`,
        severity: 'warning',
        actions: [
          { label: 'Create Role', action: { kind: 'generateStub', node: id, role: impl.ref } },
          { label: 'Bind Role', action: { kind: 'bind', node: id, bindKind: 'role' } },
        ],
      });
      return;
    }
    if (hasInner) {
      checkTaskFiles(model, node, info.tasks, add);
      return;
    }
    checkRoleContract(node, code, info, flowInputs, add);
  }
  if (impl.kind === 'module') checkModuleReturns(scan, node, code, add);
}

/** Role task files a subflow's inner steps do not cover (mockup 04 "task not in design"). */
function checkTaskFiles(
  model: FlowModel,
  node: FlowNode,
  files: string[],
  add: (item: DriftItem) => void,
) {
  const role = node.impl?.ref ?? '';
  const covered = new Set(
    [...model.nodes.values()]
      .filter(
        (e) => e.level === node.id && e.node.impl?.kind === 'role' && e.node.impl.ref === role,
      )
      .map((e) => tasksFromOf(e.node) ?? 'main'),
  );
  for (const file of files) {
    if (file === 'main' || covered.has(file)) continue;
    add({
      id: `task-file:${file}`,
      kind: 'code_without_design',
      node: node.id,
      title: node.title,
      label: 'task not in design',
      detail: `\`${file}\` exists in the role but not in the subflow.`,
      severity: 'warning',
      actions: [
        {
          label: 'Add to Subflow',
          action: { kind: 'addToSubflow', subflow: node.id, role, tasksFrom: file },
        },
      ],
    });
  }
}

function checkRoleContract(
  node: FlowNode,
  code: NodeCode,
  info: CodeScan['roleInfo'][number],
  flowInputs: Record<string, ContractField>,
  add: (item: DriftItem) => void,
) {
  const id = node.id;
  const title = node.title;
  const entry = tasksFromOf(node) ?? 'main';
  const tasksFile = `${info.path}/tasks/${entry}.yml`;
  const vars = produced(code.tasks);
  const outputs = node.outputs ?? {};
  const partial =
    code.dynamic > 0 ? ' (dynamic includes are not expanded, so this may be incomplete)' : '';
  // Outputs: a role output is a fact of the output's own name (ADR-0011).
  for (const [name, field] of Object.entries(outputs)) {
    if (field?.from?.startsWith('impl.') || vars.includes(name)) continue;
    const candidates = vars.filter((v) => !(v in outputs)).slice(0, MAX_CHOICES);
    const origin = firstOrigin(
      code.tasks,
      (t) => t.register.length + t.facts.length + t.stats.length > 0,
    );
    add({
      id: `output:${name}`,
      kind: 'contract_mismatch',
      node: id,
      title,
      label: 'outputs differ',
      detail: vars.length
        ? `Design expects ${list([name])}, code registers ${list(vars)}.${partial}`
        : `Design expects ${list([name])}, the role sets no variables.${partial}`,
      severity: code.dynamic > 0 ? 'info' : 'warning',
      actions: [
        ...(candidates.length === 1
          ? [
              {
                label: 'Update Design',
                action: {
                  kind: 'renameOutput',
                  node: id,
                  from: name,
                  to: candidates[0] as string,
                } as DriftAction,
              },
            ]
          : candidates.map((c) => ({
              label: `Use ${c}`,
              action: { kind: 'renameOutput', node: id, from: name, to: c } as DriftAction,
            }))),
        ...(candidates.length === 0
          ? [
              {
                label: 'Remove Output',
                action: { kind: 'removeOutput', node: id, name } as DriftAction,
              },
            ]
          : []),
        { label: 'Open Code', action: { kind: 'openCode', ...(origin ?? { path: tasksFile }) } },
      ],
    });
  }
  const spec = info.entry_points[entry];
  const specFile = `${info.path}/meta/argument_specs.yml`;
  if (!spec) {
    add({
      id: `no-spec:${entry}`,
      kind: 'contract_mismatch',
      node: id,
      title,
      label: 'no argument spec',
      detail: `${info.name} has no argument_specs for \`${entry}\`: its inputs are not checked.`,
      severity: 'info',
      actions: [
        { label: 'Write argument_specs', action: { kind: 'writeSpecs', node: id } },
        { label: 'Open Code', action: { kind: 'openCode', path: tasksFile } },
      ],
    });
    return;
  }
  const inputs = node.inputs ?? {};
  const params = node.impl?.params ?? {};
  for (const [name, opt] of Object.entries(spec.options)) {
    if (!opt.required || opt.default !== undefined || name in inputs || name in params) continue;
    const type = SPEC_TYPES[opt.type] ?? 'any';
    const field: ContractField = {
      type,
      required: true,
      ...(name in flowInputs ? { from: `flow.${name}` } : {}),
    };
    add({
      id: `input-required:${name}`,
      kind: 'contract_mismatch',
      node: id,
      title,
      label: 'inputs differ',
      detail: `The role requires ${list([name])}; the node has no input ${list([name])}.`,
      severity: 'warning',
      actions: [
        { label: 'Update Design', action: { kind: 'addInput', node: id, name, field } },
        { label: 'Open Code', action: { kind: 'openCode', path: specFile } },
      ],
    });
  }
  for (const name of Object.keys(inputs)) {
    if (name in spec.options) continue;
    add({
      id: `input-unknown:${name}`,
      kind: 'contract_mismatch',
      node: id,
      title,
      label: 'input unknown to the role',
      detail: `${list([name])} is not an argument of ${info.name} (${entry}).`,
      severity: 'info',
      actions: [
        { label: 'Update Design', action: { kind: 'removeInput', node: id, name } },
        { label: 'Open Code', action: { kind: 'openCode', path: specFile } },
      ],
    });
  }
}

/** Outputs read from a module result key the module does not return (catalog). */
function checkModuleReturns(
  scan: CodeScan,
  node: FlowNode,
  code: NodeCode,
  add: (item: DriftItem) => void,
) {
  const ref = node.impl?.ref ?? '';
  const returns = scan.moduleReturns?.[ref];
  if (!returns) return;
  for (const [name, field] of Object.entries(node.outputs ?? {})) {
    const key = field?.from?.match(/^impl\.register\.([A-Za-z0-9_]+)/)?.[1];
    if (!key || returns.includes(key)) continue;
    add({
      id: `return:${name}`,
      kind: 'contract_mismatch',
      node: node.id,
      title: node.title,
      label: 'outputs differ',
      detail: `Design reads ${list([key])} from the ${ref} result, which returns ${list(returns)}.`,
      severity: 'warning',
      actions: [
        ...returns.slice(0, MAX_CHOICES).map((r) => ({
          label: `Read ${r}`,
          action: {
            kind: 'setOutputFrom',
            node: node.id,
            name,
            from: `impl.register.${r}`,
          } as DriftAction,
        })),
        ...(code.play
          ? [{ label: 'Open Code', action: { kind: 'openCode', ...code.play } as DriftAction }]
          : []),
      ],
    });
  }
}
