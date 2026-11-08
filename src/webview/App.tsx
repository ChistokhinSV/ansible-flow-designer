import { ReactFlowProvider } from '@xyflow/react';
import { type CSSProperties, useEffect, useLayoutEffect, useRef } from 'react';
import { LENSES } from '../core/lens/types';
import { loadState, onHostMessage, onInFlight, saveState, send } from './bus';
import { FlowCanvas } from './canvas/FlowCanvas';
import { copySelection, installClipboard, pasteText } from './clipboard';
import { Details } from './details/Details';
import { deleteSelection } from './editActions';
import { onTabListKeys } from './focus';
import { domSummary } from './inspect';
import { installKeyboard } from './keyboard';
import { CanvasContextMenu } from './menu/CanvasContextMenu';
import { AnnotationPanel } from './panels/AnnotationPanel';
import { Banner, FormatBanner } from './panels/Banner';
import { BoundaryPanel } from './panels/BoundaryPanel';
import { CanvasCaption } from './panels/CanvasCaption';
import { CheatSheet } from './panels/CheatSheet';
import { DecisionDialog } from './panels/DecisionDialog';
import { DriftPanel, IgnoreDialog } from './panels/DriftPanel';
import { FlowDescription } from './panels/FlowDescription';
import { HostPickDialog } from './panels/HostPickDialog';
import { LaunchDialog } from './panels/LaunchDialog';
import { AcceptDialog, LensBrowser, LensPanel } from './panels/LensPanel';
import { NotAFlow } from './panels/NotAFlow';
import { OutsideNote } from './panels/OutsideNote';
import { Palette } from './panels/Palette';
import { PickBar } from './panels/PickBar';
import { PortMenu } from './panels/PortMenu';
import { PreviewCard } from './panels/PreviewCard';
import { QuickAdd } from './panels/QuickAdd';
import { RunPanel, WireRunPanel } from './panels/RunPanel';
import { ScenariosPanel } from './panels/ScenariosPanel';
import { SelectionPanel } from './panels/SelectionPanel';
import { TestedDialog } from './panels/TestedDialog';
import { Toasts } from './panels/Toasts';
import { TopBar } from './panels/TopBar';
import { WirePanel } from './panels/WirePanel';
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
      } else if (m.type === 'launch') {
        ui.setLaunch(m.plan, m.notice);
      } else if (m.type === 'launchFacts') {
        ui.setLaunchFacts(m.token, m.facts, m.error);
      } else if (m.type === 'scenarios') {
        ui.setScenarios(m.results, m.show);
      } else if (m.type === 'scenarioCheck') {
        ui.setScenarioCheck(m.check, m.undo);
      } else if (m.type === 'outsideMarks') {
        ui.setOutside(m.marks);
      } else if (m.type === 'repoState') {
        ui.setRepo(m.state);
      } else if (m.type === 'config') {
        ui.setTestMode(m.testMode);
      } else if (m.type === 'firstFlow') {
        ui.setFirstFlow({ hidden: m.hidden, done: m.done });
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
      } else if (m.type === 'notify') {
        ui.notify(m.level, m.text);
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
    const offInFlight = onInFlight((n) => useUi.setState({ saving: n > 0 }));
    send({ type: 'ready' });
    return () => {
      off();
      offClipboard();
      offKeyboard();
      offInFlight();
      document.removeEventListener('securitypolicyviolation', onCsp);
    };
  }, []);

  const snapshot = useUi((s) => s.snapshot);
  const testMode = useUi((s) => s.testMode);
  useLayoutEffect(() => {
    if (!snapshot || !received.current || received.current.version !== snapshot.docVersion) return;
    const { at, version } = received.current;
    // After React committed, the next frame is when the canvas is painted (the perf measure).
    requestAnimationFrame(() => {
      if (!testMode) return;
      const event = firstDone.current ? 'render' : 'firstRender';
      firstDone.current = true;
      send({ type: 'perf', event, ms: performance.now() - at, docVersion: version });
      // AFD-97: React Flow shows a node, and draws the wires to it, only once it has measured it
      // (hidden until then), a frame or more later. Tests wait for "drawn", so they never read a
      // canvas with its nodes and none of their wires.
      let frames = 0;
      const drawn = () => {
        const measuring = document.querySelector('.react-flow__node[style*="visibility: hidden"]');
        if (measuring && frames++ < 60) return requestAnimationFrame(drawn);
        requestAnimationFrame(() =>
          send({ type: 'perf', event: 'drawn', ms: performance.now() - at, docVersion: version }),
        );
      };
      drawn();
    });
  }, [snapshot, testMode]);
}

