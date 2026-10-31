import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { onHostMessage, send } from './bus';
import { FlowCanvas } from './canvas/FlowCanvas';
import { copySelection, installClipboard, pasteText } from './clipboard';
import { deleteSelection } from './editActions';
import { domSummary } from './inspect';
import { installKeyboard } from './keyboard';
import { CanvasContextMenu } from './menu/CanvasContextMenu';
import { Banner } from './panels/Banner';
import { BoundaryPanel } from './panels/BoundaryPanel';
import { CheatSheet } from './panels/CheatSheet';
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
import { svgToPng } from './rasterize';
import { type RightPanel, rightPanelFor, rightPanelLabel } from './rightPanel';
import { useUi } from './store';
import { applyTheme, themeKindOf } from './theme/tokens';

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
      } else if (m.type === 'clipboard') {
        if (m.action === 'copy') copySelection();
        else void pasteText(m.text, m.at);
      } else if (m.type === 'openProperties') {
        ui.reveal(m.node);
        ui.openProperties(m.node, m.tab);
      } else if (m.type === 'inspect') {
        send({
          type: 'inspectResult',
          reqId: m.reqId,
          result: domSummary(ui.snapshot?.docVersion ?? -1),
        });
      } else if (m.type === 'renderPng') {
        svgToPng(m.svg, m.width, m.height).then(
          (data) => send({ type: 'pngRendered', reqId: m.reqId, data }),
          (e: Error) => send({ type: 'pngRendered', reqId: m.reqId, error: e.message }),
        );
      }
    });
    const onCsp = (e: SecurityPolicyViolationEvent) =>
      send({ type: 'cspViolation', detail: `${e.violatedDirective} ${e.blockedURI}` });
    document.addEventListener('securitypolicyviolation', onCsp);
    const offClipboard = installClipboard((nodes) => void deleteSelection(nodes));
    const offKeyboard = installKeyboard();
    send({ type: 'ready' });
    return () => {
      off();
      offClipboard();
      offKeyboard();
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

/** The right side's panel (AFD-35: chosen by `rightPanelFor`). */
function RightPanelView({ panel }: { panel: RightPanel }) {
  switch (panel.kind) {
    case 'lens':
      return <LensPanel />;
    case 'nodeCode':
      return <NodeCodePanel id={panel.id} />;
    case 'drift':
      return <DriftPanel />;
    case 'nodeRun':
      return <NodeRunPanel id={panel.id} />;
    case 'wireRun':
      return <WireRunPanel edge={panel.edge} />;
    case 'run':
      return <RunPanel />;
    case 'selection':
      return <SelectionPanel ids={panel.ids} />;
    case 'inspector':
      return <Inspector id={panel.id} context={panel.context} />;
    case 'boundary':
      return <BoundaryPanel edge={panel.edge} />;
    case 'flow':
      return <FlowDescription />;
  }
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

  const panel = rightPanelFor({
    lens,
    mode,
    selection: { node: selected, edge: wire, nodes: many },
    level,
  });

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
        <aside className="afd-right" aria-label={rightPanelLabel(panel)}>
          <RightPanelView panel={panel} />
        </aside>
        <QuickAdd />
        <DecisionDialog />
        <IgnoreDialog />
        <AcceptDialog />
        <PortMenu />
        <CanvasContextMenu />
        <CheatSheet />
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
