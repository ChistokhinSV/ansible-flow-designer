import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { DomSummary } from '../core/protocol';
import { onHostMessage, send } from './bus';
import { FlowCanvas } from './canvas/FlowCanvas';
import { Banner } from './panels/Banner';
import { FlowDescription } from './panels/FlowDescription';
import { Inspector } from './panels/Inspector';
import { Palette } from './panels/Palette';
import { QuickAdd } from './panels/QuickAdd';
import { TopBar } from './panels/TopBar';
import { useUi } from './store';
import { applyTheme, themeKindOf } from './theme/tokens';

function domSummary(docVersion: number): DomSummary {
  const nodes = [...document.querySelectorAll<HTMLElement>('[data-node-id]')].map((el) => ({
    id: el.dataset.nodeId ?? '',
    ports: [...el.querySelectorAll<HTMLElement>('[data-port]')].map((p) => p.dataset.port ?? ''),
  }));
  const banner = document.querySelector<HTMLElement>('[data-banner-count]');
  return {
    docVersion,
    nodes,
    edges: document.querySelectorAll('.react-flow__edge').length,
    banner: banner ? Number(banner.dataset.bannerCount) : null,
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
      } else if (m.type === 'config') {
        ui.setTestMode(m.testMode);
      } else if (m.type === 'reveal') {
        ui.select({ node: m.node });
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
    <ReactFlowProvider>
      <div className="afd-shell">
        <TopBar />
        <Palette />
        <main className="afd-center">
          <Banner />
          <FlowCanvas />
        </main>
        <aside className="afd-right" aria-label={selected ? 'Node inspector' : 'Flow description'}>
          {selected ? <Inspector id={selected} /> : <FlowDescription />}
        </aside>
        <QuickAdd />
        {error ? (
          <div className="afd-toast" role="alert">
            <span className="codicon codicon-error" aria-hidden="true" /> {error}
          </div>
        ) : null}
      </div>
    </ReactFlowProvider>
  );
}
