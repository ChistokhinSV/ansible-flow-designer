// Hover preview card (D-22, mockup 10): opens after a pause on a subflow or bound node, stays open
// while the pointer is on the node or the card. Actions: Peek code, Open subflow.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { send } from '../bus';
import { previewOf } from '../preview';
import { useUi } from '../store';

const MARGIN = 8;

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
    const left =
      preview.x + width + MARGIN > window.innerWidth ? preview.left - width - MARGIN : preview.x;
    const top = Math.min(preview.y, window.innerHeight - height - MARGIN);
    setPos({ left: Math.max(MARGIN, left), top: Math.max(MARGIN, top) });
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
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setPreview(null);
            send({ type: 'peekCode', node: node.id });
          }}
        >
          Peek code
        </button>
        {node.type === 'subflow' ? (
          <button
            type="button"
            onClick={() => {
              setPreview(null);
              setLevel(node.id);
            }}
          >
            Open subflow
          </button>
        ) : null}
      </footer>
    </div>
  );
}
