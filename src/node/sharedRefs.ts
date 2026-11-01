// Shared subflows against their sources (AFD-60): the file a copy names, read from disk (cached by
// its modification time), its version and the subflow at the key path. The designer turns what is
// missing or newer into problems with Update and Unlink quick fixes.
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { modelOf } from '../core/flow/model';
import { parseRefFrom, subflowsOf } from '../core/flow/refs';
import type { FlowDocument, FlowNode } from '../core/flow/types';
import type { Finding } from '../core/flow/validate';

export interface SharedSource {
  /** The source flow's version and the subflow at the key path. */
  version?: number;
  node?: FlowNode;
  error?: string;
}

const cache = new Map<string, { mtime: number; doc?: FlowDocument; error?: string }>();

function readFlow(file: string): { doc?: FlowDocument; error?: string } {
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return { error: 'no such file' };
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit;
  let entry: { mtime: number; doc?: FlowDocument; error?: string };
  try {
    const doc = parse(readFileSync(file, 'utf8')) as FlowDocument;
    entry = doc?.flow ? { mtime, doc } : { mtime, error: 'not a flow' };
  } catch (e) {
    entry = { mtime, error: `does not parse: ${(e as Error).message}` };
  }
  cache.set(file, entry);
  return entry;
}

/** The source of `from`, for the flow at `flowFile`. */
export function sharedSource(flowFile: string, from: string): SharedSource {
  const ref = parseRefFrom(from);
  if (!ref) return { error: `"${from}" is not <flow file>#<subflow key>` };
  const file = resolve(dirname(flowFile), ref.path);
  const { doc, error } = readFlow(file);
  if (!doc) return { error: `${ref.path}: ${error}` };
  const node = subflowsOf(doc).find((s) => s.path === ref.key)?.node;
  if (!node) return { error: `${ref.path} has no subflow ${ref.key}` };
  return { version: Number(doc.flow.version) || 1, node };
}

/** Problems for the flow's shared subflows: a source that is gone, or a newer version of it. */
export function sharedFindings(flowFile: string, doc: FlowDocument): Finding[] {
  const out: Finding[] = [];
  for (const { node, path } of modelOf(doc).nodes.values()) {
    if (!node.ref) continue;
    const label = `"${node.title}"`;
    const src = sharedSource(flowFile, node.ref.from);
    if (src.error)
      out.push({
        code: 'shared-source',
        severity: 'error',
        message: `${label} is a copy of ${node.ref.from}, which is gone (${src.error}): fix ref.from, or Unlink to keep it as this flow's own`,
        path: [...path, 'ref', 'from'],
        node: node.id,
      });
    else if ((src.version ?? 0) > node.ref.version)
      out.push({
        code: 'shared-source',
        severity: 'info',
        message: `${label}: ${node.ref.from} is at version ${src.version}, this copy at ${node.ref.version}: Update Shared Subflow copies it again`,
        path: [...path, 'ref', 'version'],
        node: node.id,
      });
  }
  return out;
}
