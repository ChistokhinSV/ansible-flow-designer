// The keyboard shortcuts (AFD-18), opened with `?` or from the top bar's "…" menu. The table is
// the one the menus show their hints from.
import { useRef } from 'react';
import { checkButton } from '../../core/run/words';
import { useDialogFocus } from '../focus';
import { IS_MAC, SHORTCUTS, type Shortcut } from '../shortcuts';
import { useUi } from '../store';

const GROUPS = ['Edit', 'Move around', 'Canvas', 'Flow'] as const;

/**
 * AFD-344: in the server's pages, undo and redo are the server's (a person's own edits of the
 * shared draft, Ctrl+Y or Ctrl+Shift+Z for redo), not VS Code's.
 */
const SERVER_WORDS: Partial<Record<Shortcut['id'], Pick<Shortcut, 'keys' | 'label'>>> = {
  undo: {
    keys: IS_MAC ? '⌘Z' : 'Ctrl+Z',
    label: "Undo your own last edit (the others' edits stay)",
  },
  redo: {
    keys: IS_MAC ? '⇧⌘Z, ⌘Y' : 'Ctrl+Y, Ctrl+Shift+Z',
    label: 'Redo: bring back what Undo took, until you make a new edit',
  },
};

export function CheatSheet() {
  const open = useUi((s) => s.cheatSheet);
  return open ? <Sheet /> : null;
}

function Sheet() {
  const show = useUi((s) => s.showCheatSheet);
  const words = useUi((s) => s.embed.words);
  const box = useRef<HTMLDivElement>(null);
  const trap = useDialogFocus(box);
  return (
    <div className="afd-modal-backdrop nokey">
      <div
        ref={box}
        className="afd-modal afd-cheatsheet"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard Shortcuts"
        onKeyDown={(e) => {
          trap(e);
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
              {SHORTCUTS.filter((s) => s.group === group).map((shortcut) => {
                const s =
                  words === 'server' ? { ...shortcut, ...SERVER_WORDS[shortcut.id] } : shortcut;
                return (
                  <div key={s.id} data-shortcut={s.id}>
                    <dt>
                      <kbd>{s.keys}</kbd>
                    </dt>
                    <dd>{s.id === 'runSkeleton' ? checkButton(words) : s.label}</dd>
                  </div>
                );
              })}
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
