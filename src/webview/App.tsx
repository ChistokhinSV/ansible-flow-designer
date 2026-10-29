import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { DomSummary } from '../core/protocol';
import { onHostMessage, send } from './bus';
import { FlowCanvas } from './canvas/FlowCanvas';
import { Banner } from './panels/Banner';
import { BoundaryPanel } from './panels/BoundaryPanel';
import { DecisionDialog } from './panels/DecisionDialog';
import { FlowDescription } from './panels/FlowDescription';
import { Inspector } from './panels/Inspector';
import { Palette } from './panels/Palette';
import { PickBar } from './panels/PickBar';
import { PortMenu } from './panels/PortMenu';
import { PreviewCard } from './panels/PreviewCard';
import { QuickAdd } from './panels/QuickAdd';
import { TopBar } from './panels/TopBar';
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
      } else if (m.type === 'openLevel') {
        ui.setLevel(m.level);
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
  const level = useUi((s) => s.level);
  const error = useUi((s) => s.error);
  const setError = useUi((s) => s.setError);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error, setError]);

  if (!snapshot) return <div className="afd-loading">Loading flow…</div>;
  if (!snapshot.doc) {
    return (
      <div className="afd-loading" role="alert">
        This file is not a valid flow document: {snapshot.parseError}
        <button type="button" onClick={() => send({ type: 'openText' })}>
          Open as text
        </button>
      </div>
    );
  }
  return (
    // A fresh React Flow store per level: each level keeps its own viewport (D-23).
    <ReactFlowProvider key={level}>
      <div className="afd-shell">
        <TopBar />
        <Palette />
        <main className="afd-center">
          <Banner />
          <PickBar />
          <FlowCanvas />
        </main>
        <aside className="afd-right" aria-label={selected ? 'Node inspector' : 'Flow description'}>
          {selected ? (
            <Inspector id={selected} />
          ) : wire && /^(entry|exit):/.test(wire) ? (
            <BoundaryPanel edge={wire} />
          ) : (
            <FlowDescription />
          )}
        </aside>
        <QuickAdd />
        <DecisionDialog />
        <PortMenu />
        <PreviewCard />
        {error ? (
          <div className="afd-toast" role="alert">
            <span className="codicon codicon-error" aria-hidden="true" /> {error}
          </div>
        ) : null}
      </div>
    </ReactFlowProvider>
  );
}
