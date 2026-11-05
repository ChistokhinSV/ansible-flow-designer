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
  has: ['no-binding', 'binding', 'problems', 'errors'],
  open: ['fail'],
  tag: [],
  target: [],
};

/** What the Find box's offers list, in words (AFD-89: the syntax alone said little). */
export const FILTER_MEANING: Record<string, string> = {
  'has:no-binding': 'Steps not implemented yet: no module, role or playbook',
  'has:binding': 'Steps bound to a module, role or playbook',
  'has:errors': 'Steps with an error',
  'has:problems': 'Steps with an error or a warning',
  'type:approval': 'Approval steps',
  'open:fail': 'Steps with a fail port nothing handles',
  'status:draft': 'Draft steps, and subflows with a draft step inside',
};

/** What a single filter lists, counted (AFD-93: round 2, S7, the list did not say what it held). */
const COUNTED: Record<string, readonly [string, string]> = {
  'has:no-binding': ['step not implemented yet', 'steps not implemented yet'],
  'has:binding': [
    'step bound to a module, role or playbook',
    'steps bound to a module, role or playbook',
  ],
  'has:errors': ['step with an error', 'steps with an error'],
  'has:problems': ['step with an error or a warning', 'steps with an error or a warning'],
  'open:fail': ['step with a fail port nothing handles', 'steps with a fail port nothing handles'],
};

/**
 * "4 steps not implemented yet": a query of one filter says what its results are. Statuses count
 * subflows too, since a subflow's status is its least finished step's. Words, or several filters,
 * say nothing more than the count.
 */
export function findSummary(query: string, count: number): string | undefined {
  const q = parseFind(query);
  const filters = Object.entries(q.filters);
  if (q.words.length || filters.length !== 1) return undefined;
  const [key, values] = filters[0] as [FilterKey, string[]];
  if (values.length !== 1) return undefined;
  const value = values[0] as string;
  const one = count === 1;
  const counted = COUNTED[`${key}:${value}`];
  if (counted) return `${count} ${one ? counted[0] : counted[1]}`;
  if (key === 'type') return `${count} ${value}${one ? '' : 's'}`;
  if (key === 'status')
    return `${count} ${value} ${one ? 'step or subflow' : 'steps and subflows'}`;
  return undefined;
}

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
      // AFD-89: the steps whose card says "not implemented yet" (nodeFace): `status:draft` also
      // lists every subflow with such a step inside, so it does not answer "which steps".
      v === 'no-binding'
        ? node.type === 'task' && !node.impl
        : v === 'binding'
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
