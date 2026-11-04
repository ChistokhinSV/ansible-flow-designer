import { create } from 'zustand';
import type { BindKind } from '../core/catalog/draft';
import { computeDrift } from '../core/drift/drift';
import type { CodeScan, DriftReport } from '../core/drift/types';
import type { CanvasMode, CanvasTarget } from '../core/flow/canvasMenu';
import { modelOf, ROOT } from '../core/flow/model';
import type { NodeType, PortRef, Position, Ulid } from '../core/flow/types';
import { lensView } from '../core/lens';
import type { LensFacts, LensId, LensView } from '../core/lens/types';
import type { CatalogStatus, RunView, Snapshot } from '../core/protocol';
import type { LaunchFacts, LaunchPlan } from '../core/run/launch';
import { type NodeRun, runStates } from '../core/run/view';
import type { ScenarioResult } from '../core/scenario/scenarios';
import { scenarioRun } from '../core/scenario/view';
import { markedAround, type OutsideMarks } from '../core/view/outsideChanges';
import { closing, HOLDS_POINTER, isOpen } from './overlays';

export interface QuickAddState {
  type: NodeType;
  position?: Position;
  connectFrom?: PortRef;
  /** Insert the new node on this edge (port menu "Insert node on this wire"). */
  insertOn?: Ulid;
  /** Prefilled title (port menu suggestions such as "Cleanup task"). */
  title?: string;
}

export interface Selection {
  node?: Ulid;
  edge?: Ulid;
  /** Several nodes (Ctrl/Cmd+click, Shift+drag): Extract into subflow (AFD-7). */
  nodes?: Ulid[];
  /** AFD-65: Notes, Sections and Text, alone or with nodes. */
  annotations?: Ulid[];
}

/** Port menu (04 §3), anchored at a point in the window. */
export interface PortMenuState {
  ref: PortRef;
  x: number;
  y: number;
}

/**
 * Canvas context menu (AFD-18): what was right-clicked, where (window) and the same spot on the
 * canvas, so Paste and Add node land there.
 */
export interface ContextMenuState {
  target: CanvasTarget;
  x: number;
  y: number;
  at?: Position;
}

/** A field to focus (F2 Rename, Extract, Edit reason); the nonce repeats the request. */
export interface FocusRequest {
  field: 'title' | 'extractTitle' | 'exitReason' | 'annotationText';
  nonce: number;
}

/** Hover preview card (D-22), anchored right of the node (or left of it near the window edge). */
export interface PreviewState {
  node: Ulid;
  x: number;
  y: number;
  /** Left edge of the node, for opening the card on the other side. */
  left: number;
}

/** D-22: about 400 ms of pause on a node before its card opens. */
export const PREVIEW_DELAY = 400;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let onCard = false;

/** Tabs of the Details panel (AFD-43); Code and Run modes add their own first. */
export type PropTab = 'general' | 'binding' | 'io' | 'ports' | 'execution' | 'code' | 'run';

/**
 * What the user asked for while a staged binding was not saved (AFD-43): it happens once they
 * choose to save or discard the binding, and not if they keep editing.
 */
export type Leave =
  | { kind: 'select'; selection: Selection }
  | { kind: 'level'; level: string }
  | { kind: 'mode'; mode: Mode }
  | { kind: 'reveal'; node: Ulid }
  | { kind: 'details'; node: Ulid; tab: PropTab; bindKind?: BindKind }
  // AFD-80: hiding the side panel and opening the lens tab unmount the Details too.
  | { kind: 'collapse' }
  | { kind: 'lensTab' };

/** A message over the canvas (AFD-46): what happened, as info, success or error. */
export type ToastLevel = 'info' | 'success' | 'error';
export interface Toast {
  id: number;
  level: ToastLevel;
  text: string;
}
/** How long a toast stays, in ms: errors longer, so they can be read. */
export const TOAST_MS: Record<ToastLevel, number> = { info: 4000, success: 4000, error: 9000 };
let toastId = 0;

