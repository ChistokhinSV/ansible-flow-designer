// What every import returns (M9, AFD-26): the flow, what did not map one to one, and the counts the
// command announces.
import type { FlowDocument } from '../flow/types';

export interface ImportResult {
  doc: FlowDocument;
  /** What did not map one to one, as sentences for the user. */
  notes: string[];
  counts: { steps: number; implemented: number; drafts: number };
}
