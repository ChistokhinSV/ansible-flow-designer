// What the canvas shows right now, in words (AFD-83, wave 8 group I): in Code and Run, what the
// mode is for and that the graph only reads there; with a lens on, what the lens shows and, when no
// step on this level has anything for it, why (round 1: P10, P11). Design without a lens says
// nothing: the first screen keeps its controls.

import { modelOf } from '../../core/flow/model';
import { lensCaption } from '../../core/lens/caption';
import { send } from '../bus';
import { MODES } from '../modes';
import { useUi } from '../store';

export function CanvasCaption() {
  const mode = useUi((s) => s.mode);
  const lens = useUi((s) => s.lens);
  const view = useUi((s) => s.lensView);
  const doc = useUi((s) => s.snapshot?.doc);
  const level = useUi((s) => s.level);
  const targets = useUi((s) => s.lensFacts.inventory?.targets);
  if (!doc || (mode === 'design' && !lens)) return null;
  const m = MODES.find((x) => x.id === mode);
  const nodes = (modelOf(doc).levels.get(level)?.nodes ?? []).map((n) => ({
    id: n.id,
    type: n.type,
  }));
  const c = lens ? lensCaption(lens, view, nodes, targets) : undefined;
  return (
    <div className="afd-canvas-caption" role="status" data-canvas-caption={lens ?? mode}>
      {mode !== 'design' && m ? (
        <p data-caption-mode={mode}>
          <strong>{m.label} mode</strong> · {m.hint}. The graph only reads here; Design changes it.
        </p>
      ) : null}
      {c ? (
        <p data-caption-lens={c.lens}>
          <strong>{c.label} lens</strong> · {c.what}.
          {c.empty ? (
            <>
              {' '}
              <span className="afd-caption-empty" data-lens-empty>
                {c.empty}
              </span>
            </>
          ) : null}
          {c.setTargets ? (
            <>
              {' '}
              <button type="button" className="link" onClick={() => send({ type: 'setTargets' })}>
                Set Targets…
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
