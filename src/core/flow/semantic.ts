// Semantic projection of a flow document: everything except layout (D-30, ADR-0006). Two documents
// with equal keys differ only in node positions, comments or formatting.
import type { FlowDocument } from './types';

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
