// Wires by node, built once per edge list (AFD-162). Walks over a level (what a reader sees
// upstream, what an entry reaches) scanned every wire for every node they visited, for every
// reference checked: O(refs · V · E) on a large flow. A model's edge lists are built per parse and
// never changed afterwards, so the maps are kept per list.
import type { PortRef } from './types';

type Wire = { from?: PortRef; to?: PortRef } | null | undefined;

type Index = { size: number; map: Map<string, string[]> };
const forward = new WeakMap<readonly Wire[], Index>();
const backward = new WeakMap<readonly Wire[], Index>();

function build(edges: readonly Wire[], out: boolean): Index {
  const map = new Map<string, string[]>();
  for (const e of edges) {
    const from = e?.from?.node;
    const to = e?.to?.node;
    if (!from || !to) continue;
    const [key, value] = out ? [from, to] : [to, from];
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }
  return { size: edges.length, map };
}

/** The index of a list; a list that grew or shrank in place (a builder's) is indexed again. */
function indexOf(cache: WeakMap<readonly Wire[], Index>, edges: readonly Wire[], out: boolean) {
  let index = cache.get(edges);
  if (!index || index.size !== edges.length) {
    index = build(edges, out);
    cache.set(edges, index);
  }
  return index.map;
}

/** The nodes a node's wires lead to, in wire order. */
export function successors(edges: readonly Wire[], node: string): readonly string[] {
  return indexOf(forward, edges, true).get(node) ?? [];
}

/** The nodes whose wires lead to a node, in wire order. */
export function predecessors(edges: readonly Wire[], node: string): readonly string[] {
  return indexOf(backward, edges, false).get(node) ?? [];
}
