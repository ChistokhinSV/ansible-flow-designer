// What a repository tells catalog search (M5, 07 §2): the collections it uses, most used first, and
// the network platforms of its inventory. Pure: file texts in, SearchContext out.
import { parse } from 'yaml';
import { platformCollection } from './rank';
import type { SearchContext } from './types';

export interface RepoFile {
  /** Path relative to the repository root, forward slashes. */
  path: string;
  text: string;
}

/** Task keys that are FQCNs: `cisco.ios.ios_config:` (a list item or a mapping key). */
const TASK_FQCN = /^[ \t]*(?:- [ \t]*)?([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\.[a-z][a-z0-9_]*:/gm;
const NETWORK_OS = /ansible_network_os[ \t]*[:=][ \t]*["']?([A-Za-z][A-Za-z0-9_.]*)/g;
/** Keys that make a YAML file a playbook rather than a task list or vars. */
const PLAY_KEY = /^- [ \t]*(?:hosts|import_playbook|ansible\.builtin\.import_playbook):/m;
/** A flow binding: `ref: cisco.ios.ios_config` under a node's impl. */
const BINDING = /\bref:[ \t]*["']?([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)/g;

/** Weights: a requirements entry says more than one task, a flow binding more than a task. */
const REQUIRED = 5;
const BOUND = 3;

function requirements(text: string): string[] {
  try {
    const data = parse(text) as { collections?: (string | { name?: string })[] } | null;
    return (data?.collections ?? [])
      .map((c) => (typeof c === 'string' ? c : (c?.name ?? '')))
      .filter((c) => /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(c));
  } catch {
    return [];
  }
}

/**
 * Collections by use (requirements files, FQCN task keys, bindings in *.flow.yaml) and platform
 * collections from `ansible_network_os` anywhere in inventories and vars. ansible.builtin is left
 * out: search ranks it as the base layer anyway.
 */
export function scanContext(files: RepoFile[]): Required<Omit<SearchContext, 'types'>> {
  const score = new Map<string, number>();
  const add = (c: string, n: number) => score.set(c, (score.get(c) ?? 0) + n);
  const platforms = new Set<string>();
  const bindings: string[] = [];
  for (const f of files) {
    if (f.path.endsWith('.flow.yaml'))
      for (const m of f.text.matchAll(BINDING)) bindings.push(m[1] ?? '');
    if (/(^|\/)requirements\.ya?ml$/.test(f.path))
      for (const c of requirements(f.text)) add(c, REQUIRED);
    for (const m of f.text.matchAll(TASK_FQCN)) add(m[1] ?? '', 1);
    for (const m of f.text.matchAll(NETWORK_OS)) {
      const c = platformCollection(m[1] ?? '');
      if (c) platforms.add(c);
    }
  }
  for (const fqcn of bindings) {
    const parts = fqcn.split('.');
    if (parts.length >= 3) add(parts.slice(0, 2).join('.'), BOUND);
  }
  score.delete('ansible.builtin');
  const collections = [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([c]) => c);
  return { collections, platforms: [...platforms].sort() };
}

/** A playbook (plays or imports at the top level), not a task file or vars. */
export function isPlaybook(file: RepoFile): boolean {
  if (/(^|\/)(roles|group_vars|host_vars|collections|flows)\//.test(file.path)) return false;
  return PLAY_KEY.test(file.text);
}
