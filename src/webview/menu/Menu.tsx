// One menu for the whole webview (AFD-18): the canvas context menu, the port menu and the top bar
// dropdowns. VS Code menu colours, items with codicons, shortcut hints, radio checks, disabled
// items with their reason, one level of submenus. Keyboard: arrows, Home/End, Enter/Space,
// Right/Left for submenus, Escape closes one level, Tab closes all. Keys typed in a menu stop
// here (`nokey`), so neither the canvas (Delete) nor VS Code act on them; Ctrl/Cmd combinations
// pass, since VS Code turns them into copy, paste and undo.
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export type UiMenuEntry =
  | {
      type: 'item';
      label: string;
      icon?: string;
      /** Shown on the right, e.g. `Ctrl+X`. */
      shortcut?: string;
      /** Radio items: true marks the current choice, false an unchosen one. */
      checked?: boolean;
      /** Why the item cannot run now (its tooltip). */
      disabled?: string;
      /** A line under the label (the reason a canvas item is disabled). */
      note?: string;
      title?: string;
      onSelect: () => void;
    }
  | { type: 'submenu'; label: string; icon?: string; items: UiMenuEntry[] }
  | { type: 'separator' };

interface MenuProps {
  /** Anchor in client coordinates: the menu opens to its right and below, flipping at the edges. */
  x: number;
  y: number;
  label: string;
  items: UiMenuEntry[];
  /** Closes every level. */
  onClose: () => void;
  header?: ReactNode;
  className?: string;
  /** `data-*` attributes for tests and the integration summary. */
  data?: Record<string, string>;
  /** Clicks and focus here do not count as outside (the button that toggles the menu). */
  opener?: HTMLElement | null;
  /** A submenu: the parent item's left edge, where it opens when there is no room on the right. */
  flipX?: number;
  /** A submenu closes itself only (Left, Escape) and gives focus back to its item. */
  onBack?: () => void;
}

const MARGIN = 8;
const ITEM = '[role^="menuitem"]';

function enabledItems(box: HTMLElement | null): HTMLElement[] {
  return [...(box?.querySelectorAll<HTMLElement>(`:scope > ${ITEM}`) ?? [])].filter(
    (el) => el.getAttribute('aria-disabled') !== 'true',
  );
}

