// Find filters (AFD-86, wave 8 group D): `type:approval status:draft open:fail` and the like, beside
// words. Round 1's participant spent 16.8 minutes opening every level to list the steps without an
// implementation and the approvals (P9); a filter lists them across levels at once. Pure.
import type { OpenPort } from '../flow/openPorts';
import type { FlowNode, NodeStatus } from '../flow/types';
import type { Finding } from '../flow/validate';

export const FILTER_KEYS = ['type', 'status', 'has', 'open', 'tag', 'target'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

/** What each filter takes, for the Find box's hint and completions. */
export const FILTER_VALUES: Record<FilterKey, readonly string[]> = {
  type: ['task', 'subflow', 'decision', 'approval', 'parallel', 'join', 'end'],
  status: ['draft', 'specified', 'implemented', 'tested'],
  has: ['binding', 'problems', 'errors'],
  open: ['fail'],
  tag: [],
  target: [],
};

export interface FindQuery {
  /** Words to match in titles, keys and bindings. */
  words: string[];
  /** Per filter, the values asked for (any of them matches). */
  filters: Partial<Record<FilterKey, string[]>>;
}

const TOKEN = /([A-Za-z]+):"([^"]*)"|([A-Za-z]+):(\S+)|"([^"]*)"|(\S+)/g;

/** Words and filters; an unknown `x:y` and a filter with no value stay words. */
export function parseFind(query: string): FindQuery {
  const words: string[] = [];
  const filters: FindQuery['filters'] = {};
  for (const m of query.matchAll(TOKEN)) {
    const key = (m[1] ?? m[3])?.toLowerCase() as FilterKey | undefined;
    const value = m[2] ?? m[4];
    if (key && value !== undefined && value !== '' && FILTER_KEYS.includes(key)) {
      filters[key] = [...(filters[key] ?? []), value.toLowerCase()];
      continue;
    }
    const word = (m[5] ?? m[0]).toLowerCase();
    if (word) words.push(...word.split(/\s+/).filter(Boolean));
  }
  return { words, filters };
}

export const hasFilters = (q: FindQuery) => Object.keys(q.filters).length > 0;

/** What a filter needs beyond the node: the flow's findings and open fail ports. */
export interface FindContext {
  findings?: readonly Finding[];
  openPorts?: readonly OpenPort[];
}

/** The node passes every filter asked for (within one filter, any value). */
export function matchesFilters(node: FlowNode, q: FindQuery, ctx: FindContext = {}): boolean {
  const any = (key: FilterKey, test: (v: string) => boolean) => {
    const values = q.filters[key];
    return !values || values.some(test);
  };
  const status: NodeStatus = node.status ?? 'draft';
  const mine = (ctx.findings ?? []).filter((f) => f.node === node.id);
  return (
    any('type', (v) => node.type === v || (v === 'handler' && !!node.purpose)) &&
    // Status applies to steps; start and end nodes have none to speak of.
    any('status', (v) => node.type !== 'start' && node.type !== 'end' && status === v) &&
    any('has', (v) =>
      v === 'binding'
        ? !!node.impl
        : v === 'problems'
          ? mine.length > 0
          : v === 'errors'
            ? mine.some((f) => f.severity === 'error')
            : false,
    ) &&
    any('open', (v) => v === 'fail' && (ctx.openPorts ?? []).some((p) => p.node === node.id)) &&
    any('tag', (v) => (node.settings?.tags ?? []).some((t) => t.toLowerCase() === v)) &&
    any('target', (v) => (node.settings?.inventory_target ?? '').toLowerCase().includes(v))
  );
}

/** Completions for the word being typed: filter names, then a filter's values. */
export function findCompletions(text: string): string[] {
  const last = text.split(/\s+/).at(-1) ?? '';
  const [key, value] = last.includes(':') ? last.split(':', 2) : [last, undefined];
  if (value === undefined)
    return last
      ? FILTER_KEYS.filter((k) => k.startsWith(last.toLowerCase())).map((k) => `${k}:`)
      : [];
  const values = FILTER_VALUES[key?.toLowerCase() as FilterKey] ?? [];
  return values.filter((v) => v.startsWith((value ?? '').toLowerCase())).map((v) => `${key}:${v}`);
}
