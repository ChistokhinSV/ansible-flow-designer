// Search ranking pieces that need no database: query words, platform collections, badges and the
// re-rank on top of FTS5 bm25 (M5, ADR-0011; tuned on the predecessor's 20 intent queries).
import type { Badge, CatalogPlugin, PluginType, SearchContext } from './types';

const STOP = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'i',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'this',
  'to',
  'use',
  'with',
  'my',
  'all',
  'do',
  'get',
  'only',
]);

/** Words that name a plugin type: "ip address filter" asks for a filter (D-24 intent ranking). */
const TYPE_WORDS: Record<string, PluginType> = {
  filter: 'filter',
  filters: 'filter',
  lookup: 'lookup',
  lookups: 'lookup',
  test: 'test',
  tests: 'test',
  keyword: 'keyword',
  directive: 'keyword',
};

export interface QueryPlan {
  /** Words searched for. */
  words: string[];
  /** Plugin type the query names, if any. */
  type?: PluginType;
  /** Plugin names the words spell (see nameCandidates) → how many words each covers. */
  names?: Map<string, number>;
}

/** Query words: lowercase letters and digits, no stop words; type words become a type hint. */
export function planQuery(query: string): QueryPlan {
  const all = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  const type = all.map((w) => TYPE_WORDS[w]).find(Boolean);
  const words = [...new Set(all.filter((w) => !TYPE_WORDS[w]))];
  return { words: words.length > 0 ? words : [...new Set(all)], type };
}

/**
 * Plugin names the query words spell: each word (user), adjacent words joined by an underscore
 * (json_query, run_once) and the abbreviations they run into (ip address → ipaddr, ipadd…).
 */
export function nameCandidates(words: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of words) out.set(w, 1);
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i] ?? '';
    const b = words[i + 1] ?? '';
    out.set(`${a}_${b}`, 2);
    if (b.length < 3) continue;
    const joined = a + b;
    for (let end = a.length + 3; end <= joined.length; end++) out.set(joined.slice(0, end), 2);
  }
  return out;
}

/** ansible_network_os values → the collection that implements the platform. */
const PLATFORM: Record<string, string> = {
  ios: 'cisco.ios',
  iosxr: 'cisco.iosxr',
  nxos: 'cisco.nxos',
  asa: 'cisco.asa',
  eos: 'arista.eos',
  junos: 'junipernetworks.junos',
  vyos: 'vyos.vyos',
  routeros: 'community.routeros',
  frr: 'frr.frr',
  sonic: 'dellemc.enterprise_sonic',
};

export const PLATFORM_COLLECTIONS: ReadonlySet<string> = new Set(Object.values(PLATFORM));

/** `cisco.ios.ios` or `ios` (ansible_network_os) → `cisco.ios`. */
export function platformCollection(networkOs: string): string | undefined {
  const parts = networkOs.trim().toLowerCase().split('.');
  if (parts.length >= 3) return parts.slice(0, 2).join('.');
  return PLATFORM[parts.at(-1) ?? ''];
}

/** Collections that ship modules for everything: being "in use" says little about a query. */
const GRAB_BAG = new Set(['community.general', 'ansible.posix', 'ansible.netcommon']);

export interface PluginMeta {
  check?: string;
  diff?: string;
  deprecated: boolean;
}

export function metaOf(p: CatalogPlugin): PluginMeta {
  return {
    check: p.attributes?.check_mode?.support,
    diff: p.attributes?.diff_mode?.support,
    deprecated: !!p.deprecated,
  };
}

export function badgesOf(
  p: { type: PluginType; name: string; collection: string },
  meta: PluginMeta,
  ctx: SearchContext,
): Badge[] {
  const out: Badge[] = [];
  if (meta.check === 'full') out.push('check-mode');
  else if (meta.check === 'partial') out.push('check-mode-partial');
  else if (meta.check === 'none') out.push('no-check-mode');
  if (meta.diff === 'full' || meta.diff === 'partial') out.push('diff');
  if (p.type === 'module' && /(_facts|_info|_command|^ping|^stat)$/.test(p.name))
    out.push('read-only');
  if (isOtherPlatform(p.collection, ctx)) out.push('other-platform');
  if (meta.deprecated) out.push('deprecated');
  return out;
}

