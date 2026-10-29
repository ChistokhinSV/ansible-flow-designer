// Catalog requests to the extension host (M5): search, docs, roles, playbooks, rebuild. Each is a
// request answered by `catalogReply`; the host loads the catalog on first use.
import { useEffect, useState } from 'react';
import type { CatalogRequest, CatalogResults } from '../core/protocol';
import { onHostMessage, send } from './bus';

type Op = CatalogRequest['op'];

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let next = 1;

onHostMessage((m) => {
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
