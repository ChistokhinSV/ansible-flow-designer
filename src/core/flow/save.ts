// Edits made on save: tested nodes whose design changed since the file on disk are implemented again
// (decision 15; hand edits in the text editor, canvas commands already did it), then flow.version
// moves once relative to Git HEAD or the last saved text (ADR-0006).
import type { TextEdit } from '../yaml/edits';
import { setIn } from '../yaml/ops';
import { YamlTransaction } from '../yaml/transaction';
import { implementedAgain } from './commands';
import { flowFromFile, parseFlow } from './document';
import { testedDropBack, versionBump } from './semantic';
import type { FlowDocument, Ulid } from './types';

export interface SavePlan {
  edits: TextEdit[];
  dropped: Ulid[];
}

/** `saved` is the file on disk before this save, `base` the version bump's base. */
export function planSave(text: string, saved?: string, base?: string): SavePlan {
  const current = parseFlow(text);
  if (!current.doc) return { edits: [], dropped: [] };
  const tx = new YamlTransaction(text, current.file);
  const savedDoc = saved === undefined ? undefined : parseFlow(saved).doc;
  const dropped = savedDoc ? testedDropBack(savedDoc, current.doc) : [];
  if (dropped.length > 0) implementedAgain(tx, dropped);
  const baseDoc = base === undefined ? undefined : parseFlow(base).doc;
  const now = flowFromFile(tx.current).doc;
  const next = baseDoc && now ? versionBump(now, baseDoc) : undefined;
  if (next !== undefined) tx.apply((f) => setIn(f, ['flow', 'version'], next));
  return { edits: tx.edits(), dropped };
}

/**
 * AFD-377: the version bump a designer edit carries with it, as edits of the text before that
 * edit (none when no bump is due). Made at save, the bump was an undo step of its own: Undo
 * took back only the bump, and with autosave the next save bumped again and Redo was lost. `after`
 * is the flow the edit makes; `base` is HEAD's text (or the last saved text outside Git).
 */
export function versionEditFor(
  text: string,
  after: FlowDocument | undefined,
  base: string | undefined,
): TextEdit[] {
  if (!after || base === undefined) return [];
  const before = parseFlow(text);
  const baseDoc = parseFlow(base).doc;
  if (!before.doc || !baseDoc || before.doc.flow.version !== after.flow.version) return [];
  const next = versionBump(after, baseDoc);
  if (next === undefined) return [];
  const tx = new YamlTransaction(text, before.file);
  tx.apply((f) => setIn(f, ['flow', 'version'], next));
  return tx.edits();
}
