// Port menu (04 §3, mockup 07): opened by clicking a port on the canvas or the menu button of a
// port in the inspector. Suggestions for open ports, edit actions for connected ones.
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildModel } from '../../core/flow/model';
import { portMenu } from '../../core/flow/portMenu';
import { runPortItem } from '../portActions';
import { useUi } from '../store';

const MARGIN = 8;

export function PortMenu() {
  const menu = useUi((s) => s.portMenu);
  const snapshot = useUi((s) => s.snapshot);
  const close = useUi((s) => s.openPortMenu);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const content = useMemo(
    () => (menu && snapshot?.doc ? portMenu(buildModel(snapshot.doc), menu.ref) : undefined),
    [menu, snapshot],
  );
  const reason = (snapshot?.doc?.decisions ?? []).find(
    (d) => d?.node === menu?.ref.node && d.port === menu?.ref.port,
  )?.reason;

  // Keep the menu inside the window; a port near the right or bottom edge opens it the other way.
  useLayoutEffect(() => {
    if (!menu || !box.current) {
      setPos(null);
      return;
    }
    const { width, height } = box.current.getBoundingClientRect();
    const left = menu.x + width + MARGIN > window.innerWidth ? menu.x - width - 16 : menu.x;
    const top = Math.min(menu.y, window.innerHeight - height - MARGIN);
    setPos({ left: Math.max(MARGIN, left), top: Math.max(MARGIN, top) });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    box.current
      ?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
      ?.focus();
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [menu, close]);

  if (!menu || !content) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(null);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [
      ...(box.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ) ?? []),
    ];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    next?.focus();
  };

  return (
    <div
      ref={box}
      className="afd-port-menu"
      role="menu"
      aria-label={`${content.node.title} · ${menu.ref.port}`}
      data-port-menu={`${menu.ref.node}|${menu.ref.port}`}
      style={
        pos ? { left: pos.left, top: pos.top } : { left: menu.x, top: menu.y, visibility: 'hidden' }
      }
      onKeyDown={onKeyDown}
    >
      <div className="afd-port-menu-head">
        <span>
          <strong>{content.node.title}</strong> · <span className="mono">{menu.ref.port}</span>
        </span>
        <button type="button" className="icon" aria-label="Close menu" onClick={() => close(null)}>
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </div>
      {reason ? <p className="afd-port-menu-note">Open on purpose: {reason}</p> : null}
      {content.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.kind === 'later'}
          title={'hint' in item ? item.hint : undefined}
          onClick={() => void runPortItem(item, menu.ref)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
