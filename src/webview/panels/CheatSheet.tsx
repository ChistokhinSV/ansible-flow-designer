// The keyboard shortcuts (AFD-18), opened with `?` or from the top bar's "…" menu. The table is
// the one the menus show their hints from.
import { SHORTCUTS } from '../shortcuts';
import { useUi } from '../store';

const GROUPS = ['Edit', 'Move around', 'Canvas', 'Flow'] as const;

export function CheatSheet() {
  const open = useUi((s) => s.cheatSheet);
  const show = useUi((s) => s.showCheatSheet);
  if (!open) return null;
  return (
    <div className="afd-modal-backdrop nokey">
      <div
        className="afd-modal afd-cheatsheet"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard Shortcuts"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            show(false);
          }
        }}
      >
        <div className="afd-cheatsheet-head">
          <h2>Keyboard Shortcuts</h2>
          <button
            type="button"
            className="icon"
            aria-label="Close"
            // biome-ignore lint/a11y/noAutofocus: the dialog takes the focus so Escape reaches it
            autoFocus
            onClick={() => show(false)}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
        {GROUPS.map((group) => (
          <section key={group}>
            <h3>{group}</h3>
            <dl>
              {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                <div key={s.id} data-shortcut={s.id}>
                  <dt>
                    <kbd>{s.keys}</kbd>
                  </dt>
                  <dd>{s.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p className="muted">
          Right-click a node, a wire or the canvas for everything you can do there.
        </p>
      </div>
    </div>
  );
}