/** The right side's panel (AFD-35: chosen by `rightPanelFor`). */
function RightPanelView({ panel }: { panel: RightPanel }) {
  switch (panel.kind) {
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
    case 'wire':
      return <WirePanel edge={panel.edge} />;
    case 'annotation':
      return <AnnotationPanel id={panel.id} />;
    case 'flow':
      return <FlowDescription />;
  }
}

interface PanelState {
  panelWidth?: number;
  expanded?: boolean;
  paletteCollapsed?: boolean;
  panelCollapsed?: boolean;
  annotationsHidden?: boolean;
}

/** The side panel's width and expanded state survive a reload of the designer (AFD-43). */
function usePanelState() {
  useEffect(() => {
    const saved = loadState<PanelState>();
    if (typeof saved.panelWidth === 'number') useUi.getState().setPanelWidth(saved.panelWidth);
    if (saved.expanded) useUi.getState().setExpanded(true);
    if (saved.paletteCollapsed) useUi.getState().setPaletteCollapsed(true);
    if (saved.panelCollapsed) useUi.getState().setPanelCollapsed(true);
    if (saved.annotationsHidden) useUi.getState().setAnnotationsHidden(true);
    return useUi.subscribe((s, before) => {
      if (
        s.panelWidth === before.panelWidth &&
        s.expanded === before.expanded &&
        s.paletteCollapsed === before.paletteCollapsed &&
        s.panelCollapsed === before.panelCollapsed &&
        s.annotationsHidden === before.annotationsHidden
      )
        return;
      saveState({
        ...loadState(),
        panelWidth: s.panelWidth,
        expanded: s.expanded,
        paletteCollapsed: s.paletteCollapsed,
        panelCollapsed: s.panelCollapsed,
        annotationsHidden: s.annotationsHidden,
      });
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
        // The window splitter pattern: Enter folds the panel away (AFD-48).
        else if (e.key === 'Enter') useUi.getState().setPanelCollapsed(true);
        else return;
        e.preventDefault();
      }}
      onDoubleClick={() => useUi.getState().setPanelCollapsed(true)}
      onPointerDown={(e) => {
        e.preventDefault();
        const start = e.clientX;
        const handle = e.currentTarget;
        const from = expanded
          ? (handle.parentElement?.getBoundingClientRect().width ?? width)
          : width;
        // AFD-164: the pointer is captured, so a release outside the webview's frame still ends
        // the drag (a pointerup on window was lost there and the panel kept following the mouse).
        // A move with no button down, or a cancelled pointer, ends it too.
        const end = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', end);
          handle.removeEventListener('pointercancel', end);
          handle.removeEventListener('lostpointercapture', end);
          if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        };
        const move = (m: PointerEvent) => {
          if (m.buttons === 0) end();
          else set(from + (start - m.clientX));
        };
        handle.setPointerCapture?.(e.pointerId);
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
        handle.addEventListener('lostpointercapture', end);
      }}
    />
  );
}

/** With a lens on, the right panel has two tabs: the mode's panel and the lens (AFD-45). */
function RightTabs({ label, lensTab }: { label: string; lensTab: boolean }) {
  const lens = useUi((s) => s.lens);
  const findings = useUi((s) => s.lensView?.findings.length ?? 0);
  const showLens = useUi((s) => s.showLensTab);
  // AFD-116: the Scenarios tab, once opened from the top bar's chip.
  const scenarios = useUi((s) => s.scenariosOpen);
  const scenariosTab = useUi((s) => s.scenariosTab);
  const showScenarios = useUi((s) => s.showScenariosTab);
  const failing = useUi((s) => s.scenarioCheck?.results.filter((r) => !r.passed).length ?? 0);
  const show = (on: boolean) => {
    showScenarios(false);
    showLens(on);
  };
  const panel = !lensTab && !scenariosTab;
  const name = LENSES.find((l) => l.id === lens)?.label ?? lens;
  return (
    <div
      className="afd-props-tabs afd-right-tabs"
      role="tablist"
      aria-label="Side panel"
      onKeyDown={onTabListKeys}
    >
      <button
        type="button"
        role="tab"
        aria-selected={panel}
        tabIndex={panel ? 0 : -1}
        className={panel ? 'active' : ''}
        onClick={() => show(false)}
      >
        {label}
      </button>
      {lens ? (
        <button
          type="button"
          role="tab"
          aria-selected={lensTab}
          tabIndex={lensTab ? 0 : -1}
          className={lensTab ? 'active' : ''}
          onClick={() => show(true)}
        >
          Lens: {name} {findings ? <span className="afd-chip">{findings}</span> : null}
        </button>
      ) : null}
      {scenarios ? (
        <button
          type="button"
          role="tab"
          aria-selected={scenariosTab}
          tabIndex={scenariosTab ? 0 : -1}
          className={scenariosTab ? 'active' : ''}
          data-tab="scenarios"
          onClick={() => showScenarios(true)}
        >
          Scenarios {failing ? <span className="afd-chip">{failing}</span> : null}
        </button>
      ) : null}
    </div>
  );
}