/** The side panel's width when not expanded, in px (AFD-43). */
export const PANEL_WIDTH = { min: 260, initial: 340, max: 720 };
/**
 * Where the Binding tab lays Configure, Change Module and About side by side (AFD-80): the
 * container query in 14-node-properties-page.css. Above the docked panel's maximum, so only the
 * expanded panel reaches it, and the tab opens both folds when expanded.
 */
export const THREE_COLUMNS_PX = 760;

/**
 * Design edits the graph; Implementation shows it against the code (M6, mockup 04); Run shows what
 * the last run did per node, wire and host (M7, 04 §10).
 */
export type Mode = CanvasMode;

export interface SyncState {
  state: 'idle' | 'syncing' | 'done' | 'error';
  scan?: CodeScan;
  error?: string;
}

/** A drift item whose Ignore reason is being entered. */
export interface IgnoreTarget {
  node: Ulid;
  item: string;
  title: string;
  label: string;
}

/** A lens finding whose "Accept with Reason…" reason is being entered (M8). */
export interface AcceptTarget {
  id: string;
  node?: Ulid;
  title: string;
  /** A problem from the design check (AFD-51, format 2) rather than a lens finding. */
  check?: { code: string; subject?: string };
}

/** Waiting for a node click to finish a port menu action ("Connect to another node…"). */
export interface PickState {
  /** `attach` (AFD-65): the node a Note goes on; `ref.node` is the Note then. */
  mode: 'to' | 'from' | 'rewire' | 'attach';
  ref: PortRef;
  edge?: Ulid;
}

