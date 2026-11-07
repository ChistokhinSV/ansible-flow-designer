// Semantic projection of a flow document: everything except layout and annotations (D-30,
// ADR-0006, AFD-64). Two documents with equal keys differ only in node positions, annotations,
// comments or formatting.
import { LEGACY_PORTS } from './ports';
import type { FlowDocument, FlowNode, Ulid } from './types';
import { walkNodes } from './walk';

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort())
      out[k] = canonical((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

function stripLayout(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLayout);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'layout') continue;
      out[k] = stripLayout(v);
    }
    return out;
  }
  return value;
}

/**
 * A level body without its annotations, inner levels included (AFD-64). Removed where they live
 * (the top level, `subflow.annotations`), not by key name: a module's params may hold an
 * `annotations` key (Kubernetes metadata), and that is design.
 */
export function withoutAnnotations<T>(body: T): T {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const { annotations: _annotations, ...rest } = body as Record<string, unknown>;
  if (Array.isArray(rest.nodes))
    rest.nodes = rest.nodes.map((n) => {
      if (n === null || typeof n !== 'object') return n;
      const sub = (n as { subflow?: unknown }).subflow;
      return sub && typeof sub === 'object' ? { ...n, subflow: withoutAnnotations(sub) } : n;
    });
  return rest as T;
}

/** Canonical JSON of the document without any `layout` block and without its annotations. */
export function semanticKey(doc: FlowDocument | unknown): string {
  return JSON.stringify(canonical(stripLayout(withoutAnnotations(doc))));
}

/** Same as semanticKey but ignoring `flow.version`, to decide whether a bump is due. */
export function semanticKeyWithoutVersion(doc: FlowDocument | unknown): string {
  const copy = structuredClone(doc) as { flow?: { version?: unknown } };
  if (copy?.flow) delete copy.flow.version;
  return semanticKey(copy);
}

function versionOf(doc: unknown): number | undefined {
  const v = (doc as { flow?: { version?: unknown } } | undefined)?.flow?.version;
  return typeof v === 'number' ? v : undefined;
}

/**
 * ADR-0006: the version to write on save, or undefined to leave it. `base` is the committed file at
 * Git HEAD, or the last saved text outside Git. The version moves at most once relative to `base`.
 */
export function versionBump(current: unknown, base: unknown): number | undefined {
  const baseVersion = versionOf(base);
  const currentVersion = versionOf(current);
  if (baseVersion === undefined || currentVersion !== baseVersion) return undefined;
  if (semanticKeyWithoutVersion(current) === semanticKeyWithoutVersion(base)) return undefined;
  return baseVersion + 1;
}

/**
 * A node's design: its entry without its status and the evidence for it (AFD-50), inner nodes
 * included and positions left out. What Upgrade Flow Format only renames or drops is the same
 * design, so a run recorded before the upgrade still matches: format 1 `handler` is `purpose`
 * (AFD-52), and the undo and cancelled ports never did anything (AFD-54).
 */
function nodeDesign(node: FlowNode): unknown {
  const { status: _status, tested: _tested, handler, subflow, ports, ...own } = node;
  const rest: Record<string, unknown> =
    handler !== undefined && own.purpose === undefined ? { ...own, purpose: handler } : own;
  const kept = ports?.filter((p) => !LEGACY_PORTS.has(p));
  if (kept?.length) rest.ports = kept;
  if (!subflow || typeof subflow !== 'object') return rest;
  const { layout: _layout, annotations: _annotations, nodes, ...body } = subflow;
  return { ...rest, subflow: { ...body, nodes: (nodes ?? []).map(nodeDesign) } };
}

/** FNV-1a: a short fingerprint is enough to tell a node's design apart (no crypto in the webview). */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Fingerprint of every node's design, kept with a run so `tested` is proposed only for what ran. */
export function nodeDesigns(doc: FlowDocument): Record<Ulid, string> {
  const out: Record<Ulid, string> = {};
  for (const n of walkNodes(doc.nodes)) out[n.id] = fnv1a(JSON.stringify(canonical(nodeDesign(n))));
  return out;
}

/**
 * What decides where hosts go (AFD-115): every node's design, the top-level wires and the flow's
 * inputs. A scenario verdict made on another routing design is out of date; statuses, positions
 * and notes do not count.
 */
export function routingDesign(doc: FlowDocument): string {
  return fnv1a(
    JSON.stringify(
      canonical({
        nodes: nodeDesigns(doc),
        edges: doc.edges ?? [],
        inputs: doc.flow?.inputs ?? {},
      }),
    ),
  );
}

/**
 * Decision 15: a tested node whose design changed is implemented again, since that design was not
 * tested. Wiring and positions are not the node's design. Nodes in `keep` had their status set by
 * the same change and keep it.
 */
export function testedDropBack(
  before: FlowDocument,
  after: FlowDocument,
  keep?: ReadonlySet<Ulid>,
): Ulid[] {
  const was = new Map([...walkNodes(before.nodes)].map((n) => [n.id, n]));
  const old = nodeDesigns(before);
  const now = nodeDesigns(after);
  return [...walkNodes(after.nodes)]
    .filter(
      (n) =>
        n.status === 'tested' &&
        was.get(n.id)?.status === 'tested' &&
        !keep?.has(n.id) &&
        old[n.id] !== now[n.id],
    )
    .map((n) => n.id);
}