/**
 * The network platforms in play: the inventory's (ansible_network_os), else the platform
 * collections the repository already uses (cisco.ios in use → nxos modules are another platform).
 */
export function platformsOf(ctx: SearchContext): string[] {
  if (ctx.platforms?.length) return ctx.platforms;
  return (ctx.collections ?? []).filter((c) => PLATFORM_COLLECTIONS.has(c));
}

export function isOtherPlatform(collection: string, ctx: SearchContext): boolean {
  const platforms = platformsOf(ctx);
  return (
    platforms.length > 0 && PLATFORM_COLLECTIONS.has(collection) && !platforms.includes(collection)
  );
}

export interface Candidate {
  type: PluginType;
  name: string;
  collection: string;
  /** Bit i: query word i (crude stem) is in the name words, summary or option names. */
  inStrong: number;
  /** Bit i: query word i is in the start of the description or the option descriptions. */
  inText: number;
  deprecated: boolean;
  /** -bm25 (higher is better). */
  bm25: number;
}

/** A crude English stemmer, enough to compare query words with name words (vlans ~ vlan). */
export function stem(word: string): string {
  return word
    .toLowerCase()
    .replace(/(ing|ed|es|s)$/, '')
    .replace(/(.)\1$/, '$1');
}

function bits(mask: number): number {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n++;
  return n;
}

/**
 * Re-rank on top of bm25 (07 §2). Words found in more than half of the docs get almost no bm25
 * weight ("create user"), so the score adds three parts instead of multiplying bm25: the text
 * match (bm25 relative to the best candidate), words found in the plugin's own name (exact names
 * win) and how many query words the plugin covers at all. Then ansible.builtin as the base layer,
 * the type the query names, context (the repository's collections, most used first, and the
 * inventory's platform), and deprecated plugins go down.
 */
export function rerank(c: Candidate, plan: QueryPlan, ctx: SearchContext, best = c.bm25): number {
  const words = plan.words;
  const stems = words.map(stem);
  const n = Math.max(1, words.length);
  const text = best > 0 ? c.bm25 / best : 0;
  const strong = bits(c.inStrong) / n;
  const covered = bits(c.inStrong | c.inText) / n;

  const name = c.name.toLowerCase();
  const nameWords = name.split(/[_.]/);
  let named = 0;
  const spelled =
    plan.names?.get(name) ?? (words.includes(name) || stems.includes(stem(name)) ? 1 : 0);
  // The whole query names the plugin (template, json query, ip address) or one word of it does
  // (port in "retry until port open").
  if (spelled) named = 1.6 * Math.sqrt(Math.min(1, spelled / n));
  else {
    const exact = stems.filter((s) => nameWords.some((w) => stem(w) === s)).length;
    const prefix = stems.filter(
      (s) => s.length >= 3 && nameWords.some((w) => w.startsWith(s)),
    ).length;
    // Shorter names are the general modules (ios_ospfv2 over ios_ospf_interfaces).
    named = (0.9 * exact + 0.35 * Math.max(0, prefix - exact)) / n + 0.1 / nameWords.length;
  }
  let score = text + named + 0.5 * strong ** 2 + 0.6 * covered ** 2;

  if (plan.type) score *= c.type === plan.type ? 2.5 : 0.6;
  if (c.collection === 'ansible.builtin') score *= 1.9;
  const used = ctx.collections ?? [];
  const at = used.indexOf(c.collection);
  if ((ctx.platforms ?? []).includes(c.collection)) score *= 2.2;
  else if (at >= 0)
    score *= GRAB_BAG.has(c.collection) ? 1.15 : 2 - (0.6 * at) / Math.max(1, used.length);
  if (isOtherPlatform(c.collection, ctx)) score *= 0.5;
  if (c.deprecated) score *= 0.4;
  return score;
}
