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
  const words = wordsOf(q);
  const seen = new Set<string>();
  const once = (ref: string) => (seen.has(ref) ? false : !!seen.add(ref));
  const named = (ref: string) => words.every((w) => ref.toLowerCase().includes(w));
  // What the flow already uses comes first among equal matches: it is the likelier pick.
  const used: Suggestion[] = input.used
    .filter((u) => named(u.ref) && once(`${u.kind}:${u.ref}`))
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
    .filter((r) => named(r) && once(`role:${r}`))
    .slice(0, MAX_ROLES)
    .map((r) => ({ kind: 'role', ref: r, label: r, hint: 'role' }));
  // AFD-360: by how well the name matches, then in that order: the role push_baseline typed in
  // full came sixth, after five modules the catalog only found for its words.
  const found = [...used, ...modules, ...roles]
    .map((s, i) => ({ s, i, rank: s.kind === 'type' ? 9 : matchRank(s.ref, s.hint, words) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.s);
  return [...types, ...found];
}

/** The words of what is typed: `show running`, `push_baseline` and `push-baseline` alike. */
function wordsOf(q: string): string[] {
  return q.split(/[\s._/-]+/).filter(Boolean);
}

/**
 * AFD-360: how well a module or role matches the words typed, best first: its own name exactly
 * (`push_baseline`), its name starting with them, every word in its name, every word in what it
 * does, else only what the catalog's search found (`run` for "running").
 */
export function matchRank(ref: string, about: string, words: readonly string[]): number {
  if (words.length === 0) return 4;
  const full = ref.toLowerCase();
  const name = full.split(/[./]/).pop() ?? full;
  const joined = words.join('_');
  if (name === joined || name.replace(/-/g, '_') === joined || full === words.join('.')) return 0;
  if (name.startsWith(words[0] as string) && words.every((w) => name.includes(w))) return 1;
  if (words.every((w) => full.includes(w))) return 2;
  const text = about.toLowerCase();
  if (words.every((w) => text.includes(w))) return 3;
  return 4;
}

/**
 * A title for a step bound from the list: `ansible.builtin.ping` reads "Ping". AFD-328: a module
 * named after its collection's platform keeps the platform's capitals: `cisco.ios.ios_config`
 * reads "IOS config", `arista.eos.eos_banner` "EOS banner".
 */
export function titleFor(ref: string): string {
  const parts = ref.split(/[./]/);
  const name = (parts.pop() ?? ref).replace(/[_-]+/g, ' ').trim();
  if (!name) return ref;
  const [first = '', ...rest] = name.split(' ');
  const platform = parts.length >= 2 && first === parts[parts.length - 1] && rest.length > 0;
  if (platform) return [first.toUpperCase(), ...rest].join(' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * AFD-328: the suggestion Enter picks while nothing is highlighted by the arrows: a module or role
 * whose own name is what was typed (`ping` finds ansible.builtin.ping), or -1 (Enter adds a step
 * with the title as typed).
 */
export function exactMatch(suggestions: readonly Suggestion[], query: string): number {
  const q = query
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!q) return -1;
  return suggestions.findIndex(
    (s) =>
      s.kind !== 'type' &&
      (s.ref.toLowerCase() === q || s.ref.toLowerCase().split(/[./]/).pop() === q),
  );
}

/**
 * AFD-334: the row Enter picks while the arrows have not moved: the exact match, else the first
 * module or role listed (a step type only by the arrows: picking one clears the title). -1 when
 * nothing is typed or nothing is listed: Enter then adds the step as typed.
 */
export function defaultPick(suggestions: readonly Suggestion[], query: string): number {
  if (!query.trim()) return -1;
  const exact = exactMatch(suggestions, query);
  if (exact >= 0) return exact;
  return suggestions.findIndex((s) => s.kind !== 'type');
}

/**
 * AFD-328: the title a step gets when a module or role is picked for it. A title typed as a name
 * stays; text that only searched for the pick (its words are in the reference) gives way to a title
 * made from it.
 */
export function titleAfterPick(typed: string, ref: string): string {
  const words = typed
    .trim()
    .toLowerCase()
    .split(/[\s._/-]+/)
    .filter(Boolean);
  const name = ref.toLowerCase();
  const search = words.length === 0 || words.every((w) => name.includes(w));
  return search ? titleFor(ref) : typed.trim();
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
