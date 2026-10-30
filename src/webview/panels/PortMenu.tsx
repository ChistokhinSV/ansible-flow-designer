// Port menu (04 §3, mockup 07): opened by clicking a port on the canvas, right-clicking it, or the
// menu button of a port in the inspector. Suggestions for open ports, edit actions for connected
// ones. Drawn by the shared menu (AFD-18).
import { useMemo } from 'react';
import { buildModel } from '../../core/flow/model';
import { portMenu } from '../../core/flow/portMenu';
import { Menu } from '../menu/Menu';
import { runPortItem } from '../portActions';
import { useUi } from '../store';

export function PortMenu() {
  const menu = useUi((s) => s.portMenu);
  const snapshot = useUi((s) => s.snapshot);
  const close = useUi((s) => s.openPortMenu);

  const content = useMemo(
    () => (menu && snapshot?.doc ? portMenu(buildModel(snapshot.doc), menu.ref) : undefined),
    [menu, snapshot],
  );
  if (!menu || !content) return null;
  const reason = (snapshot?.doc?.decisions ?? []).find(
    (d) => d?.node === menu.ref.node && d.port === menu.ref.port,
  )?.reason;

  return (
    <Menu
      x={menu.x}
      y={menu.y}
      label={`${content.node.title} · ${menu.ref.port}`}
      className="afd-port-menu"
      data={{ 'data-port-menu': `${menu.ref.node}|${menu.ref.port}` }}
      onClose={() => close(null)}
      header={
        <>
          <div className="afd-port-menu-head">
            <span>
              <strong>{content.node.title}</strong> · <span className="mono">{menu.ref.port}</span>
            </span>
            <button
              type="button"
              className="icon"
              aria-label="Close menu"
              onClick={() => close(null)}
            >
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          </div>
          {reason ? <p className="afd-port-menu-note">Open on purpose: {reason}</p> : null}
        </>
      }
      items={content.items.map((item) => ({
        type: 'item' as const,
        label: item.label,
        ...(item.kind === 'later' ? { disabled: item.hint } : {}),
        title: 'hint' in item ? item.hint : undefined,
        onSelect: () => void runPortItem(item, menu.ref),
      }))}
    />
  );
}
