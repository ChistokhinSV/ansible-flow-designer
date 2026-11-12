// AFD-232: what Quick Add lists under its Title field. The field is a name first: typing one and
// pressing Enter adds a step, as before. The list is what else the text could mean: a step type
// whose name starts with it, modules the catalog finds for it, roles whose name holds it; while the
// field is empty, what the flow already runs. Pure, so the order is tested without the dialog.
import type { SearchHit } from '../catalog/types';
import type { FlowModel } from '../flow/model';
import type { NodeType } from '../flow/types';

export type Suggestion =
  | { kind: 'type'; type: NodeType; label: string; hint: string }
  | { kind: 'module' | 'role'; ref: string; label: string; hint: string };

export interface SuggestInput {
  /** What is typed in the Title field. */
  query: string;
  /** The type picked in the dialog: modules and roles are offered for a task. */
  type: NodeType;
  /** The types the dialog allows here, with their labels. */
  types: { type: NodeType; label: string }[];
  /** The catalog's answer for `query`. */
  modules: Pick<SearchHit, 'fqcn' | 'short_description' | 'dimmed'>[];
  roles: string[];
  /** What the flow already runs, latest first (`usedBindings`). */
  used: { kind: 'module' | 'role'; ref: string }[];
}

const MAX_MODULES = 6;
const MAX_ROLES = 3;
const MAX_USED = 6;

export function suggestSteps(input: SuggestInput): Suggestion[] {
  const q = input.query.trim().toLowerCase();
  const task = input.type === 'task';
  if (!q)
    return task
      ? input.used.slice(0, MAX_USED).map((u) => ({
          kind: u.kind,
          ref: u.ref,
          label: u.ref,
          hint: `${u.kind}, used in this flow`,
        }))
      : [];
  const types: Suggestion[] = input.types
    .filter((t) => t.type !== input.type && t.label.toLowerCase().startsWith(q))
    .map((t) => ({ kind: 'type', type: t.type, label: t.label, hint: 'step type' }));
  if (!task) return types;
  const seen = new Set<string>();
  const once = (ref: string) => (seen.has(ref) ? false : !!seen.add(ref));
  // What the flow already uses comes first among the matches: it is the likelier pick.
  const used: Suggestion[] = input.used
    .filter((u) => u.ref.toLowerCase().includes(q) && once(`${u.kind}:${u.ref}`))
    .slice(0, MAX_ROLES)
    .map((u) => ({ kind: u.kind, ref: u.ref, label: u.ref, hint: `${u.kind}, used in this flow` }));
  const modules: Suggestion[] = input.modules
    .filter((m) => !m.dimmed && once(`module:${m.fqcn}`))
    .slice(0, MAX_MODULES)
    .map((m) => ({
      kind: 'module',
      ref: m.fqcn,
      label: m.fqcn,
      hint: m.short_description || 'module',
    }));
  const roles: Suggestion[] = input.roles
    .filter((r) => r.toLowerCase().includes(q) && once(`role:${r}`))
    .slice(0, MAX_ROLES)
    .map((r) => ({ kind: 'role', ref: r, label: r, hint: 'role' }));
  return [...types, ...used, ...modules, ...roles];
}

/** A title for a step bound from the list: `cisco.ios.ios_config` reads "Ios config". */
export function titleFor(ref: string): string {
  const name = (ref.split(/[./]/).pop() ?? ref).replace(/[_-]+/g, ' ').trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : ref;
}

/** The modules and roles the flow's steps are bound to, the latest step's first. */
export function usedBindings(model: FlowModel): { kind: 'module' | 'role'; ref: string }[] {
  const found = new Map<string, { kind: 'module' | 'role'; ref: string }>();
  for (const { node } of model.nodes.values()) {
    const impl = node.impl;
    if (!impl?.ref || (impl.kind !== 'module' && impl.kind !== 'role')) continue;
    const key = `${impl.kind}:${impl.ref}`;
    found.delete(key);
    found.set(key, { kind: impl.kind, ref: impl.ref });
  }
  return [...found.values()].reverse();
}
