// Catalog requests to the extension host (M5): search, docs, roles, playbooks, rebuild. Each is a
// request answered by `catalogReply`; the host loads the catalog on first use.
import { useEffect, useState } from 'react';
import { type ResultField, resultFields } from '../core/catalog/draft';
import type { CatalogRequest, CatalogResults } from '../core/protocol';
import type { PluginName } from '../core/view/jinjaComplete';
import { onHostMessage, send } from './bus';

type Op = CatalogRequest['op'];

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let next = 1;

onHostMessage((m) => {
  // Another environment, or a fresh scan: the plugin names are asked again (AFD-225).
  if (m.type === 'catalogStatus' && m.status.state === 'ready') names.clear();
  if (m.type !== 'catalogReply') return;
  const p = pending.get(m.reqId);
  pending.delete(m.reqId);
  if (!p) return;
  if (m.ok) p.resolve(m.result);
  else p.reject(new Error(m.error ?? 'The catalog request failed'));
});

export function catalogRequest<K extends Op>(
  request: Extract<CatalogRequest, { op: K }>,
): Promise<CatalogResults[K]> {
  const reqId = next++;
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
    send({ type: 'catalog', reqId, request });
  });
}

export interface Loaded<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

/**
 * The answer to a catalog request, re-asked when `key` changes (after `delay` ms, for typing);
 * answers to earlier keys are dropped.
 */
export function useCatalog<K extends Op>(
  request: Extract<CatalogRequest, { op: K }> | null,
  key: string,
  delay = 0,
): Loaded<CatalogResults[K]> {
  const [state, setState] = useState<Loaded<CatalogResults[K]>>({ loading: !!request });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the request.
  useEffect(() => {
    if (!request) {
      setState({ loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      catalogRequest(request).then(
        (data) => live && setState({ data, loading: false }),
        (e: Error) => live && setState({ error: e.message, loading: false }),
      );
    }, delay);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);
  return state;
}

/**
 * The documented fields of each module's result, by FQCN (AFD-108): the @ list offers them after
 * an upstream step's result. Modules whose docs are missing have no entry.
 */
export function useResultFields(fqcns: string[]): Record<string, ResultField[]> {
  const key = [...new Set(fqcns)].sort().join(',');
  const [fields, setFields] = useState<Record<string, ResultField[]>>({});
  useEffect(() => {
    let live = true;
    for (const fqcn of key ? key.split(',') : [])
      catalogRequest({ op: 'doc', fqcn }).then(
        (doc) => live && setFields((f) => ({ ...f, [fqcn]: resultFields(doc?.returns) })),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [key]);
  return fields;
}

type PluginKind = 'filter' | 'test' | 'lookup';
const names = new Map<PluginKind, Promise<PluginName[]>>();

function namesOf(type: PluginKind): Promise<PluginName[]> {
  let p = names.get(type);
  if (!p) {
    p = catalogRequest({ op: 'names', type }).catch(() => []);
    names.set(type, p);
  }
  return p;
}

/**
 * AFD-225: the filters, tests and lookups of the environment's collections, for the Jinja
 * completion list: asked once per webview (and after a new scan), from the index already there.
 * Empty until they come, and when there is no catalog: the list's own words cover ansible.builtin.
 */
export function usePluginNames(
  active = true,
): Partial<Record<'filters' | 'tests' | 'lookups', PluginName[]>> {
  const [state, setState] = useState<
    Partial<Record<'filters' | 'tests' | 'lookups', PluginName[]>>
  >({});
  useEffect(() => {
    if (!active) return;
    let live = true;
    void Promise.all([namesOf('filter'), namesOf('test'), namesOf('lookup')]).then(
      ([filters, tests, lookups]) => live && setState({ filters, tests, lookups }),
    );
    return () => {
      live = false;
    };
  }, [active]);
  return state;
}
