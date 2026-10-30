import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { DomSummary } from '../core/protocol';
import { onHostMessage, send } from './bus';
import { FlowCanvas } from './canvas/FlowCanvas';
import { Banner } from './panels/Banner';
import { BoundaryPanel } from './panels/BoundaryPanel';
import { DecisionDialog } from './panels/DecisionDialog';
import { DriftPanel, IgnoreDialog, NodeCodePanel } from './panels/DriftPanel';
import { FlowDescription } from './panels/FlowDescription';
import { Inspector } from './panels/Inspector';
import { AcceptDialog, LensBrowser, LensPanel } from './panels/LensPanel';
import { NotAFlow } from './panels/NotAFlow';
import { Palette } from './panels/Palette';
import { PickBar } from './panels/PickBar';
import { PortMenu } from './panels/PortMenu';
import { PreviewCard } from './panels/PreviewCard';
import { QuickAdd } from './panels/QuickAdd';
import { NodeRunPanel, RunPanel, WireRunPanel } from './panels/RunPanel';
import { SelectionPanel } from './panels/SelectionPanel';
import { TopBar } from './panels/TopBar';
import { Properties } from './properties/Properties';
import { useUi } from './store';
import { applyTheme, themeKindOf } from './theme/tokens';

function domSummary(docVersion: number): DomSummary {
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
  return {
    docVersion,
    level: useUi.getState().level,
    nodes,
    edges: document.querySelectorAll('.react-flow__edge').length,
    banner: banner ? Number(banner.dataset.bannerCount) : null,
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

/** Theme tokens follow VS Code's theme class on <body>. */
function useThemeTokens() {
  useEffect(() => {
    const apply = () => applyTheme(document.documentElement, themeKindOf(document.body));
    apply();
    const obs = new MutationObserver(apply);
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
}

/** Wires host messages into the store; in test mode also reports render timings and DOM. */
function useHost() {
  const received = useRef<{ version: number; at: number } | null>(null);
  const firstDone = useRef(false);
  useEffect(() => {
    const off = onHostMessage((m) => {
      const ui = useUi.getState();
      if (m.type === 'snapshot') {
        received.current = { version: m.snapshot.docVersion, at: performance.now() };
        ui.setSnapshot(m.snapshot);
      } else if (m.type === 'run') {
        ui.setRun(m.run);
      } else if (m.type === 'config') {
        ui.setTestMode(m.testMode);
      } else if (m.type === 'reveal') {
        ui.reveal(m.node);
      } else if (m.type === 'setMode') {
        ui.setMode(m.mode);
      } else if (m.type === 'openLevel') {
        ui.setLevel(m.level);
      } else if (m.type === 'catalogStatus') {
        ui.setCatalog(m.status);
      } else if (m.type === 'sync') {
        ui.setSync({ state: m.state, scan: m.scan, error: m.error });
      } else if (m.type === 'lensFacts') {
        ui.setLensFacts(m.facts);
      } else if (m.type === 'setLens') {
        ui.setLens(m.lens);
      } else if (m.type === 'openProperties') {
        ui.reveal(m.node);
        ui.openProperties(m.node, m.tab);
      } else if (m.type === 'inspect') {
        send({
          type: 'inspectResult',
          reqId: m.reqId,
          result: domSummary(ui.snapshot?.docVersion ?? -1),
        });
      }
    });
    const onCsp = (e: SecurityPolicyViolationEvent) =>
      send({ type: 'cspViolation', detail: `${e.violatedDirective} ${e.blockedURI}` });
    document.addEventListener('securitypolicyviolation', onCsp);
    send({ type: 'ready' });
    return () => {
      off();
      document.removeEventListener('securitypolicyviolation', onCsp);
    };
  }, []);

  const snapshot = useUi((s) => s.snapshot);
  const testMode = useUi((s) => s.testMode);
  useLayoutEffect(() => {
    if (!snapshot || !received.current || received.current.version !== snapshot.docVersion) return;
    const { at, version } = received.current;
    // After React committed, the next frame is when the canvas is painted.
    requestAnimationFrame(() => {
      if (!testMode) return;
      const event = firstDone.current ? 'render' : 'firstRender';
      firstDone.current = true;
      send({ type: 'perf', event, ms: performance.now() - at, docVersion: version });
    });
  }, [snapshot, testMode]);
}

export function App() {
  useThemeTokens();
  useHost();
  const snapshot = useUi((s) => s.snapshot);
  const selected = useUi((s) => s.selection.node);
  const wire = useUi((s) => s.selection.edge);
  const many = useUi((s) => s.selection.nodes);
  const level = useUi((s) => s.level);
  const error = useUi((s) => s.error);
  const setError = useUi((s) => s.setError);
  const properties = useUi((s) => s.properties);
  const mode = useUi((s) => s.mode);
  const lens = useUi((s) => s.lens);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error, setError]);

  if (!snapshot) return <div className="afd-loading">Loading flow…</div>;
  if (!snapshot.doc) return <NotAFlow snapshot={snapshot} />;
  return (
    // A fresh React Flow store per level: each level keeps its own viewport (D-23).
    <ReactFlowProvider key={level}>
      <div className="afd-shell">
        <TopBar />
        {lens ? <LensBrowser /> : <Palette />}
        <main className="afd-center">
          <Banner />
          <PickBar />
          <FlowCanvas />
        </main>
        <aside
          className="afd-right"
          aria-label={
            lens && !selected && !wire
              ? 'Lens findings'
              : mode === 'implementation'
                ? 'Design vs code'
                : mode === 'run'
                  ? 'Run results'
                  : selected
                    ? 'Node inspector'
                    : 'Flow description'
          }
        >
          {lens && !selected && !wire && !many ? (
            <LensPanel />
          ) : mode === 'implementation' ? (
            selected ? (
              <NodeCodePanel id={selected} />
            ) : (
              <DriftPanel />
            )
          ) : mode === 'run' ? (
            selected ? (
              <NodeRunPanel id={selected} />
            ) : wire && !/^(entry|exit):/.test(wire) ? (
              <WireRunPanel edge={wire} />
            ) : (
              <RunPanel />
            )
          ) : many?.length ? (
            <SelectionPanel ids={many} />
          ) : selected ? (
            <Inspector id={selected} />
          ) : wire && /^(entry|exit):/.test(wire) ? (
            <BoundaryPanel edge={wire} />
          ) : (
            <FlowDescription />
          )}
        </aside>
        <QuickAdd />
        <DecisionDialog />
        <IgnoreDialog />
        <AcceptDialog />
        <PortMenu />
        <PreviewCard />
        {properties ? <Properties key={properties.node} node={properties.node} /> : null}
        {error ? (
          <div className="afd-toast" role="alert">
            <span className="codicon codicon-error" aria-hidden="true" /> {error}
          </div>
        ) : null}
      </div>
    </ReactFlowProvider>
  );
}
