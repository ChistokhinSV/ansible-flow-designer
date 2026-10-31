// The binding being configured in the properties view (M5, mockup 11): staged in the webview and
// written by "Save binding" as one setBinding command. Pure, so the form, the checklist and the
// generated-task preview are the same functions the tests run.
import { registerName } from '../engine/binding';
import type { FlowCommand } from '../flow/commands';
import { enclosing, liftOf, upstreamNodes } from '../flow/dataRefs';
import { refsIn } from '../flow/jinja';
import type { FlowModel } from '../flow/model';
import type { ContractField, ContractType, FlowNode, ImplBinding, NodeStatus } from '../flow/types';
import { MAGIC_VARS } from '../flow/validate';
import type { CatalogOption, CatalogPlugin, CatalogReturn } from './types';

export type BindKind = ImplBinding['kind'];

export interface BindingDraft {
  kind: BindKind;
  ref: string;
  collection_version?: string;
  params: Record<string, unknown>;
  register: string;
  /** Contract fields the binding adds or changes (chips, returns); null removes one. */
  inputs: Record<string, ContractField | null>;
  outputs: Record<string, ContractField | null>;
}

export function draftOf(node: FlowNode): BindingDraft {
  const impl = node.impl;
  return {
    kind: impl?.kind ?? 'module',
    ref: impl?.ref ?? '',
    collection_version: impl?.collection_version,
    params: structuredClone(impl?.params ?? {}),
    register: impl?.kind === 'module' || !impl ? registerName(node, impl) : '',
    inputs: {},
    outputs: {},
  };
}

