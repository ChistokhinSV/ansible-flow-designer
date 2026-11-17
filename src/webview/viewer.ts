// AFD-270: the designer as a viewer. A host asks for it in `config`, a web page in mount(); once
// on it stays on, so a later `config` without the flag cannot hand the editor back.
import type { PastVersion } from '../core/protocol';
import { restrictToPast, restrictToViewer } from './bus';
import { useUi } from './store';

export function enterViewer(): void {
  restrictToViewer();
  useUi.getState().setViewer();
}

/** AFD-320: the flow as a commit left it, read-only, in Design mode for the Changes lens. */
export function enterPast(past: PastVersion): void {
  restrictToPast();
  useUi.getState().setPast(past);
}