export function App() {
  useThemeTokens();
  useHost();
  const snapshot = useUi((s) => s.snapshot);
  const selected = useUi((s) => s.selection.node);
  const wire = useUi((s) => s.selection.edge);
  const many = useUi((s) => s.selection.nodes);
  const notes = useUi((s) => s.selection.annotations);
  const level = useUi((s) => s.level);
  const panelWidth = useUi((s) => s.panelWidth);
  const lensTab = useUi((s) => s.lens !== null && s.lensTab);
  const scenariosOpen = useUi((s) => s.scenariosOpen);
  const scenariosTab = useUi((s) => s.scenariosOpen && s.scenariosTab);
  // AFD-87: the lens tab keeps its place while a step's Details are checked (round 1: W14).
  const right = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    // The step's Details start at their top.
    if (right.current) right.current.scrollTop = lensTab ? useUi.getState().lensScroll : 0;
  }, [lensTab]);
  const expanded = useUi((s) => s.expanded);
  const panelCollapsed = useUi((s) => s.panelCollapsed);
  const paletteCollapsed = useUi((s) => s.paletteCollapsed);
  usePanelState();
  const mode = useUi((s) => s.mode);
  const lens = useUi((s) => s.lens);
  const panel = rightPanelFor({
    lens,
    mode,
    selection: { node: selected, edge: wire, nodes: many, annotations: notes },
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
            '--afd-right-width': panelCollapsed
              ? 'var(--afd-collapsed-width)'
              : expanded
                ? 'min(1100px, 80vw)'
                : `${panelWidth}px`,
            // Code and Run modes read the graph: no palette to add nodes from (AFD-45).
            ...(mode !== 'design'
              ? { '--afd-left-width': '0px' }
              : paletteCollapsed
                ? { '--afd-left-width': 'var(--afd-collapsed-width)' }
                : {}),
          } as CSSProperties
        }
      >
        <TopBar />
        {mode === 'design' ? <Palette /> : null}
        <main className="afd-center">
          <Banner />
          <FormatBanner />
          <PickBar />
          <CanvasCaption />
          <OutsideNote />
          <FlowCanvas />
          <Toasts />
        </main>
        {panelCollapsed ? (
          <aside className="afd-right collapsed" aria-label="Side panel, hidden">
            <button
              type="button"
              className="icon"
              aria-label="Show Side Panel"
              title="Show the side panel"
              onClick={() => useUi.getState().setPanelCollapsed(false)}
            >
              <span className="codicon codicon-layout-sidebar-right" aria-hidden="true" />
            </button>
          </aside>
        ) : (
          <aside
            ref={right}
            className="afd-right"
            aria-label={lensTab ? 'Lens' : scenariosTab ? 'Scenarios' : rightPanelLabel(panel)}
            onScroll={(e) => {
              // The resizer follows the scroll, so it spans the panel's whole visible edge (round
              // 3: R11; it scrolled away with the content and was left on the top part).
              e.currentTarget.style.setProperty(
                '--afd-right-scroll',
                `${e.currentTarget.scrollTop}px`,
              );
              if (lensTab) useUi.setState({ lensScroll: e.currentTarget.scrollTop });
            }}
          >
            <PanelResizer />
            {lens || scenariosOpen ? (
              <RightTabs label={rightPanelLabel(panel)} lensTab={lensTab} />
            ) : null}
            {lensTab ? (
              <>
                <LensBrowser />
                <LensPanel />
              </>
            ) : scenariosTab ? (
              <ScenariosPanel />
            ) : (
              <RightPanelView panel={panel} />
            )}
          </aside>
        )}
        <QuickAdd />
        <DecisionDialog />
        <IgnoreDialog />
        <AcceptDialog />
        <TestedDialog />
        <HostPickDialog />
        <PortMenu />
        <CanvasContextMenu />
        <CheatSheet />
        <LaunchDialog />
        <PreviewCard />
      </div>
    </ReactFlowProvider>
  );
}
