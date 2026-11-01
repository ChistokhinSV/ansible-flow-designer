// Flow format versions (AFD-49, ADR-0025): `schema_version` 1 stays readable forever, and an
// explicit upgrade moves a file to the current format. Nothing is written on open; the upgrade
// runs only when someone asks for it (Upgrade Flow Format, the `upgrade_format` op), as one YAML
// transaction, so it is one edit and one undo step and the bytes outside the changed nodes stay.
// Each step takes a file from one version to the next; tickets that change the format add theirs.
import { setIn } from '../yaml/ops';
import type { YamlTransaction } from '../yaml/transaction';
import type { FlowDocument } from './types';

/** The format new flows are written in, and what Upgrade Flow Format leads to. */
export const CURRENT_FORMAT = 2;

export interface MigrationStep {
  /** The version this step reads; it leaves the file at `from + 1`. */
  from: number;
  /** What the step changes in this document, in a few words each; empty when only the version. */
  notes(doc: FlowDocument): string[];
  /** The step's own edits; the version number is set by `migrate` after it. */
  apply(tx: YamlTransaction): void;
}

/** v1 → v2. Wave 4 tickets add their conversions here (AFD-50, -51, -52, -54). */
export const STEPS: readonly MigrationStep[] = [{ from: 1, notes: () => [], apply: () => {} }];

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
 * Brings the document in `tx` to `CURRENT_FORMAT`, step by step. Throws when it is already current
 * or newer than this extension reads.
 */
export function migrate(tx: YamlTransaction, steps: readonly MigrationStep[] = STEPS): number {
  const doc = tx.current.doc.toJS() as FlowDocument;
  let version = formatOf(doc);
  if (version > CURRENT_FORMAT) throw newer(version);
  if (version === CURRENT_FORMAT)
    throw new FormatError('format-current', `This flow already uses format ${CURRENT_FORMAT}`);
  while (version < CURRENT_FORMAT) {
    for (const step of steps.filter((s) => s.from === version)) step.apply(tx);
    version += 1;
    tx.apply((f) => setIn(f, ['schema_version'], version));
  }
  return version;
}

/** What upgrading this document changes, for the banner and the result: the steps' notes. */
export function upgradeNotes(doc: FlowDocument, steps: readonly MigrationStep[] = STEPS): string[] {
  const version = formatOf(doc);
  return steps
    .filter((s) => s.from >= version && s.from < CURRENT_FORMAT)
    .flatMap((s) => s.notes(doc));
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

function newer(version: number): FormatError {
  return new FormatError(
    'format-newer',
    `This flow uses format ${version}, newer than this Ansible Flow Designer reads (up to ${CURRENT_FORMAT}): update the extension`,
  );
}
