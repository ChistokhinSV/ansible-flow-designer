// What a flow file looks like, apart from what it says (AFD-49, AFD-50): its format version and
// the order of the keys a writer puts into a node. Shared by the commands and the upgrade steps.
import type { FlowDocument } from './types';

/** The format new flows are written in, and what Upgrade Flow Format leads to. */
export const CURRENT_FORMAT = 2;

export function formatOf(doc: Pick<FlowDocument, 'schema_version'> | undefined): number {
  const v = Number(doc?.schema_version);
  return Number.isInteger(v) && v > 0 ? v : 1;
}

export class FormatError extends Error {
  constructor(
    readonly code: 'format-newer' | 'format-current' | 'needs-format',
    message: string,
  ) {
    super(message);
    this.name = 'FormatError';
  }
}

/**
 * For an edit that needs a newer format (a field format 1 does not have): explains the upgrade
 * instead of writing something a format 1 reader would reject.
 */
export function requireFormat(doc: FlowDocument, version: number, what: string): void {
  if (formatOf(doc) >= version) return;
  throw new FormatError(
    'needs-format',
    `${what} needs flow format ${version}; this file is format ${formatOf(doc)}. Run Upgrade Flow Format (one undo step reverts it), then try again.`,
  );
}

/** Where a writer puts each key of a node, so files read the same whoever wrote them. */
export const NODE_ORDER = [
  'id',
  'key',
  'type',
  'title',
  'status',
  'tested',
  'intent',
  'condition',
  'outcome',
  'handler',
  'join_mode',
  'branches',
  'ports',
  'inputs',
  'outputs',
  'settings',
  'impl',
  'undo',
  'subflow',
] as const;

/** The keys that come after `key` in a node, for an insert that keeps NODE_ORDER. */
export function keysAfter(key: (typeof NODE_ORDER)[number]): string[] {
  return NODE_ORDER.slice(NODE_ORDER.indexOf(key) + 1);
}