export function Menu(props: MenuProps) {
  const { x, y, label, items, onClose, header, className, data, opener, flipX, onBack } = props;
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flipX: number } | null>(
    null,
  );
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Where focus was when the menu opened: it goes back there when the menu closes.
  const [returnTo] = useState(() => (onBack ? null : document.activeElement));

  // Keep the menu inside the window: open to the left or upwards when there is no room.
  useLayoutEffect(() => {
    if (!box.current) return;
    const { width, height } = box.current.getBoundingClientRect();
    const right = x + width + MARGIN > window.innerWidth;
    const left = right ? (flipX ?? x - 16) - width : x;
    const top = Math.min(y, window.innerHeight - height - MARGIN);
    setPos({ left: Math.max(MARGIN, left), top: Math.max(MARGIN, top) });
  }, [x, y, flipX]);

  // A hidden element cannot take focus: focus the first item once the menu is placed.
  const placed = pos !== null;
  useEffect(() => {
    if (placed) enabledItems(box.current)[0]?.focus();
  }, [placed]);

  // Only while nothing else took the focus: an item that opened a dialog keeps it on the dialog.
  useEffect(
    () => () => {
      clearTimeout(hover.current);
      const back = returnTo as HTMLElement | null;
      const idle = document.activeElement === document.body || !document.activeElement;
      if (idle && back?.isConnected && typeof back.focus === 'function') back.focus();
    },
    [returnTo],
  );

  useEffect(() => {
    if (onBack) return;
    const outside = (target: EventTarget | null) => {
      const el = target as Element | null;
      return !el?.closest?.('.afd-menu') && !(opener && el instanceof Node && opener.contains(el));
    };
    const onDown = (e: PointerEvent) => {
      if (outside(e.target)) onClose();
    };
    const onFocus = (e: FocusEvent) => {
      if (e.target instanceof Element && outside(e.target)) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocus, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('focusin', onFocus, true);
    };
  }, [onClose, opener, onBack]);

  const openSub = (index: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setSub({ index, x: r.right - 2, y: r.top - 4, flipX: r.left + 2 });
  };

  const run = (entry: Extract<UiMenuEntry, { type: 'item' }>) => {
    if (entry.disabled) return;
    onClose();
    entry.onSelect();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) return;
    e.stopPropagation();
    const list = enabledItems(box.current);
    const at = list.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number) => list[(i + list.length) % list.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focus(at + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focus(at < 0 ? list.length - 1 : at - 1);
        break;
      case 'Home':
        e.preventDefault();
        focus(0);
        break;
      case 'End':
        e.preventDefault();
        focus(list.length - 1);
        break;
      case 'ArrowRight': {
        const el = document.activeElement as HTMLElement | null;
        if (el?.getAttribute('aria-haspopup') === 'menu') {
          e.preventDefault();
          openSub(Number(el.dataset.index), el);
        }
        break;
      }
      case 'ArrowLeft':
        if (onBack) {
          e.preventDefault();
          onBack();
        }
        break;
      case 'Escape':
        e.preventDefault();
        if (onBack) onBack();
        else onClose();
        break;
      case 'Tab':
        e.preventDefault();
        onClose();
        break;
    }
  };

  const open = sub ? items[sub.index] : undefined;
  return createPortal(
    <div
      ref={box}
      className={['afd-menu', 'nokey', className].filter(Boolean).join(' ')}
      role="menu"
      aria-label={label}
      {...data}
      style={pos ? { left: pos.left, top: pos.top } : { left: x, top: y, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {header}
      {items.map((entry, i) => {
        if (entry.type === 'separator')
          // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
          return <hr key={`sep-${i}`} className="afd-menu-sep" />;
        const icon = entry.icon ? (
          <span className={`codicon codicon-${entry.icon}`} aria-hidden="true" />
        ) : null;
        if (entry.type === 'submenu')
          return (
            <button
              key={`sub-${entry.label}`}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={sub?.index === i}
              data-index={i}
              className={sub?.index === i ? 'afd-menu-open' : undefined}
              onClick={(e) => openSub(i, e.currentTarget)}
              onMouseEnter={(e) => {
                const el = e.currentTarget;
                clearTimeout(hover.current);
                hover.current = setTimeout(() => openSub(i, el), 180);
              }}
            >
              <span className="afd-menu-icon">{icon}</span>
              <span className="afd-menu-label">{entry.label}</span>
              <span className="codicon codicon-chevron-right afd-menu-more" aria-hidden="true" />
            </button>
          );
        const common = {
          type: 'button' as const,
          'aria-disabled': entry.disabled ? true : undefined,
          'aria-label': entry.shortcut || entry.note ? entry.label : undefined,
          'aria-keyshortcuts': entry.shortcut,
          title: entry.disabled ?? entry.title,
          onClick: () => run(entry),
          onMouseEnter: () => {
            clearTimeout(hover.current);
            hover.current = setTimeout(() => setSub(null), 180);
          },
        };
        const body = (mark: ReactNode) => (
          <>
            <span className="afd-menu-icon">{mark}</span>
            <span className="afd-menu-label">
              {entry.label}
              {entry.note ? <span className="afd-menu-why">{entry.note}</span> : null}
            </span>
            {entry.shortcut ? <kbd className="afd-menu-key">{entry.shortcut}</kbd> : null}
          </>
        );
        if (entry.checked !== undefined)
          return (
            <button
              key={`item-${entry.label}`}
              {...common}
              role="menuitemradio"
              aria-checked={entry.checked}
            >
              {body(
                entry.checked ? (
                  <span className="codicon codicon-check" aria-hidden="true" />
                ) : null,
              )}
            </button>
          );
        return (
          <button key={`item-${entry.label}`} {...common} role="menuitem">
            {body(icon)}
          </button>
        );
      })}
      {open?.type === 'submenu' && sub ? (
        <Menu
          x={sub.x}
          y={sub.y}
          flipX={sub.flipX}
          label={open.label}
          items={open.items}
          onClose={onClose}
          onBack={() => {
            const index = sub.index;
            setSub(null);
            box.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
