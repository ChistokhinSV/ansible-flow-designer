// AFD-328: a step bound to a module is implemented by the file's rule (it has a binding), but while
// a required parameter of that module is not set it would not run. The node and its Lifecycle say
// so, from the module's docs once the catalog is ready: asked once per module, again after a scan.
import { useEffect, useMemo, useState } from 'react';
import { missingRequired } from '../core/catalog/draft';
import type { FlowNode } from '../core/flow/types';
import type { CatalogDoc } from '../core/protocol';
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

/** What a node with missing parameters says, on the canvas and in its Lifecycle. */
export const missingWords = (missing: readonly string[]): string =>
  `Required parameter${missing.length === 1 ? '' : 's'} missing: ${missing.join(', ')}`;
