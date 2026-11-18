// Hover preview card (D-22, mockup 10): opens after a pause on a subflow or bound node, stays open
// while the pointer is on the node or the card; a subflow's card can open it. Generated code is in
// the Details' Binding tab and Peek Code (AFD-43).
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { previewOf } from '../preview';
import { useUi } from '../store';

const MARGIN = 8;
/** Room right of a node for its fail ports' labels (`failed_hosts`, `unreachable`). */
const PORT_LABELS = 100;

type Area = { left: number; top: number; right: number; bottom: number };

/**
 * AFD-328: where the card opens: right of the node past its port labels, else left of it, else
 * under it; inside the canvas, so it covers neither the side panel nor the page around the frame.
 */
export function cardPlace(
  node: { right: number; left: number; top: number; bottom?: number },
  card: { width: number; height: number },
  area: Area,
): { left: number; top: number } {
  const fits = (left: number) =>
    left >= area.left + MARGIN && left + card.width <= area.right - MARGIN;
  const right = node.right + PORT_LABELS;
  const leftOf = node.left - card.width - MARGIN;
  let left: number;
  let top = node.top;
  if (fits(right)) left = right;
  else if (fits(leftOf)) left = leftOf;
  else {
    left = node.left;
    top = (node.bottom ?? node.top) + MARGIN;
  }
  left = Math.max(area.left + MARGIN, Math.min(left, area.right - card.width - MARGIN));
  top = Math.max(area.top + MARGIN, Math.min(top, area.bottom - card.height - MARGIN));
  return { left, top };
}

export function PreviewCard() {
  const preview = useUi((s) => s.preview);
  const snapshot = useUi((s) => s.snapshot);
  const run = useUi((s) => s.run);
  const setPreview = useUi((s) => s.setPreview);
  const setLevel = useUi((s) => s.setLevel);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const content = useMemo(
    () => (preview && snapshot?.doc ? previewOf(snapshot.doc, preview.node, run) : undefined),
    [preview, snapshot, run],
  );

  useLayoutEffect(() => {
    if (!preview || !box.current) {
      setPos(null);
      return;
    }
    const { width, height } = box.current.getBoundingClientRect();
    const pane = document.querySelector('.afd-center .react-flow')?.getBoundingClientRect();
    const area =
      pane && pane.width > 0
        ? pane
        : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    setPos(
      cardPlace(
        { right: preview.x - 12, left: preview.left, top: preview.y, bottom: preview.bottom },
        { width, height },
        area,
      ),
    );
  }, [preview]);

  if (!preview || !content) return null;
  const { node } = content;
  return (
    <div
      ref={box}
      className="afd-preview"
      role="dialog"
      aria-label={`Preview of ${node.title}`}
      data-preview={node.id}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      onMouseEnter={() => useUi.getState().holdPreview(true)}
      onMouseLeave={() => useUi.getState().holdPreview(false)}
    >
      <header className="afd-preview-head">
        <div>
          <strong>{node.title}</strong>
          <div className="mono muted">{content.binding ?? content.subtitle}</div>
        </div>
        {node.status ? (
          <span className={`afd-chip status-${node.status}`}>{node.status}</span>
        ) : null}
      </header>
      {content.steps.length > 0 ? (
        <section>
          <h4>Inside{run?.state === 'done' ? ' · last run' : ''}</h4>
          <ol className="afd-preview-steps">
            {content.steps.map((s) => (
              <li key={s.id} data-preview-step={s.id}>
                <span className="afd-preview-step-title">
                  {s.title}
                  {s.entry ? <span className="afd-chip">entry</span> : null}
                  {s.badges.map((b) => (
                    <span key={b} className="afd-chip">
                      {b}
                    </span>
                  ))}
                </span>
                {s.exits.map((e) => (
                  <span key={e.port} className="afd-preview-exit" data-exit={e.port}>
                    → {e.port}
                    {e.reason ? ` · ${e.reason}` : ''}
                  </span>
                ))}
                {s.run ? <span className="muted afd-preview-run">{s.run}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <dl className="afd-preview-facts">
        {!content.hasInner && content.run ? (
          <>
            <dt>Last run</dt>
            <dd>{content.run}</dd>
          </>
        ) : null}
        {content.undo ? (
          <>
            <dt>Undo</dt>
            <dd className="mono">{content.undo}</dd>
          </>
        ) : null}
        {content.settings.length > 0 ? (
          <>
            <dt>Settings</dt>
            <dd>{content.settings.join(' · ')}</dd>
          </>
        ) : null}
      </dl>
      <footer className="afd-preview-actions">
        {node.type === 'subflow' ? (
          <span className="muted">Double-click or Enter to open</span>
        ) : (
          <span />
        )}
        {node.type === 'subflow' ? (
          <button
            type="button"
            onClick={() => {
              setPreview(null);
              setLevel(node.id);
            }}
          >
            Open Subflow
          </button>
        ) : null}
      </footer>
    </div>
  );
}
