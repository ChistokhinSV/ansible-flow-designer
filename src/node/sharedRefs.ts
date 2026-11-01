// Shared subflows against their sources (AFD-60): the file a copy names, read from disk (cached by
// its modification time), its version and the subflow at the key path. The designer turns what is
// missing or newer into problems with Update and Unlink quick fixes.
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { planCommand } from '../core/flow/commands';
import { formatOf } from '../core/flow/format';
import { createIdFactory } from '../core/flow/ids';
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

/**
 * Copies go into format 2 flows only, so a format 1 source is upgraded in memory first (AFD-62):
 * its legacy ports, `handler` and the like would otherwise land in a level the target cannot edit.
 * The file is left as it is.
 */
function format2(text: string, doc: FlowDocument): FlowDocument {
  if (formatOf(doc) >= 2) return doc;
  const upgraded = planCommand(text, { kind: 'upgradeFormat' }, { newId: createIdFactory() });
  return parse(upgraded.text) as FlowDocument;
}

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
    const text = readFileSync(file, 'utf8');
    const doc = parse(text) as FlowDocument;
    if (!doc?.flow) entry = { mtime, error: 'not a flow' };
    else
      try {
        entry = { mtime, doc: format2(text, doc) };
      } catch (e) {
        entry = {
          mtime,
          error: `format 1, and it cannot be upgraded here (${(e as Error).message}): run Upgrade Flow Format on it`,
        };
      }
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
