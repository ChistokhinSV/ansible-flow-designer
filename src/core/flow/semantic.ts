// Semantic projection of a flow document: everything except layout (D-30, ADR-0006). Two documents
// with equal keys differ only in node positions, comments or formatting.
import type { FlowDocument, FlowNode, Ulid } from './types';
import { walkNodes } from './walk';

function canonical(value: unknown): unknown {
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

/** Canonical JSON of the document without any `layout` block (top level or inside subflows). */
export function semanticKey(doc: FlowDocument | unknown): string {
  return JSON.stringify(canonical(stripLayout(doc)));
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
 * included and positions left out.
 */
function nodeDesign(node: FlowNode): unknown {
  const { status: _status, tested: _tested, subflow, ...rest } = node;
  if (!subflow || typeof subflow !== 'object') return rest;
  const { layout: _layout, nodes, ...body } = subflow;
  return { ...rest, subflow: { ...body, nodes: (nodes ?? []).map(nodeDesign) } };
}

/** FNV-1a: a short fingerprint is enough to tell a node's design apart (no crypto in the webview). */
function fnv1a(text: string): string {
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
