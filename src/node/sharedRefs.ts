// Shared subflows against their sources (AFD-60): the file a copy names, read from disk (cached by
// its modification time), its version and the subflow at the key path. The designer turns what is
// missing or newer into problems with Update and Unlink quick fixes. AFD-128: `ref.from` comes from
// the flow file, so it may name only a .flow.yaml inside the workspace folder, by relative path.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { planCommand } from '../core/flow/commands';
import { parseFlow } from '../core/flow/document';
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

/** A flow is read whole on every check; a source bigger than this is not a flow (AFD-128). */
const MAX_BYTES = 2 * 1024 * 1024;

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

function realOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * The file a shared subflow's `ref.from` names, checked before anything on disk is touched
 * (AFD-128): a UNC path would make Windows connect to that host and offer the user's credentials,
 * and a device or a huge file would be read whole. It must be a relative path to a .flow.yaml that
 * stays, links resolved, inside `root`: the workspace folder, else the folder above the flow's own.
 */
export function sharedFile(
  flowFile: string,
  path: string,
  root = dirname(dirname(flowFile)),
): { file?: string; error?: string } {
  if (!path.endsWith('.flow.yaml')) return { error: 'not a .flow.yaml file' };
  if (isAbsolute(path) || /^[\\/]|^[A-Za-z]:|\0/.test(path))
    return { error: 'not a path relative to this flow' };
  const file = resolve(dirname(flowFile), path);
  if (!within(resolve(root), file)) return { error: 'outside the workspace folder' };
  const real = realOr(file);
  if (!within(realOr(resolve(root)), real)) return { error: 'outside the workspace folder' };
  return { file: real };
}

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
    const stat = statSync(file);
    if (!stat.isFile()) return { error: 'not a file' };
    if (stat.size > MAX_BYTES) return { error: 'larger than 2 MB' };
    mtime = stat.mtimeMs;
  } catch {
    return { error: 'no such file' };
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit;
  let entry: { mtime: number; doc?: FlowDocument; error?: string };
  try {
    const text = readFileSync(file, 'utf8');
    // AFD-147: parseFlow refuses an alias inside what it names (the copy would never end).
    const parsed = parseFlow(text);
    const doc = parsed.doc;
    if (!doc) entry = { mtime, error: parsed.errors[0]?.message ?? 'does not parse' };
    else if (!doc.flow) entry = { mtime, error: 'not a flow' };
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

/** The source of `from`, for the flow at `flowFile` in the workspace folder `root`. */
export function sharedSource(flowFile: string, from: string, root?: string): SharedSource {
  const ref = parseRefFrom(from);
  if (!ref) return { error: `"${from}" is not <flow file>#<subflow key>` };
  const where = sharedFile(flowFile, ref.path, root);
  if (!where.file) return { error: `${ref.path}: ${where.error}` };
  const { doc, error } = readFlow(where.file);
  if (!doc) return { error: `${ref.path}: ${error}` };
  const node = subflowsOf(doc).find((s) => s.path === ref.key)?.node;
  if (!node) return { error: `${ref.path} has no subflow ${ref.key}` };
  return { version: Number(doc.flow.version) || 1, node };
}

/** Problems for the flow's shared subflows: a source that is gone, or a newer version of it. */
export function sharedFindings(flowFile: string, doc: FlowDocument, root?: string): Finding[] {
  const out: Finding[] = [];
  for (const { node, path } of modelOf(doc).nodes.values()) {
    if (!node.ref) continue;
    const label = `"${node.title}"`;
    const src = sharedSource(flowFile, node.ref.from, root);
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