interface UiState {
  snapshot: Snapshot | null;
  testMode: boolean;
  /** AFD-73: the user's first-flow progress from the host; null until it says. */
  firstFlow: { hidden: boolean; done: string[] } | null;
  selection: Selection;
  quickAdd: QuickAddState | null;
  portMenu: PortMenuState | null;
  contextMenu: ContextMenuState | null;
  focusRequest: FocusRequest | null;
  /** The keyboard shortcuts sheet (`?`). */
  cheatSheet: boolean;
  /** The find bar (AFD-48): what is typed in it, and a count that moves the focus back into it. */
  find: boolean;
  findQuery: string;
  findNonce: number;
  /** A node to bring into view once its level shows (find, the failed steps, Show). */
  centerOn: Ulid | null;
  pick: PickState | null;
  /** The node Enter would choose while picking with the keyboard (AFD-47). */
  pickAt: Ulid | null;
  /** Port whose open-on-purpose reason is being entered. */
  decide: PortRef | null;
  /** Banner hidden by the user for this count of open ports. */
  bannerDismissedAt: number | null;
  /** The format banner was closed in this panel (AFD-49). */
  formatDismissed: boolean;
  /** Positions dragged locally and not yet confirmed by a snapshot. */
  optimistic: Record<Ulid, Position>;
  /** Messages over the canvas, oldest first (AFD-46). */
  toasts: Toast[];
  /** Commands sent and not answered yet: the top bar says "Saving…" (AFD-46). */
  saving: boolean;
  /** Last skeleton or real run of this flow, from the host. */
  run: RunView | null;
  /** The designer asked for a run (AFD-81): when it starts, the canvas switches to Run mode. */
  runAsked: boolean;
  /**
   * AFD-82: the open launch dialog's plan, and why it opened again. Never a secret: those stay in
   * the dialog's own state.
   */
  launch: LaunchPlan | null;
  launchNotice?: string;
  /** AFD-84: the flow's last scenario results, the one shown on the canvas, and the run it hides. */
  scenarios: ScenarioResult[] | null;
  scenarioShown: string | null;
  runBeforeScenario: RunView | null;
  /** AFD-85: what changed outside the designer since it opened, and the subflows around it. */
  outside: OutsideMarks | null;
  outsideAround: Ulid[];
  /** Run mode read-out per node for the current document and run (computed, never stored). */
  runNodes: Record<Ulid, NodeRun> | null;
  /** Level on the canvas: ROOT or the subflow node whose inner graph is open (D-23). */
  level: string;
  preview: PreviewState | null;
  /** The Details panel's tab, kept from node to node (AFD-43). */
  detailsTab: PropTab;
  /** A kind to bind first (drift "Bind role"), for one node. */
  bindKind: { node: Ulid; kind: BindKind } | null;
  /** The node whose staged binding is not saved: leaving it asks first. */
  pendingBinding: Ulid | null;
  leave: Leave | null;
  /** The side panel: its width, and expanded for the catalog docs. */
  panelWidth: number;
  expanded: boolean;
  /** The palette shows icons only; the side panel folds to a strip (AFD-48). */
  paletteCollapsed: boolean;
  panelCollapsed: boolean;
  /** AFD-65: Notes, Sections and Text hidden from the canvas (this viewer only). */
  annotationsHidden: boolean;
  /** The annotation whose text is being edited on the canvas. */
  editingAnnotation: Ulid | null;
  /** The environment's module catalog (M5). */
  catalog: CatalogStatus;
  mode: Mode;
  sync: SyncState;
  /** Design vs code for the current document and the last scan (computed, never stored). */
  drift: DriftReport | null;
  ignore: IgnoreTarget | null;
  /** The lens across the canvas (D-18, M8), independent of mode. */
  lens: LensId | null;
  /** The right panel shows the lens's tab (its browser and findings) rather than the mode's panel. */
  lensTab: boolean;
  /** AFD-87: where the lens tab was scrolled, put back when it shows again (round 1: W14). */
  lensScroll: number;
  lensFacts: LensFacts;
  /** The active lens for the current document, facts and run (computed, never stored). */
  lensView: LensView | null;
  /** Nodes a hovered lens panel item matches; the rest dims (04 §7). */
  highlight: Ulid[] | null;
  accept: AcceptTarget | null;
  /** A node being marked tested by hand: its reason is being entered (AFD-44). */
  testedReason: Ulid | null;
  setSnapshot(s: Snapshot): void;
  setTestMode(on: boolean): void;
  setFirstFlow(state: { hidden: boolean; done: string[] }): void;
  select(s: Selection): void;
  setAnnotationsHidden(hidden: boolean): void;
  editAnnotation(id: Ulid | null): void;
  openQuickAdd(q: QuickAddState | null): void;
  openPortMenu(m: PortMenuState | null): void;
  openContextMenu(m: ContextMenuState | null): void;
  requestFocus(field: FocusRequest['field']): void;
  showCheatSheet(on: boolean): void;
  setPick(p: PickState | null): void;
  setPickAt(id: Ulid | null): void;
  setDecide(p: PortRef | null): void;
  dismissBanner(count: number | null): void;
  setOptimistic(p: Record<Ulid, Position>): void;
  /** An error toast (a refused change, a failed action); null does nothing. */
  setError(e: string | null): void;
  notify(level: ToastLevel, text: string): void;
  dismissToast(id: number): void;
  setRun(r: RunView | null): void;
  setRunAsked(on: boolean): void;
  setScenarios(results: ScenarioResult[], show?: string): void;
  setOutside(marks: OutsideMarks | null): void;
  /** Shows a scenario on the canvas in Run mode; null goes back to the last run. */
  showScenario(name: string | null): void;
  setLaunch(plan: LaunchPlan | null, notice?: string): void;
  /** The facts for the dialog's current targets, if it is still the dialog of that token. */
  setLaunchFacts(token: string, facts?: LaunchFacts, error?: string): void;
  /** Opens a level; selection, menus and picks belong to the level being left. */
  setLevel(level: string): void;
  /** Shows a node: opens its level and selects it. */
  reveal(node: Ulid): void;
  setPreview(p: PreviewState | null): void;
  /** Pointer entered a node with a card (with its box) or left it (null). */
  hoverNode(node: Ulid | null, box?: { left: number; right: number; top: number }): void;
  /** Pointer on the card keeps it open. */
  holdPreview(on: boolean): void;
  /** Selects a node and shows a tab of its Details. */
  openDetails(node: Ulid, tab?: PropTab, bindKind?: BindKind): void;
  setDetailsTab(tab: PropTab): void;
  setPendingBinding(node: Ulid | null): void;
  /** `go` does what was asked (the binding was saved or discarded); `stay` keeps editing. */
  resolveLeave(choice: 'go' | 'stay'): void;
  setPanelWidth(width: number): void;
  setExpanded(on: boolean): void;
  setPaletteCollapsed(on: boolean): void;
  setPanelCollapsed(on: boolean): void;
  openFind(open: boolean): void;
  setFindQuery(query: string): void;
  setCatalog(status: CatalogStatus): void;
  setMode(mode: Mode): void;
  setSync(sync: SyncState): void;
  setIgnore(target: IgnoreTarget | null): void;
  setLens(lens: LensId | null): void;
  /** Which tab the right panel shows while a lens is on (AFD-45). */
  showLensTab(on: boolean): void;
  /** Merges facts from the host (each message carries the kinds it updates). */
  setLensFacts(facts: LensFacts): void;
  setHighlight(nodes: Ulid[] | null): void;
  setAccept(target: AcceptTarget | null): void;
  setTestedReason(node: Ulid | null): void;
}

