// AFD-328: a step bound to a module is implemented by the file's rule (it has a binding), but while
// a required parameter of that module is not set it would not run. The node and its Lifecycle say
// so, from the module's docs once the catalog is ready: asked once per module, again after a scan.
import { useEffect, useMemo, useState } from 'react';
import { missingRequired } from '../core/catalog/draft';
import type { FlowNode } from '../core/flow/types';
import type { CatalogDoc } from '../core/protocol';
import { missingRole, type StatusGap } from '../core/view/statusGap';
import { onHostMessage } from './bus';
import { catalogRequest } from './catalog';
import { useUi } from './store';

const docs = new Map<string, Promise<CatalogDoc | null>>();
onHostMessage((m) => {
  if (m.type === 'catalogStatus' && m.status.state === 'ready') docs.clear();
});

function docOf(fqcn: string): Promise<CatalogDoc | null> {
  let p = docs.get(fqcn);
  if (!p) {
    p = catalogRequest({ op: 'doc', fqcn }).catch(() => null);
    docs.set(fqcn, p);
  }
  return p;
}

const NONE: readonly string[] = [];

/** The required parameters the node's module binding lacks; empty when unknown. */
export function useMissingParams(node: FlowNode | undefined): readonly string[] {
  const ready = useUi((s) => s.catalog.state === 'ready');
  const impl = node?.type === 'task' && node.impl?.kind === 'module' ? node.impl : undefined;
  const ref = impl?.ref;
  const [read, setRead] = useState<{ ref: string; doc: CatalogDoc | null } | null>(null);
  useEffect(() => {
    if (!ready || !ref) return;
    let live = true;
    void docOf(ref).then((doc) => {
      if (live) setRead({ ref, doc });
    });
    return () => {
      live = false;
    };
  }, [ready, ref]);
  const doc = read && read.ref === ref ? read.doc : null;
  const missing = useMemo(() => (impl && doc ? missingRequired(impl, doc) : NONE), [impl, doc]);
  const key = missing.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the same names are the same answer
  return useMemo(() => missing, [key]);
}

/** AFD-334: what a node lacks to run as it is: required parameters, and a role not in the project. */
export function useStatusGap(node: FlowNode | undefined): StatusGap {
  const params = useMissingParams(node);
  const role = useUi((s) => (node ? missingRole(s.snapshot?.findings, node.id) : undefined));
  return useMemo(() => ({ params, ...(role ? { role } : {}) }), [params, role]);
}

/**
 * AFD-334: the gaps of a level's steps at once, for the canvas's accessible names (they are built
 * outside the node components). Docs come from the same cache as `useMissingParams`.
 */
export function useLevelGaps(nodes: readonly FlowNode[]): Record<string, StatusGap> {
  const ready = useUi((s) => s.catalog.state === 'ready');
  const findings = useUi((s) => s.snapshot?.findings);
  const refs = [
    ...new Set(
      nodes.flatMap((n) =>
        n.type === 'task' && n.impl?.kind === 'module' && n.impl.ref ? [n.impl.ref] : [],
      ),
    ),
  ].sort();
  const refKey = refs.join('|');
  const [read, setRead] = useState<Record<string, CatalogDoc | null>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refKey` stands for the refs.
  useEffect(() => {
    if (!ready || refs.length === 0) return;
    let live = true;
    void Promise.all(refs.map(async (r) => [r, await docOf(r)] as const)).then((pairs) => {
      if (live) setRead(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
    };
  }, [ready, refKey]);
  return useMemo(() => {
    const out: Record<string, StatusGap> = {};
    for (const n of nodes) {
      const impl = n.type === 'task' && n.impl?.kind === 'module' ? n.impl : undefined;
      const doc = impl?.ref ? read[impl.ref] : undefined;
      const params = impl && doc ? missingRequired(impl, doc) : [];
      const role = missingRole(findings, n.id);
      if (params.length || role) out[n.id] = { params, ...(role ? { role } : {}) };
    }
    return out;
  }, [nodes, read, findings]);
}
