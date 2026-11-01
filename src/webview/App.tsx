import { ReactFlowProvider } from '@xyflow/react';
import { type CSSProperties, useEffect, useLayoutEffect, useRef } from 'react';
import { loadState, onHostMessage, saveState, send } from './bus';
import { FlowCanvas } from './canvas/FlowCanvas';
import { copySelection, installClipboard, pasteText } from './clipboard';
import { Details } from './details/Details';
import { deleteSelection } from './editActions';
import { domSummary } from './inspect';
import { installKeyboard } from './keyboard';
import { CanvasContextMenu } from './menu/CanvasContextMenu';
import { Banner } from './panels/Banner';
import { BoundaryPanel } from './panels/BoundaryPanel';
import { CheatSheet } from './panels/CheatSheet';
import { DecisionDialog } from './panels/DecisionDialog';
import { DriftPanel, IgnoreDialog } from './panels/DriftPanel';
import { FlowDescription } from './panels/FlowDescription';
import { AcceptDialog, LensBrowser, LensPanel } from './panels/LensPanel';
import { NotAFlow } from './panels/NotAFlow';
import { Palette } from './panels/Palette';
import { PickBar } from './panels/PickBar';
import { PortMenu } from './panels/PortMenu';
import { PreviewCard } from './panels/PreviewCard';
import { QuickAdd } from './panels/QuickAdd';
import { RunPanel, WireRunPanel } from './panels/RunPanel';
import { SelectionPanel } from './panels/SelectionPanel';
import { TestedDialog } from './panels/TestedDialog';
import { TopBar } from './panels/TopBar';
import { svgToPng } from './rasterize';
import { type RightPanel, rightPanelFor, rightPanelLabel } from './rightPanel';
import { PANEL_WIDTH, useUi } from './store';
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
      } else if (m.type === 'openDetails') {
        ui.reveal(m.node);
        ui.openDetails(m.node, m.tab);
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
    case 'drift':
      return <DriftPanel />;
    case 'wireRun':
      return <WireRunPanel edge={panel.edge} />;
    case 'run':
      return <RunPanel />;
    case 'selection':
      return <SelectionPanel ids={panel.ids} />;
    case 'details':
      // Keyed by node: a staged binding belongs to the node it was staged on.
      return <Details key={panel.id} id={panel.id} context={panel.context} />;
    case 'boundary':
      return <BoundaryPanel edge={panel.edge} />;
    case 'flow':
      return <FlowDescription />;
  }
}

interface PanelState {
  panelWidth?: number;
  expanded?: boolean;
}

/** The side panel's width and expanded state survive a reload of the designer (AFD-43). */
function usePanelState() {
  useEffect(() => {
    const saved = loadState<PanelState>();
    if (typeof saved.panelWidth === 'number') useUi.getState().setPanelWidth(saved.panelWidth);
    if (saved.expanded) useUi.getState().setExpanded(true);
    return useUi.subscribe((s, before) => {
      if (s.panelWidth === before.panelWidth && s.expanded === before.expanded) return;
      saveState({ ...loadState(), panelWidth: s.panelWidth, expanded: s.expanded });
    });
  }, []);
}

/** The side panel's left edge: drag it, or focus it and use the arrow keys (AFD-43). */
function PanelResizer() {
  const width = useUi((s) => s.panelWidth);
  const expanded = useUi((s) => s.expanded);
  const set = (w: number) => {
    useUi.getState().setExpanded(false);
    useUi.getState().setPanelWidth(w);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA pattern for a splitter
    <div
      className="afd-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side panel"
      aria-valuemin={PANEL_WIDTH.min}
      aria-valuemax={PANEL_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === 'ArrowLeft') set(width + step);
        else if (e.key === 'ArrowRight') set(width - step);
        else return;
        e.preventDefault();
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const start = e.clientX;
        const from = expanded
          ? (e.currentTarget.parentElement?.getBoundingClientRect().width ?? width)
          : width;
        const move = (m: PointerEvent) => set(from + (start - m.clientX));
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
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
  const panelWidth = useUi((s) => s.panelWidth);
  const expanded = useUi((s) => s.expanded);
  usePanelState();
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
      <div
        className="afd-shell"
        style={
          {
            '--afd-right-width': expanded ? 'min(1100px, 80vw)' : `${panelWidth}px`,
          } as CSSProperties
        }
      >
        <TopBar />
        {lens ? <LensBrowser /> : <Palette />}
        <main className="afd-center">
          <Banner />
          <PickBar />
          <FlowCanvas />
        </main>
        <aside className="afd-right" aria-label={rightPanelLabel(panel)}>
          <PanelResizer />
          <RightPanelView panel={panel} />
        </aside>
        <QuickAdd />
        <DecisionDialog />
        <IgnoreDialog />
        <AcceptDialog />
        <TestedDialog />
        <PortMenu />
        <CanvasContextMenu />
        <CheatSheet />
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