function runOf(snapshot: Snapshot | null, run: RunView | null): Record<Ulid, NodeRun> | null {
  return snapshot?.doc && run?.summary ? runStates(snapshot.doc, run.summary) : null;
}

function lensOf(
  snapshot: Snapshot | null,
  lens: LensId | null,
  facts: LensFacts,
  run: RunView | null,
): LensView | null {
  return snapshot?.doc && lens ? lensView(lens, snapshot.doc, facts, run) : null;
}

function driftOf(snapshot: Snapshot | null, scan: CodeScan | undefined): DriftReport | null {
  return snapshot?.doc && scan ? computeDrift(snapshot.doc, scan) : null;
}

export const useUi = create<UiState>((set, get) => ({
  snapshot: null,
  testMode: false,
  firstFlow: null,
  selection: {},
  quickAdd: null,
  portMenu: null,
  contextMenu: null,
  focusRequest: null,
  cheatSheet: false,
  find: false,
  findQuery: '',
  findNonce: 0,
  centerOn: null,
  pick: null,
  pickAt: null,
  decide: null,
  bannerDismissedAt: null,
  formatDismissed: false,
  optimistic: {},
  toasts: [],
  saving: false,
  run: null,
  runAsked: false,
  launch: null,
  scenarios: null,
  scenarioShown: null,
  runBeforeScenario: null,
  outside: null,
  outsideAround: [],
  runNodes: null,
  level: ROOT,
  preview: null,
  detailsTab: 'general',
  bindKind: null,
  pendingBinding: null,
  leave: null,
  panelWidth: PANEL_WIDTH.initial,
  expanded: false,
  paletteCollapsed: false,
  panelCollapsed: false,
  annotationsHidden: false,
  editingAnnotation: null,
  catalog: { state: 'idle' },
  mode: 'design',
  sync: { state: 'idle' },
  drift: null,
  ignore: null,
  lens: null,
  lensTab: false,
  lensScroll: 0,
  lensFacts: {},
  lensView: null,
  highlight: null,
  accept: null,
  testedReason: null,
  setSnapshot(snapshot) {
    const current = get().snapshot;
    if (current && snapshot.docVersion < current.docVersion) return;
    // Drop optimistic positions the document now confirms (or any, once the version moved on).
    const layout = snapshot.doc?.layout ?? {};
    const optimistic = Object.fromEntries(
      Object.entries(get().optimistic).filter(([id, p]) => {
        const stored = layout[id];
        return !(stored && stored.x === Math.round(p.x) && stored.y === Math.round(p.y));
      }),
    );
    const model = snapshot.doc ? modelOf(snapshot.doc) : undefined;
    // Annotations confirmed where they were moved (AFD-65) drop their optimistic place too.
    for (const [id, p] of Object.entries(optimistic)) {
      const a = model?.annotations.get(id)?.annotation;
      if (a && a.x === Math.round(p.x) && a.y === Math.round(p.y)) delete optimistic[id];
    }
    const ids = new Set(model ? model.nodes.keys() : []);
    const notes = new Set(model ? model.annotations.keys() : []);
    // The open subflow may be gone (deleted, or the text was edited): fall back to the top level.
    // A subflow without inner steps has no level in the model yet, but it can be open.
    const open = get().level;
    const level =
      model?.levels.has(open) || model?.nodes.get(open)?.node.type === 'subflow' ? open : ROOT;
    const sel = get().selection;
    const selection =
      (sel.node && !ids.has(sel.node)) ||
      sel.nodes?.some((id) => !ids.has(id)) ||
      sel.annotations?.some((id) => !notes.has(id))
        ? {}
        : sel;
    const gone = (ref: PortRef | undefined) => ref !== undefined && !ids.has(ref.node);
    const target = get().contextMenu?.target;
    const lost =
      (target?.kind === 'node' && !ids.has(target.id)) ||
      (target?.kind === 'nodes' && target.ids.some((id) => !ids.has(id))) ||
      (target?.kind === 'edge' && !model?.edges.has(target.id));
    set({
      snapshot,
      optimistic,
      selection: level === get().level ? selection : {},
      level,
      ...(gone(get().portMenu?.ref) ? { portMenu: null } : {}),
      ...(lost ? { contextMenu: null } : {}),
      ...(gone(get().pick?.ref) ? { pick: null } : {}),
      ...(get().preview && !ids.has(get().preview?.node ?? '') ? { preview: null } : {}),
      drift: driftOf(snapshot, get().sync.scan),
      runNodes: runOf(snapshot, get().run),
      lensView: lensOf(snapshot, get().lens, get().lensFacts, get().run),
    });
  },
  setTestMode: (testMode) => set({ testMode }),
  setFirstFlow: (firstFlow) => set({ firstFlow }),
  select(selection) {
    const pending = get().pendingBinding;
    if (pending && selection.node !== pending)
      return void set({ leave: { kind: 'select', selection } });
    // Selecting shows what was selected: the mode's panel, not the lens's tab.
    const chosen = !!(
      selection.node ||
      selection.nodes?.length ||
      selection.edge ||
      selection.annotations?.length
    );
    const editing = get().editingAnnotation;
    set({
      selection,
      ...(chosen ? { lensTab: false } : {}),
      ...(editing && !selection.annotations?.includes(editing) ? { editingAnnotation: null } : {}),
    });
  },
  setAnnotationsHidden: (annotationsHidden) => set({ annotationsHidden }),
  editAnnotation: (editingAnnotation) => set({ editingAnnotation }),
  openQuickAdd: (quickAdd) => set({ quickAdd }),
  openPortMenu: (portMenu) => set({ portMenu, ...closing('portMenu') }),
  openContextMenu: (contextMenu) => {
    clearTimeout(openTimer);
    set({ contextMenu, ...closing('contextMenu') });
  },
  requestFocus: (field) => set({ focusRequest: { field, nonce: Date.now() } }),
  showCheatSheet: (cheatSheet) => set({ cheatSheet, ...closing('cheatSheet') }),
  setPick: (pick) => set({ pick, pickAt: null, ...closing('pick') }),
  setPickAt: (pickAt) => set({ pickAt }),
  setDecide: (decide) => set({ decide, ...closing('decide') }),
  dismissBanner: (bannerDismissedAt) => set({ bannerDismissedAt }),
  setOptimistic: (p) => set({ optimistic: { ...get().optimistic, ...p } }),
  setError(error) {
    if (error) get().notify('error', error);
  },
  notify(level, text) {
    const id = ++toastId;
    // The same message again replaces the one shown; at most four stay.
    const others = get().toasts.filter((t) => t.text !== text);
    set({ toasts: [...others, { id, level, text }].slice(-4) });
    setTimeout(() => get().dismissToast(id), TOAST_MS[level]);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setRun(run) {
    const asked = get().runAsked && !!run;
    // A run from the host replaces a scenario on the canvas.
    if (get().scenarioShown) set({ scenarioShown: null, runBeforeScenario: null });
    set({
      run,
      runNodes: runOf(get().snapshot, run),
      lensView: lensOf(get().snapshot, get().lens, get().lensFacts, run),
      ...(asked ? { runAsked: false } : {}),
    });
    // A run the designer started shows where it is on the canvas (AFD-81, round 1: P5).
    if (asked && run?.state === 'running') get().setMode('run');
  },
  setRunAsked: (runAsked) => set({ runAsked }),
  setOutside(outside) {
    const doc = get().snapshot?.doc;
    set({ outside, outsideAround: outside && doc ? markedAround(outside, doc) : [] });
  },
  setScenarios(scenarios, show) {
    set({ scenarios });
    if (show) get().showScenario(show);
  },
  showScenario(name) {
    const { scenarios, scenarioShown, snapshot, lens, lensFacts } = get();
    const result = name ? scenarios?.find((r) => r.name === name) : undefined;
    const run = result
      ? scenarioRun(result, new Date().toISOString())
      : scenarioShown
        ? get().runBeforeScenario
        : get().run;
    set({
      ...(result && !scenarioShown ? { runBeforeScenario: get().run } : {}),
      ...(result ? {} : { runBeforeScenario: null }),
      scenarioShown: result ? result.name : null,
      run,
      runNodes: runOf(snapshot, run),
      lensView: lensOf(snapshot, lens, lensFacts, run),
    });
    if (result) get().setMode('run');
  },
  setLaunch: (launch, launchNotice) => set({ launch, launchNotice }),
  setLaunchFacts(token, facts, error) {
    const plan = get().launch;
    if (plan?.token !== token) return;
    set({ launch: { ...plan, facts, factsError: facts ? undefined : error } });
  },
  setLens(lens) {
    set({
      lens,
      // A lens opens on its tab; the mode's panel stays one click away (AFD-45). With a binding
      // not saved, the Details stay and the lens shows on the canvas (AFD-80).
      lensTab: lens !== null && !get().pendingBinding,
      highlight: null,
      lensView: lensOf(get().snapshot, lens, get().lensFacts, get().run),
    });
  },
  showLensTab(lensTab) {
    if (lensTab && get().pendingBinding) return void set({ leave: { kind: 'lensTab' } });
    set({ lensTab });
  },
  setLensFacts(facts) {
    const lensFacts = { ...get().lensFacts, ...facts };
    set({ lensFacts, lensView: lensOf(get().snapshot, get().lens, lensFacts, get().run) });
  },
  setHighlight: (highlight) => set({ highlight }),
  setAccept: (accept) => set({ accept }),
  setTestedReason: (testedReason) => set({ testedReason, ...closing('testedReason') }),
  setLevel(level) {
    if (level === get().level) return;
    if (get().pendingBinding) return void set({ leave: { kind: 'level', level } });
    clearTimeout(openTimer);
    set({ level, selection: {}, ...closing('level') });
  },
  setPreview(preview) {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    onCard = false;
    set({ preview });
  },
  hoverNode(node, box) {
    clearTimeout(openTimer);
    if (!node || !box) {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!onCard) set({ preview: null });
      }, 200);
      return;
    }
    clearTimeout(closeTimer);
    if (get().preview?.node === node) return;
    openTimer = setTimeout(() => {
      const s = get();
      // Menus, picks and dialogs own the pointer; no card on top of them.
      if (HOLDS_POINTER.some((o) => isOpen(s, o))) return;
      set({ preview: { node, x: box.right + 12, y: box.top, left: box.left } });
    }, PREVIEW_DELAY);
  },
  holdPreview(on) {
    onCard = on;
    if (on) clearTimeout(closeTimer);
    else get().hoverNode(null);
  },
  openDetails(node, tab = 'general', bindKind) {
    clearTimeout(openTimer);
    const pending = get().pendingBinding;
    if (pending && pending !== node)
      return void set({ leave: { kind: 'details', node, tab, bindKind } });
    set({
      selection: { node },
      detailsTab: tab,
      bindKind: bindKind ? { node, kind: bindKind } : null,
      ...closing('details'),
    });
  },
  setDetailsTab: (detailsTab) => set({ detailsTab }),
  setPendingBinding: (pendingBinding) => set({ pendingBinding }),
  resolveLeave(choice) {
    const leave = get().leave;
    set({ leave: null });
    if (!leave || choice === 'stay') return;
    set({ pendingBinding: null });
    if (leave.kind === 'select') get().select(leave.selection);
    else if (leave.kind === 'level') get().setLevel(leave.level);
    else if (leave.kind === 'mode') get().setMode(leave.mode);
    else if (leave.kind === 'reveal') get().reveal(leave.node);
    else if (leave.kind === 'collapse') get().setPanelCollapsed(true);
    else if (leave.kind === 'lensTab') get().showLensTab(true);
    else get().openDetails(leave.node, leave.tab, leave.bindKind);
  },
  setPanelWidth: (width) =>
    set({ panelWidth: Math.round(Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, width))) }),
  setExpanded: (expanded) => set({ expanded }),
  setPaletteCollapsed: (paletteCollapsed) => set({ paletteCollapsed }),
  setPanelCollapsed(panelCollapsed) {
    if (panelCollapsed && get().pendingBinding) return void set({ leave: { kind: 'collapse' } });
    set({ panelCollapsed });
  },
  openFind: (open) =>
    set(
      open ? { find: true, findNonce: get().findNonce + 1, ...closing('find') } : { find: false },
    ),
  setFindQuery: (findQuery) => set({ findQuery }),
  setMode(mode) {
    if (mode === get().mode) return;
    if (get().pendingBinding) return void set({ leave: { kind: 'mode', mode } });
    // Code and Run modes open their own tab of the Details; Design leaves theirs.
    const tab = get().detailsTab;
    const detailsTab =
      mode === 'code'
        ? 'code'
        : mode === 'run'
          ? 'run'
          : tab === 'code' || tab === 'run'
            ? 'general'
            : tab;
    set({ mode, detailsTab, ...closing('mode') });
  },
  setSync(sync) {
    set({ sync, drift: driftOf(get().snapshot, sync.scan) });
  },
  setIgnore: (ignore) => set({ ignore }),
  setCatalog: (catalog) => set({ catalog }),
  reveal(node) {
    const pending = get().pendingBinding;
    if (pending && pending !== node) return void set({ leave: { kind: 'reveal', node } });
    const doc = get().snapshot?.doc;
    const model = doc ? modelOf(doc) : undefined;
    // AFD-65: a Note, Section or Text found shows on its level, selected.
    const note = model?.annotations.get(node);
    if (note) {
      get().setLevel(note.level);
      set({ selection: { annotations: [node] }, centerOn: node, annotationsHidden: false });
      return;
    }
    const entry = model?.nodes.get(node);
    if (!entry) return;
    get().setLevel(entry.level);
    set({ selection: { node }, centerOn: node });
  },
}));
