// AFD-270: the designer as a viewer. A host asks for it in `config`, a web page in mount(); once
// on it stays on, so a later `config` without the flag cannot hand the editor back.
import { restrictToViewer } from './bus';
import { useUi } from './store';

export function enterViewer(): void {
  restrictToViewer();
  useUi.getState().setViewer();
}