const empty = (v: unknown) => v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** The binding as it would be stored; null while nothing is chosen. */
export function draftImpl(d: BindingDraft): ImplBinding | null {
  if (!d.ref.trim()) return null;
  const params = Object.fromEntries(Object.entries(d.params).filter(([, v]) => !empty(v)));
  return {
    kind: d.kind,
    ref: d.ref.trim(),
    ...(d.kind === 'module' && d.collection_version
      ? { collection_version: d.collection_version }
      : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(d.kind === 'module' && d.register ? { register: d.register } : {}),
  };
}

function merge(
  base: Record<string, ContractField> | undefined,
  patch: Record<string, ContractField | null>,
): Record<string, ContractField> | undefined {
  const out: Record<string, ContractField> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The node as it will be after Save binding (preview, checklist). */
export function stagedNode(node: FlowNode, d: BindingDraft): FlowNode {
  const impl = draftImpl(d);
  // Save binding keeps the task keywords (AFD-26); playbook bindings take none.
  const keywords = impl && impl.kind !== 'playbook' ? node.impl?.keywords : undefined;
  return {
    ...node,
    impl: impl && keywords ? { ...impl, keywords } : impl,
    inputs: merge(node.inputs, d.inputs),
    outputs: merge(node.outputs, d.outputs),
  };
}

export function isDirty(node: FlowNode, d: BindingDraft): boolean {
  const staged = stagedNode(node, d);
  return (
    JSON.stringify(staged.impl ?? null) !== JSON.stringify(node.impl ?? null) ||
    JSON.stringify(staged.inputs ?? null) !== JSON.stringify(node.inputs ?? null) ||
    JSON.stringify(staged.outputs ?? null) !== JSON.stringify(node.outputs ?? null)
  );
}

/** Save binding: one command; a bound node is implemented, an unbound one back to specified. */
export function bindingCommand(node: FlowNode, d: BindingDraft): FlowCommand {
  const impl = draftImpl(d);
  const current: NodeStatus = node.status ?? 'draft';
  let status: NodeStatus | undefined;
  if (impl) status = current === 'implemented' && !isDirty(node, d) ? undefined : 'implemented';
  else if (current === 'implemented' || current === 'tested') status = 'specified';
  const changed = (patch: Record<string, ContractField | null>, side: 'inputs' | 'outputs') =>
    Object.fromEntries(
      Object.entries(patch).filter(
        ([k, v]) => JSON.stringify(v) !== JSON.stringify(node[side]?.[k] ?? null),
      ),
    );
  return {
    kind: 'setBinding',
    id: node.id,
    impl,
    inputs: changed(d.inputs, 'inputs'),
    outputs: changed(d.outputs, 'outputs'),
    ...(status && status !== current ? { status } : {}),
  };
}

// ---- form ---------------------------------------------------------------------------------------

export type Control = 'bool' | 'choice' | 'list' | 'number' | 'text' | 'yaml';

export interface FormField {
  name: string;
  option: CatalogOption;
  control: Control;
  required: boolean;
}

export function controlOf(o: CatalogOption): Control {
  if (o.type === 'bool' || o.type === 'boolean') return 'bool';
  if (o.choices && o.choices.length > 0 && o.type !== 'list') return 'choice';
  if (o.type === 'list' && (!o.elements || o.elements === 'str') && !o.suboptions) return 'list';
  if (o.type === 'int' || o.type === 'float') return 'number';
  if (o.type === 'dict' || o.type === 'list' || o.type === 'json' || o.suboptions) return 'yaml';
  return 'text';
}

/** Required and already set parameters first; the rest behind "Show N more" (mockup 11). */
export function formFields(
  options: Record<string, CatalogOption> | undefined,
  params: Record<string, unknown>,
): { shown: FormField[]; more: FormField[] } {
  const all = Object.entries(options ?? {}).map(([name, option]) => ({
    name,
    option,
    control: controlOf(option),
    required: !!option.required && option.default === undefined,
  }));
  const set = (f: FormField) =>
    f.required || !empty(params[f.name]) || (f.option.aliases ?? []).some((a) => !empty(params[a]));
  return { shown: all.filter(set), more: all.filter((f) => !set(f)) };
}

const RETURN_TYPES: Record<string, ContractType> = {
  str: 'string',
  string: 'string',
  int: 'integer',
  integer: 'integer',
  float: 'any',
  bool: 'boolean',
  boolean: 'boolean',
  list: 'list',
  dict: 'dict',
  complex: 'dict',
};

export function contractTypeOf(ret: Pick<CatalogReturn, 'type'>): ContractType {
  return RETURN_TYPES[ret.type] ?? 'any';
}

// ---- checklist ----------------------------------------------------------------------------------

export interface CheckItem {
  state: 'ok' | 'warn' | 'missing';
  text: string;
}

/** What the binding still needs and what to know about it (mockup 11 checklist). */
export function checklist(
  model: FlowModel,
  staged: FlowNode,
  doc: { plugin?: CatalogPlugin | null; roleSpec?: boolean; playbookTargets?: boolean },
): CheckItem[] {
  const impl = staged.impl;
  if (!impl) return [{ state: 'missing', text: 'Choose a module, role or playbook' }];
  const items: CheckItem[] = [];
  const plugin = doc.plugin;
  if (impl.kind === 'module' && plugin) {
    const params = impl.params ?? {};
    const given = new Set(Object.keys(params));
    const missing = Object.entries(plugin.options ?? {})
      .filter(([name, o]) => o.required && o.default === undefined && !given.has(name))
      .filter(([, o]) => !(o.aliases ?? []).some((a) => given.has(a)))
      .map(([name]) => name);
    items.push(
      missing.length > 0
        ? { state: 'missing', text: `Required parameters missing: ${missing.join(', ')}` }
        : { state: 'ok', text: 'Required parameters set' },
    );
  }
  for (const name of refsIn(impl.params ?? {})) {
    if (MAGIC_VARS.test(name)) continue;
    const input = staged.inputs?.[name];
    const from = input?.from;
    if (!input) items.push({ state: 'missing', text: `${name} is not an input of this node` });
    else if (from?.startsWith('flow.'))
      items.push({ state: 'ok', text: `${name} comes from flow inputs` });
    else if (from) {
      const key = from.split('.')[0] ?? '';
      const source = [...model.nodes.values()].find((e) => e.node.key === key)?.node;
      items.push({
        state: 'ok',
        text: `${name} comes from ${source ? `"${source.title}"` : from}`,
      });
    } else items.push({ state: 'warn', text: `${name} is an input without a source (from:)` });
  }
  if (impl.kind === 'module' && plugin) {
    const check = plugin.attributes?.check_mode?.support;
    if (check === 'full')
      items.push({ state: 'ok', text: 'Supports check mode, safe in skeleton runs' });
    else if (check === 'partial')
      items.push({ state: 'warn', text: 'Partial check mode support: skeleton runs may differ' });
    else if (check === 'none')
      items.push({ state: 'warn', text: 'No check mode: skeleton runs skip this task' });
    if (plugin.deprecated)
      items.push({ state: 'warn', text: `Deprecated: ${plugin.deprecated.why || 'see the docs'}` });
  }
  if (impl.kind === 'role')
    items.push(
      doc.roleSpec
        ? { state: 'ok', text: 'The role checks its arguments (argument_specs)' }
        : { state: 'warn', text: 'No argument_specs: variables are free-form' },
    );
  if (impl.kind === 'playbook')
    items.push(
      doc.playbookTargets
        ? { state: 'ok', text: 'Its plays target {{ afd_hosts }}, the hosts arriving here' }
        : {
            state: 'warn',
            text: 'Its plays do not target {{ afd_hosts }}: they run on their own hosts',
          },
    );
  return items;
}

// ---- data references ----------------------------------------------------------------------------

export { upstreamNodes };

export interface RefChoice {
  /** The variable the chip reads. */
  name: string;
  label: string;
  detail: string;
  /** Set when choosing it adds a node input. */
  field?: ContractField;
}

function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** What `@` offers (D-26): node inputs, then flow inputs and upstream outputs as new inputs. */
export function refChoices(model: FlowModel, node: FlowNode): RefChoice[] {
  const inputs = node.inputs ?? {};
  const taken = new Set(Object.keys(inputs));
  const sources = new Set(Object.values(inputs).map((f) => f?.from));
  const out: RefChoice[] = Object.entries(inputs).map(([name, f]) => ({
    name,
    label: name,
    detail: f?.from ? `input from ${f.from}` : 'node input',
  }));
  for (const [name, f] of Object.entries(model.doc.flow?.inputs ?? {})) {
    const from = `flow.${name}`;
    if (sources.has(from) || f?.type === 'host_list') continue;
    const as = freeName(name, taken);
    taken.add(as);
    out.push({
      name: as,
      label: from,
      detail: 'flow input · adds a node input',
      field: { type: f?.type ?? 'any', from },
    });
  }
  const offer = (name: string, from: string, detail: string, type: ContractField['type']) => {
    if (sources.has(from)) return;
    sources.add(from);
    const as = freeName(name, taken);
    taken.add(as);
    out.push({ name: as, label: from, detail, field: { type, from } });
  };
  // Inside a subflow, `<subflow>.<input>` reads the subflow's input (AFD-21).
  const at = model.nodes.get(node.id)?.level;
  for (const sub of at ? enclosing(model, at) : [])
    for (const [name, f] of Object.entries(sub.inputs ?? {}))
      offer(
        name,
        `${sub.key}.${name}`,
        `input of subflow "${sub.title}" · adds a node input`,
        f?.type ?? 'any',
      );
  const upstream = upstreamNodes(model, node.id);
  for (const up of upstream)
    for (const [name, f] of Object.entries(up.outputs ?? {}))
      offer(
        name,
        `${up.key}.${name}`,
        `output of "${up.title}" · adds a node input`,
        f?.type ?? 'any',
      );
  // Outputs of steps inside earlier subflows: choosing one lifts it to the subflow (AFD-21).
  const inside = (sub: FlowNode, path: string): void => {
    for (const step of sub.subflow?.nodes ?? []) {
      if (!step?.key) continue;
      const at = `${path}/${step.key}`;
      for (const [name, f] of Object.entries(step.outputs ?? {})) {
        // Already lifted: the subflow's own output is offered above.
        const lifted = Object.keys(sub.outputs ?? {}).some((o) => {
          const l = liftOf(sub, o);
          return !!l && 'inner' in l && l.inner.id === step.id && l.output === name;
        });
        if (lifted) continue;
        offer(
          name,
          `${at}.${name}`,
          `output of "${step.title}" inside "${sub.title}" · lifts it to ${path.split('/')[0]}`,
          f?.type ?? 'any',
        );
      }
      if (step.subflow) inside(step, at);
    }
  };
  for (const up of upstream) if (up.type === 'subflow') inside(up, up.key);
  return out;
}
