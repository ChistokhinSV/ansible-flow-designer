// What the integration tests read from the rendered designer (test mode only): nodes and their
// ports, the banner, the boundary frame, Run mode states and the lens chips (AFD-35: out of App).
import type { DomSummary } from '../core/protocol';
import { useUi } from './store';

export function domSummary(docVersion: number): DomSummary {
  const nodes = [...document.querySelectorAll<HTMLElement>('[data-node-id]')].map((el) => {
    const handles = [...el.querySelectorAll<HTMLElement>('[data-port]')];
    const names = (pred: (p: HTMLElement) => boolean) =>
      handles.filter(pred).map((p) => p.dataset.port ?? '');
    return {
      id: el.dataset.nodeId ?? '',
      legal: names(() => true),
      ports: names((p) => p.dataset.portState !== 'available'),
      rest: names((p) => p.dataset.rest === 'true'),
    };
  });
  const banner = document.querySelector<HTMLElement>('[data-banner-count]');
  const frame = document.querySelector<HTMLElement>('[data-frame]');
  const gaps = document.querySelector<HTMLElement>('[data-id-gaps]');
  return {
    docVersion,
    level: useUi.getState().level,
    nodes,
    edges: document.querySelectorAll('.react-flow__edge').length,
    annotations: document.querySelectorAll('[data-annotation-id]').length,
    banner: banner ? Number(banner.dataset.bannerCount) : null,
    idGaps: gaps ? Number(gaps.dataset.idGaps) : null,
    frame: frame
      ? {
          ports: [...frame.querySelectorAll<HTMLElement>('[data-frame-port]')]
            .filter((p) => p.dataset.portState !== 'available')
            .map((p) => p.dataset.framePort ?? ''),
          wires: document.querySelectorAll('.afd-boundary-edge').length,
        }
      : null,
    run:
      useUi.getState().mode === 'run'
        ? {
            nodes: Object.fromEntries(
              [...document.querySelectorAll<HTMLElement>('[data-node-id]')].map((el) => [
                el.dataset.nodeId ?? '',
                el.dataset.runState ?? '',
              ]),
            ),
            wires: Object.fromEntries(
              [...document.querySelectorAll<SVGElement>('.react-flow__edge[data-id]')].map((el) => [
                el.dataset.id ?? '',
                el.querySelector('.react-flow__edge-text')?.textContent ?? '',
              ]),
            ),
          }
        : undefined,
    lens: lensSummary(),
  };
}

function lensSummary(): DomSummary['lens'] {
  const ui = useUi.getState();
  if (!ui.lens) return undefined;
  const nodes = [...document.querySelectorAll<HTMLElement>('[data-node-id]')];
  return {
    lens: ui.lens,
    chips: Object.fromEntries(
      nodes.map((el) => {
        const chips = el.dataset.lens ?? '';
        return [el.dataset.nodeId ?? '', chips ? chips.split('|') : []];
      }),
    ),
    findings: [...document.querySelectorAll<HTMLElement>('[data-finding]')].map(
      (el) => `${el.dataset.finding}${el.dataset.accepted ? ' (accepted)' : ''}`,
    ),
    dataWires: document.querySelectorAll('.afd-data-edge').length,
    highlighted: nodes
      .filter((el) => el.classList.contains('lens-hit'))
      .map((el) => el.dataset.nodeId ?? ''),
    card: [...document.querySelectorAll<HTMLElement>('[data-summary-card] dt')].map(
      (dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent ?? ''}`,
    ),
  };
}
