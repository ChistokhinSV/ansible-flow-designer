// Reusable subflows (AFD-60): a subflow can be a copy of a subflow in another flow, pinned to that
// flow's version: `ref: {from: <path>#<key path>, version, design}`. The copy lives in this file,
// so the code, the runs and the reviews need nothing else; the host compares it with its source
// (newer version: Update), and `design` tells a copy edited here from the one that was copied.
import { modelOf } from './model';
import { canonical, withoutAnnotations } from './semantic';
import type { Edge, FlowDocument, FlowNode, SubflowBody, SubflowRef, Ulid } from './types';

/** `../shared/backup.flow.yaml#backup` → the file (relative to this flow's folder) and key path. */
export function parseRefFrom(from: string): { path: string; key: string } | undefined {
  const at = from.lastIndexOf('#');
  if (at <= 0 || at === from.length - 1) return undefined;
  return { path: from.slice(0, at), key: from.slice(at + 1) };
}

/** FNV-1a of what a copy is: its inner level and its contract. */
export function refDesign(node: Pick<FlowNode, 'subflow' | 'inputs' | 'outputs'>): string {
  const text = JSON.stringify(
    canonical({
      subflow: withoutAnnotations(node.subflow ?? {}),
      inputs: node.inputs ?? {},
      outputs: node.outputs ?? {},
    }),
  );
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Every subflow of a flow by key path (`a`, `a/b`), the pick list of shared subflows. */
export function subflowsOf(doc: FlowDocument): { path: string; node: FlowNode }[] {
  const out: { path: string; node: FlowNode }[] = [];
  const walk = (nodes: FlowNode[] | undefined, prefix: string) => {
    for (const n of nodes ?? []) {
      if (n?.type !== 'subflow' || !n.subflow?.nodes?.length) continue;
      const path = prefix ? `${prefix}/${n.key}` : n.key;
      out.push({ path, node: n });
      walk(n.subflow.nodes, path);
    }
  };
  walk(doc.nodes, '');
  return out;
}

/** The subflow a level belongs to that is a copy (itself or around it), for read-only levels. */
export function sharedAround(doc: FlowDocument, level: string): FlowNode | undefined {
  const model = modelOf(doc);
  for (let at = level; at !== 'root'; ) {
    const entry = model.nodes.get(at);
    if (!entry) return undefined;
    if (entry.node.ref) return entry.node;
    at = entry.level;
  }
  return undefined;
}

/**
 * A fresh copy of a subflow's inner level and contract: every inner node, wire and annotation gets
 * a new ID, wires, the boundary and inner layouts follow, tested evidence and decisions stay behind
 * (the copy has not run here).
 */
export function copySubflow(
  source: FlowNode,
  mint: () => Ulid,
): Pick<FlowNode, 'subflow' | 'inputs' | 'outputs' | 'intent' | 'settings' | 'ports' | 'purpose'> {
  const ids = new Map<string, Ulid>();
  const idOf = (old: string) => {
    let id = ids.get(old);
    if (!id) {
      id = mint();
      ids.set(old, id);
    }
    return id;
  };
  const body = (b: SubflowBody | undefined): SubflowBody | undefined => {
    if (!b) return undefined;
    const nodes = (b.nodes ?? []).filter(Boolean).map(node);
    const edges = (b.edges ?? []).filter(Boolean).map(
      (e): Edge => ({
        id: mint(),
        from: { node: idOf(e.from.node), port: e.from.port },
        to: { node: idOf(e.to.node), port: e.to.port },
      }),
    );
    const out: SubflowBody = { nodes };
    if (edges.length) out.edges = edges;
    // AFD-64: the level's annotations come along, tied ones to the copies of their nodes.
    const annotations = (b.annotations ?? []).filter(Boolean).map((a) => ({
      ...structuredClone(a),
      id: mint(),
      ...(a.on ? { on: idOf(a.on) } : {}),
    }));
    if (annotations.length) out.annotations = annotations;
    if (b.layout)
      out.layout = Object.fromEntries(Object.entries(b.layout).map(([k, p]) => [idOf(k), p]));
    if (b.boundary)
      out.boundary = {
        ...(b.boundary.in ? { in: idOf(b.boundary.in) } : {}),
        ...(b.boundary.outputs
          ? {
              outputs: Object.fromEntries(
                Object.entries(b.boundary.outputs).map(([port, exits]) => [
                  port,
                  (exits ?? []).map((x) => ({ ...x, node: idOf(x.node) })),
                ]),
              ),
            }
          : {}),
      };
    return out;
  };
  const node = (n: FlowNode): FlowNode => {
    const { id, tested: _t, status, subflow, ...rest } = structuredClone(n);
    const copy: FlowNode = { id: idOf(id), ...rest };
    // Tested here needs a run here.
    if (status) copy.status = status === 'tested' ? 'implemented' : status;
    if (subflow) copy.subflow = body(subflow);
    return copy;
  };
  const out: ReturnType<typeof copySubflow> = { subflow: body(source.subflow) };
  for (const k of ['inputs', 'outputs', 'intent', 'settings', 'ports', 'purpose'] as const)
    if (source[k] !== undefined) (out as Record<string, unknown>)[k] = structuredClone(source[k]);
  return out;
}

/** The reference as the copy records it. */
export function refFor(
  from: string,
  version: number,
  copy: Parameters<typeof refDesign>[0],
): SubflowRef {
  return { from, version, design: refDesign(copy) };
}
