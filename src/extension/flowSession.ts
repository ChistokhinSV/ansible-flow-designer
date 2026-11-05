// One session per open flow document: parse/validate cache, diagnostics, attached editor panels,
// and the command path webview → planned TextEdits → WorkspaceEdit (ADR-0001).
import * as vscode from 'vscode';
import type { CodeScan, DriftAction } from '../core/drift/types';
import { engineFor } from '../core/engine/engines';
import { codePreview } from '../core/engine/preview';
import { CommandError, type FlowCommand, planCommand } from '../core/flow/commands';
import { completeIds } from '../core/flow/completeIds';
import { elementRangeOf, flowFromFile, type ParsedFlow, parseFlow } from '../core/flow/document';
import { type IdFactory, slugify } from '../core/flow/ids';
import { buildModel, modelOf, ROOT } from '../core/flow/model';
import { openFailPorts } from '../core/flow/openPorts';
import type { SchemaValidator } from '../core/flow/schema';
import { newFlowText } from '../core/flow/template';
import type { FlowDocument, Position, Ulid } from '../core/flow/types';
import { validateFlow } from '../core/flow/validate';
import type { LensFacts, LensId } from '../core/lens/types';
import type {
  CatalogRequest,
  CatalogStatus,
  DomSummary,
  HostMessage,
  Notice,
  RunView,
  Snapshot,
  WebviewMessage,
} from '../core/protocol';
import { hostOutput, type OutputEntry } from '../core/run/events';
import type { ScenarioResult } from '../core/scenario/scenarios';
import type { RepoState } from '../core/view/flowFacts';
import { isWebLink, linksOf } from '../core/view/markdown';
import {
  addMarks,
  closedMarks,
  keepMarks,
  type OutsideMarks,
  outsideChanges,
} from '../core/view/outsideChanges';
import { diffEdits } from '../core/yaml/edits';
import { parseYaml, type YamlFile } from '../core/yaml/parse';
import { YamlEditError } from '../core/yaml/transaction';
import { autoPositions, type LayoutDirection, layoutLevel, shownLayout } from '../node/autoLayout';
import { checkBindings } from '../node/catalog/bindingCheck';
import { sharedFindings } from '../node/sharedRefs';
import { TIMEOUTS } from '../node/timeouts';
import type { CatalogService } from './catalog/catalogService';
import { generatedDir } from './codegen';
import { CMD } from './commands/ids';
import { parseErrorDiagnostic, toDiagnostics } from './diagnostics';
import type { ProbeManager } from './env/environment';
import { showEnvironmentError } from './env/setupEnvironment';
import { authorName } from './gitHead';
import { webviewHtml } from './html';
import { checkLaunch, dropLaunch, planLaunch } from './run/launch';
import type { RunDeps } from './run/runner';
import { showRunTerminal } from './run/terminal';
import { LensController } from './session/lensController';
import { RequestTracker } from './session/requests';
import { SyncController } from './session/syncController';
import type { ShownFlows } from './shownFlows';
import type { SyncDeps } from './sync/codeSync';
import { openCode } from './sync/driftActions';
import {
  CODE_SEEN,
  firstFlowState,
  markTour,
  markTourKey,
  onFirstFlow,
  setFirstFlowHidden,
} from './tour';

/** Commands the designer runs say their outcome over its canvas, not in a notification (AFD-46). */
const QUIET = { quiet: true };

/** Decision 15: say which tested nodes are implemented again, since their design changed. */
export function announceImplementedAgain(
  doc: FlowDocument | undefined,
  ids: readonly Ulid[],
): void {
  if (ids.length === 0) return;
  const model = doc ? buildModel(doc) : undefined;
  const names = ids.map((id) => `"${model?.nodes.get(id)?.node.title ?? id}"`);
  void vscode.window.showInformationMessage(
    ids.length === 1
      ? `${names[0]} is implemented again: its design changed after it was tested.`
      : `${names.join(', ')} are implemented again: their design changed after they were tested.`,
  );
}

export interface SessionDeps {
  extensionUri: vscode.Uri;
  diagnostics: vscode.DiagnosticCollection;
  schema: SchemaValidator;
  newId: IdFactory;
  testMode: boolean;
  /** Module catalog for binding (M5); absent in tests that do not need it. */
  catalog?: CatalogService;
  /** Code sync for Implementation mode (M6). */
  sync?: SyncDeps;
  /** Lens facts (M8): the probe for the inventory, remembered targets, the run history store. */
  lens?: { probes: ProbeManager; state: vscode.Memento; storage: vscode.Uri };
  /** AFD-82: what a run of this flow needs, for the launch dialog's plan and facts. */
  run?: (uri: vscode.Uri) => RunDeps;
  /** AFD-92: what the designer last showed of each flow, for edits made while it was closed. */
  shown?: ShownFlows;
  /** AFD-93: the workspace's flows at a glance, for the flow panel. */
  repo?: () => Promise<RepoState>;
}

export interface PerfEvent {
  event: string;
  ms: number;
  docVersion: number;
}

export interface CommandOutcome {
  ok: boolean;
  error?: string;
  created?: Ulid;
  pasted?: Ulid[];
}

export class FlowSession implements vscode.Disposable {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private built?: { version: number; parsed: ParsedFlow; snapshot: Snapshot };
  private building?: { version: number; promise: Promise<Snapshot> };
  private lastGood?: Snapshot;
  /** Parse produced by our own last command; reused when the document text matches it. */
  private pendingParse?: YamlFile;
  private layoutCache = new Map<string, Record<Ulid, Position>>();
  /** Typing in the text editor settles before the next snapshot (AFD-38). */
  private changeTimer?: NodeJS.Timeout;
  /**
   * AFD-85: edits made outside the designer since it opened. `ownText` is the text Complete IDs or
   * Create Flow writes (the commands set `pendingParse`); `outsideEdit` waits for the rebuild that
   * compares the flow as shown (`shownDoc`) with the flow now.
   */
  private ownText?: string;
  private outsideEdit = false;
  private shownDoc?: FlowDocument;
  private marks?: OutsideMarks;
  private readonly inspects = new RequestTracker<DomSummary>();
  private readonly pngs = new RequestTracker<{ data?: string; error?: string }>();
  /** AFD-25: panels that have loaded, and callers waiting for one (PNG export). */
  private readonly readyPanels = new Set<vscode.WebviewPanel>();
  private readyWaiters: (() => void)[] = [];
  private readonly renderWaiters: { version: number; resolve: () => void }[] = [];
  /**
   * Test mode (AFD-97): the latest version each open panel has drawn. The session outlives its
   * panels, so a render of a closed one must not count: a test that reopened the designer on the
   * same version read a panel that had not drawn yet (no wires, or no answer to inspect).
   */
  private readonly drawn = new Map<vscode.WebviewPanel, number>();
  readonly perf: PerfEvent[] = [];
  readonly cspViolations: string[] = [];
  /** Last skeleton or real run of this flow (shown in the top bar and inspector). */
  lastRun: RunView | null = null;
  /** Lens facts (M8) and code sync (M6), each in its own controller (AFD-38). */
  private readonly lens: LensController;
  private readonly code: SyncController;

  constructor(
    readonly document: vscode.TextDocument,
    private readonly deps: SessionDeps,
  ) {
    const broadcast = (m: HostMessage) => this.broadcast(m);
    const snapshot = () => this.snapshot();
    this.lens = new LensController(document.uri, deps, broadcast, snapshot);
    this.code = new SyncController(document.uri, deps, broadcast, snapshot, (c, extra) =>
      this.runCommand(c, extra),
    );
  }

  /** Lens facts gathered for this flow, as the panels have them. */
  get lensFacts(): LensFacts {
    return this.lens.facts;
  }

  /** The last code sync (M6). */
  get lastScan(): CodeScan | undefined {
    return this.code.lastScan;
  }

  get uri(): vscode.Uri {
    return this.document.uri;
  }

  get hasPanels(): boolean {
    return this.panels.size > 0;
  }

  /** Snapshot for the current document version (cached; ELK runs only when positions are missing). */
  snapshot(): Promise<Snapshot> {
    const version = this.document.version;
    if (this.built?.version === version) return Promise.resolve(this.built.snapshot);
    if (this.building?.version === version) return this.building.promise;
    const promise = this.build(version);
    this.building = { version, promise };
    return promise;
  }

  private async build(version: number): Promise<Snapshot> {
    const text = this.document.getText();
    const file = this.pendingParse?.text === text ? this.pendingParse : parseYaml(text);
    this.pendingParse = undefined;
    const parsed = flowFromFile(file);
    let snapshot: Snapshot;
    if (!parsed.doc) {
      const err = parsed.errors[0];
      const empty = isEmptyFile(file);
      snapshot = {
        docVersion: version,
        doc: this.lastGood?.doc ?? null,
        stale: true,
        parseError: err?.message ?? 'The document does not parse',
        ...(empty ? { empty } : {}),
        file: this.uri.path.split('/').pop(),
        findings: this.lastGood?.findings ?? [],
        openPorts: this.lastGood?.openPorts ?? [],
        autoPositions: this.lastGood?.autoPositions ?? {},
      };
      // An empty file is a flow not started yet, not a problem.
      if (this.current(version))
        this.deps.diagnostics.set(
          this.uri,
          err && !empty ? [parseErrorDiagnostic(this.document, err.message, err.offset)] : [],
        );
    } else {
      const validated = validateFlow(parsed.doc, this.deps.schema(parsed.doc));
      const { model } = validated;
      // Written by hand (AFD-19): the canvas shows the flow with the missing IDs filled.
      const gaps = validated.findings.filter(
        (f) => f.code === 'missing-id' || f.code === 'unknown-key',
      ).length;
      // A level placed only where the old New Flow template put Start and Done is shown
      // auto-laid out (AFD-23).
      const layout = shownLayout(model);
      const shown = layout === model.doc.layout ? model.doc : { ...model.doc, layout };

      const preview = validated.findings.some((f) => f.severity === 'error')
        ? undefined
        : codePreview(parsed.doc, this.uri.path.split('/').pop() ?? 'flow.yaml');
      const folder = this.catalogFolder;
      const catalog = folder && this.deps.catalog?.cached(folder);
      const findings = [
        ...validated.findings,
        ...(preview?.findings ?? []),
        ...(catalog ? checkBindings(parsed.doc, catalog.index, catalog.environment) : []),
        // Shared subflows against their sources (AFD-60).
        ...sharedFindings(this.uri.fsPath, parsed.doc),
      ];
      // Problems first, while this text is still the document's: the layout below takes a while,
      // and a later build may finish before it (AFD-38).
      if (this.current(version))
        this.deps.diagnostics.set(this.uri, toDiagnostics(this.document, file, findings));
      snapshot = {
        docVersion: version,
        doc: shown,
        stale: false,
        findings,
        openPorts: openFailPorts(model),
        autoPositions: await this.allAutoPositions(model, shown.layout),
        plays: preview?.plays,
        ...(gaps > 0 ? { idGaps: gaps } : {}),
      };
      if (!this.lastGood || this.lastGood.docVersion <= version) this.lastGood = snapshot;
    }
    if (!this.built || this.built.version <= version) this.built = { version, parsed, snapshot };
    return snapshot;
  }

  /** Whether a build is for the document as it is now (an older one must not write problems). */
  private current(version: number): boolean {
    return version === this.document.version;
  }

  /** In-memory positions for unplaced nodes of every level (inner levels too, M4). */
  private async allAutoPositions(
    model: ReturnType<typeof buildModel>,
    layout: Parameters<typeof autoPositions>[1],
  ): Promise<Record<Ulid, Position>> {
    const out: Record<Ulid, Position> = {};
    for (const level of model.levels.values())
      Object.assign(out, await this.cachedAutoPositions(level, layout));
    return out;
  }

  private async cachedAutoPositions(
    level: Parameters<typeof autoPositions>[0],
    layout: Parameters<typeof autoPositions>[1],
  ): Promise<Record<Ulid, Position>> {
    const direction = layoutDirection();
    const key = JSON.stringify([
      direction,
      level.nodes.map((n) => [n?.id, n?.type, layout?.[n?.id ?? ''] ?? null]),
      level.edges.map((e) => [e?.from?.node, e?.to?.node]),
    ]);
    const hit = this.layoutCache.get(key);
    if (hit) return hit;
    const positions = await autoPositions(level, layout, direction);
    if (this.layoutCache.size > 20) this.layoutCache.clear();
    this.layoutCache.set(key, positions);
    return positions;
  }

  /** Whether the flow has shared subflows, whose sources live in other files (AFD-60). */
  get sharesSubflows(): boolean {
    const doc = this.built?.parsed.doc;
    return !!doc && [...modelOf(doc).nodes.values()].some((e) => !!e.node.ref);
  }

  /** Builds again for the same text: a file it depends on changed (a shared subflow's source). */
  async recheck(): Promise<void> {
    this.built = undefined;
    this.building = undefined;
    await this.refresh();
  }

  /** Rebuilds after a document change and pushes the snapshot to every panel. */
  async refresh(): Promise<void> {
    const snapshot = await this.snapshot();
    if (snapshot.docVersion !== this.document.version) return;
    this.broadcast({ type: 'snapshot', snapshot });
    if (snapshot.doc && !snapshot.stale) {
      this.lens.followed(snapshot.doc);
      this.mark(snapshot.doc);
    }
  }

  /** AFD-85: an outside edit adds its steps and wires; the person's own edits only drop gone ones. */
  private mark(doc: FlowDocument): void {
    const before = this.marks;
    if (this.outsideEdit && this.shownDoc)
      this.marks = addMarks(
        this.marks,
        outsideChanges(this.shownDoc, doc),
        doc,
        new Date().toISOString(),
      );
    else this.marks = keepMarks(this.marks, doc);
    this.outsideEdit = false;
    this.shownDoc = doc;
    if (JSON.stringify(before) !== JSON.stringify(this.marks))
      this.broadcast({ type: 'outsideMarks', marks: this.marks ?? null });
  }

  /** Test API: the outside-edit marks. */
  get outsideMarks(): OutsideMarks | undefined {
    return this.marks;
  }

  /**
   * The document changed. The designer's own edits, and undo in the designer, show at once;
   * typing in a text editor settles for a moment first, instead of parsing, validating,
   * generating and laying out at every key (AFD-38).
   */
  changed(reason?: vscode.TextDocumentChangeReason): void {
    // AFD-85: the designer's own edit (its commands, Complete IDs, Create Flow), an undo or redo, or
    // typing in this file's text editor; anything else (the disk, an agent, another extension) is
    // an outside edit, marked on the canvas.
    const text = this.document.getText();
    const own =
      this.pendingParse?.text === text ||
      this.ownText === text ||
      reason !== undefined ||
      vscode.window.activeTextEditor?.document === this.document;
    if (!own) this.outsideEdit = true;
    this.ownText = undefined;
    clearTimeout(this.changeTimer);
    const typing = vscode.window.visibleTextEditors.some((e) => e.document === this.document);
    if (!typing || this.pendingParse?.text === this.document.getText()) {
      void this.refresh();
      return;
    }
    this.changeTimer = setTimeout(() => void this.refresh(), TIMEOUTS.typingSettles);
  }

  openLens(lens: LensId | null, refresh = false): Promise<void> {
    return this.lens.show(lens, refresh);
  }

  /** Test API: targets without the input box. */
  useTargets(text: string): Promise<void> {
    return this.lens.useTargets(text);
  }

  /** Test API: the lens on every panel of this flow. */
  setLens(lens: LensId | null): void {
    this.broadcast({ type: 'setLens', lens });
    void this.openLens(lens);
  }

  attach(panel: vscode.WebviewPanel): void {
    // AFD-92: the designer opens this flow: what changed since it last showed it is marked.
    if (this.panels.size === 0) void this.markClosed();
    this.panels.add(panel);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'webview')],
    };
    panel.webview.html = webviewHtml(panel.webview, this.deps.extensionUri);
    const sub = panel.webview.onDidReceiveMessage((m: WebviewMessage) => {
      void this.onMessage(panel, m);
    });
    // AFD-73: the first-flow checklist follows the user's progress in every open designer.
    const progress = onFirstFlow((s) => this.post(panel, { type: 'firstFlow', ...s }));
    panel.onDidDispose(() => {
      sub.dispose();
      progress.dispose();
      this.panels.delete(panel);
      this.readyPanels.delete(panel);
      this.drawn.delete(panel);
      if (this.panels.size === 0) void this.rememberShown();
    });
  }

  /**
   * AFD-92: the flow as the designer shows it, kept for when it opens again (its last panel closes,
   * a save while it is open, Clear). A dirty flow is kept as saved: the person's unsaved edits are
   * not on disk, so they cannot come back as an outside change.
   */
  async rememberShown(): Promise<void> {
    const shown = this.deps.shown;
    if (!shown) return;
    let text = this.document.getText();
    if (this.document.isDirty) {
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.document.uri));
      } catch {
        return;
      }
    }
    await shown.remember(this.document.uri, text);
  }

  /** AFD-92: the changes since the designer last showed this flow, as outside marks. */
  private async markClosed(): Promise<void> {
    const shown = await this.deps.shown?.recall(this.document.uri);
    if (!shown || shown.text === this.document.getText()) return;
    const before = parseFlow(shown.text).doc;
    const snapshot = await this.snapshot();
    if (!before || !snapshot.doc || snapshot.stale) return;
    const marks = closedMarks(this.marks, before, snapshot.doc, shown.at);
    if (marks === this.marks) return;
    this.marks = marks;
    // A panel not ready yet gets them after its snapshot ('ready').
    for (const p of this.readyPanels) this.post(p, { type: 'outsideMarks', marks: marks ?? null });
  }

  /** Clear: the marks go, and the flow as it is now is what the designer last showed. */
  async clearOutside(): Promise<void> {
    this.marks = undefined;
    this.broadcast({ type: 'outsideMarks', marks: null });
    await this.rememberShown();
  }

  /** Test API: the designer's panel takes the keyboard focus (a test's Undo goes to it). */
  focusPanel(): void {
    for (const p of this.panels) p.reveal(p.viewColumn, false);
  }

  /** AFD-93: the workspace's flows changed: the flow panel's line follows. */
  repoState(state: RepoState): void {
    for (const p of this.readyPanels) this.post(p, { type: 'repoState', state });
  }

  /** AFD-92: the save's own edits (the version bump, a tested step dropping back) are not outside. */
  expectOwn(text: string): void {
    this.ownText = text;
  }

  private post(panel: vscode.WebviewPanel, message: HostMessage): void {
    void panel.webview.postMessage(message);
  }

  /** A message over the panel's canvas (AFD-46). */
  private tell(panel: vscode.WebviewPanel, notice: Notice | undefined): void {
    if (notice) this.post(panel, { type: 'notify', ...notice });
  }

  private broadcast(message: HostMessage): void {
    for (const p of this.panels) this.post(p, message);
  }

  private async onMessage(panel: vscode.WebviewPanel, m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.readyPanels.add(panel);
        for (const w of this.readyWaiters.splice(0)) w();
        this.post(panel, { type: 'config', testMode: this.deps.testMode });
        this.post(panel, { type: 'firstFlow', ...firstFlowState() });
        this.post(panel, { type: 'snapshot', snapshot: await this.snapshot() });
        this.post(panel, { type: 'run', run: this.lastRun });
        if (this.marks) this.post(panel, { type: 'outsideMarks', marks: this.marks });
        // AFD-93: not awaited, so 'ready' posts the rest at once; a panel closed by then gets nothing.
        void this.deps.repo?.().then((state) => {
          if (this.readyPanels.has(panel)) this.post(panel, { type: 'repoState', state });
        });
        if (this.scenarios) {
          const { results, show } = this.scenarios;
          this.post(panel, { type: 'scenarios', results, ...(show ? { show } : {}) });
          this.scenarios.show = undefined;
        }
        if (this.catalogFolder && this.deps.catalog)
          this.post(panel, {
            type: 'catalogStatus',
            status: this.deps.catalog.status(this.catalogFolder),
          });
        if (this.lastScan) this.post(panel, { type: 'sync', state: 'done', scan: this.lastScan });
        if (Object.keys(this.lensFacts).length > 0)
          this.post(panel, { type: 'lensFacts', facts: this.lensFacts });
        break;
      case 'lens':
        await this.openLens(m.lens, m.refresh);
        break;
      case 'setTargets':
        await this.lens.askTargets();
        break;
      case 'compareWith':
        await this.lens.compareWith(m.ref);
        break;
      case 'runScenarios':
        void vscode.commands.executeCommand(CMD.runScenarios, this.uri);
        break;
      case 'insertShared':
        void vscode.commands.executeCommand(CMD.insertShared, this.uri, {
          level: m.level,
          ...(m.at ? { position: m.at } : {}),
        });
        break;
      case 'sync':
        void this.sync();
        break;
      case 'openCode':
        await openCode(this.uri, m.path, m.line).catch((e: Error) =>
          vscode.window.showErrorMessage(`Cannot open ${m.path}: ${e.message}`),
        );
        break;
      case 'driftAction': {
        const outcome = await this.driftAction(m.action);
        this.post(panel, { type: 'ack', reqId: m.reqId, ...outcome });
        break;
      }
      case 'catalog':
        void this.catalogRequest(panel, m.reqId, m.request);
        break;
      case 'command': {
        const outcome = await this.runCommand(m.command);
        this.post(panel, { type: 'ack', reqId: m.reqId, ...outcome });
        break;
      }
      case 'openText':
        await this.openText(m.path);
        break;
      case 'showFlows':
        await vscode.commands.executeCommand('afd.flows.focus');
        break;
      case 'requestPaste': {
        const text = await vscode.env.clipboard.readText();
        this.post(panel, { type: 'clipboard', action: 'paste', text, at: m.at });
        break;
      }
      case 'openLink': {
        // Only a web link written in one of this flow's annotations (AFD-65), never a URL the
        // page makes up: the webview shows the file's own text.
        const doc = this.built?.parsed.doc;
        const known =
          doc &&
          [...modelOf(doc).annotations.values()].some((e) =>
            linksOf(e.annotation.text).includes(m.url),
          );
        if (known && isWebLink(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
      }
      case 'copyText':
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage(
          `Copied ${m.count} node${m.count === 1 ? '' : 's'}: paste them on a flow or in a text file`,
          4000,
        );
        break;
      case 'completeIds': {
        const outcome = await this.completeIds();
        if (!outcome.ok) void vscode.window.showErrorMessage(outcome.error ?? 'IDs not completed');
        break;
      }
      case 'initFlow': {
        const outcome = await this.initFlow();
        if (!outcome.ok) void vscode.window.showErrorMessage(outcome.error ?? 'No flow created');
        break;
      }
      case 'validate':
        // Through the command, so the walkthrough step that waits for it checks off (AFD-22);
        // quiet, so the outcome reads over the canvas that asked (AFD-46).
        this.tell(
          panel,
          await vscode.commands.executeCommand<Notice | undefined>(CMD.checkFlow, this.uri, QUIET),
        );
        break;
      case 'openGuide':
        await vscode.commands.executeCommand(CMD.openGuide, m.page);
        break;
      case 'startFrom':
        await vscode.commands.executeCommand(
          m.what === 'playbooks'
            ? CMD.importPlaybooks
            : m.what === 'awx'
              ? CMD.importAwx
              : m.what === 'tour'
                ? CMD.getStarted
                : CMD.openSample,
        );
        break;
      case 'firstFlow':
        setFirstFlowHidden(m.hidden);
        break;
      // AFD-82: the designer's Run opens its launch dialog.
      case 'run':
        await vscode.commands.executeCommand(CMD.runLaunch, this.uri, m.mode);
        break;
      case 'launchCheck': {
        const deps = this.deps.run?.(this.uri);
        const r = deps
          ? await checkLaunch(this.document, deps, m.token, m.inputs)
          : { error: 'Runs are not available here' };
        this.post(panel, { type: 'launchFacts', token: m.token, ...r });
        break;
      }
      case 'launchRun':
        await vscode.commands.executeCommand(
          CMD.runLaunched,
          this.uri,
          m.token,
          m.inputs,
          m.vaultPassword,
        );
        break;
      case 'launchCancel':
        dropLaunch(m.token);
        break;
      case 'clearOutside':
        await this.clearOutside();
        break;
      case 'launchAwx':
        await vscode.commands.executeCommand(CMD.awxLaunch, this.uri);
        break;
      case 'stopRun':
        await vscode.commands.executeCommand(CMD.stopRun, this.uri);
        break;
      case 'generate': {
        const notice = await vscode.commands.executeCommand<Notice | undefined>(
          CMD.generateCode,
          this.uri,
          QUIET,
        );
        if (notice && notice.level !== 'error') markTourKey(CODE_SEEN);
        this.tell(panel, notice);
        break;
      }
      case 'showRunOutput': {
        // Only URLs the host itself got from AWX: the run, or one of its approvals (AFD-11).
        const url = m.approval
          ? this.lastRun?.awx?.approvals?.[m.approval]?.url
          : this.lastRun?.awx?.url;
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
        // AFD-81: the flow's own run terminal, not whichever terminal was last.
        else if (!m.approval) await showRunTerminal(this.uri);
        break;
      }
      case 'runOutput':
        this.post(panel, {
          type: 'runOutputReply',
          reqId: m.reqId,
          ...(await this.runOutput(m.node, m.host)),
        });
        break;
      case 'peekCode':
        await this.peekCode(m.node);
        break;
      case 'tidyUp': {
        const outcome = await this.tidyUp(m.level);
        this.tell(
          panel,
          outcome.ok
            ? { level: 'success', text: 'Tidied up the level' }
            : { level: 'error', text: outcome.error ?? 'Tidy Up failed' },
        );
        break;
      }
      case 'inspectResult':
        this.inspects.answer(m.reqId, m.result);
        break;
      case 'pngRendered':
        this.pngs.answer(m.reqId, m);
        break;
      case 'export':
        if (m.format === 'drawio') await vscode.commands.executeCommand(CMD.exportDrawio, this.uri);
        else await vscode.commands.executeCommand(CMD.exportImage, this.uri, { level: m.level });
        break;
      case 'perf':
        this.perf.push({ event: m.event, ms: m.ms, docVersion: m.docVersion });
        if (m.event === 'drawn') {
          if (this.panels.has(panel))
            this.drawn.set(panel, Math.max(m.docVersion, this.drawn.get(panel) ?? 0));
          for (const w of this.renderWaiters.filter((x) => m.docVersion >= x.version)) w.resolve();
          this.renderWaiters.splice(
            0,
            this.renderWaiters.length,
            ...this.renderWaiters.filter((x) => m.docVersion < x.version),
          );
        }
        break;
      case 'cspViolation':
        this.cspViolations.push(m.detail);
        break;
    }
  }

  private get catalogFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(this.uri);
  }

  /** Answers a catalog request of the properties page (also the test API's entry). */
  async answerCatalog(request: CatalogRequest): Promise<unknown> {
    const catalog = this.deps.catalog;
    const folder = this.catalogFolder;
    if (!catalog || !folder)
      throw new Error('Open the flow inside a workspace folder to use the catalog');
    switch (request.op) {
      case 'search':
        return catalog.search(folder, request.query, request.types);
      case 'doc':
        return catalog.doc(folder, request.fqcn, request.type);
      case 'roles':
        return catalog.roles(folder);
      case 'playbooks':
        return catalog.playbooks(folder);
      case 'rebuild':
        await catalog.ready(folder, true);
        return catalog.status(folder);
    }
  }

  private async catalogRequest(
    panel: vscode.WebviewPanel,
    reqId: number,
    request: CatalogRequest,
  ): Promise<void> {
    try {
      const result = await this.answerCatalog(request);
      this.post(panel, { type: 'catalogReply', reqId, ok: true, result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.post(panel, { type: 'catalogReply', reqId, ok: false, error });
    }
  }

  /** Catalog state changes for this flow's folder (loading, ready, error). */
  catalogStatus(folder: string, status: CatalogStatus): void {
    if (this.catalogFolder?.uri.toString() !== folder) return;
    this.broadcast({ type: 'catalogStatus', status });
    if (status.state === 'ready') {
      // Binding checks depend on the catalog: rebuild the snapshot for the same version.
      this.built = undefined;
      void this.refresh();
    }
  }

  /** Re-sync from git: compile the code in the environment and push the scan to the panels. */
  sync(): Promise<void> {
    return this.code.sync();
  }

  /** After a save: the generated code changed, so a shown sync is out of date. */
  resyncIfScanned(): void {
    if (this.code.lastScan && this.hasPanels) void this.code.sync();
  }

  /** Test mode: a scan from elsewhere (no probe). */
  useScan(scan: CodeScan): void {
    this.code.useScan(scan);
  }

  driftAction(action: DriftAction): Promise<CommandOutcome> {
    return this.code.driftAction(action);
  }

  /**
   * AFD-82: the launch dialog in the active designer panel, with a fresh plan (single-use token).
   * `notice` says why it opens again (the inventory answered differently at Run).
   */
  async openLaunch(
    mode: 'check' | 'real',
    notice?: string,
    prefill?: { targets?: string },
  ): Promise<void> {
    const deps = this.deps.run?.(this.uri);
    const panel = [...this.panels].find((p) => p.active) ?? [...this.panels][0];
    if (!deps || !panel) return;
    const r = await planLaunch(this.document, deps, mode, prefill);
    if (!r.ok) {
      if (r.environment) showEnvironmentError(r.error, () => this.openLaunch(mode));
      else this.post(panel, { type: 'notify', level: 'error', text: r.error });
      return;
    }
    this.post(panel, { type: 'launch', plan: r.plan, ...(notice ? { notice } : {}) });
  }

  /**
   * AFD-81: what one host did in one node of the last local run, read from its kept events (they
   * are redacted when the run ends, so a live run has to end first).
   */
  async runOutput(node: Ulid, host: string): Promise<{ entries?: OutputEntry[]; error?: string }> {
    const run = this.lastRun;
    const flowId = this.built?.parsed.doc?.flow.id;
    const storage = this.deps.lens?.storage;
    if (run?.source !== 'local' || !flowId || !storage)
      return { error: 'Output is kept for local runs only.' };
    if (run.state === 'running') return { error: 'The output shows once the run has ended.' };
    try {
      const file = vscode.Uri.joinPath(storage, 'runs', flowId, run.id, 'events.jsonl');
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
      return { entries: hostOutput(text, node, host) };
    } catch {
      return { error: 'The events of this run are no longer kept (afd.runs.keep).' };
    }
  }

  /** AFD-84: the scenario results for the run panel; `show` puts that one on the canvas. */
  private scenarios: { results: ScenarioResult[]; show?: string } | undefined;

  showScenarios(results: ScenarioResult[], show?: string): void {
    // A designer opened for Show on Canvas gets them when it is ready.
    this.scenarios = { results, show };
    this.broadcast({ type: 'scenarios', results, ...(show ? { show } : {}) });
  }

  setRun(run: RunView): void {
    this.lastRun = run;
    this.broadcast({ type: 'run', run });
    this.lens.ran(run, this.built?.parsed.doc?.flow.id);
  }

  /** Plans a command against the current text and applies it as one WorkspaceEdit (one undo step). */
  async runCommand(
    input: FlowCommand,
    /** Adds file operations to the same WorkspaceEdit (M6 stubs): one undo step with the design. */
    extra?: (edit: vscode.WorkspaceEdit) => void,
  ): Promise<CommandOutcome> {
    // The webview never names the author of a decision; the host does (decision 13).
    const named =
      (input.kind === 'setDecision' ||
        input.kind === 'ignoreDrift' ||
        input.kind === 'acceptFinding' ||
        input.kind === 'acceptCheck' ||
        input.kind === 'markTested') &&
      !input.by
        ? { ...input, by: await authorName(this.uri) }
        : input;
    // Tested by hand keeps the day it was said (format 2, AFD-50).
    const command =
      named.kind === 'markTested' && !named.at
        ? { ...named, at: new Date().toISOString().slice(0, 10) }
        : named;
    const snapshot = await this.snapshot();
    if (snapshot.stale)
      return {
        ok: false,
        error: 'The document has YAML errors; fix them in the text editor first',
      };
    if (snapshot.idGaps)
      return {
        ok: false,
        error: 'This flow was written by hand: Complete IDs first (the banner, or the quick fix)',
      };
    const text = this.document.getText();
    const cached =
      this.built?.version === this.document.version ? this.built.parsed.file : undefined;
    let result: ReturnType<typeof planCommand>;
    try {
      result = planCommand(text, command, { newId: this.deps.newId }, cached);
    } catch (e) {
      if (e instanceof CommandError || e instanceof YamlEditError)
        return { ok: false, error: e.message };
      throw e;
    }
    const made = { created: result.created, pasted: result.pasted };
    if (result.edits.length === 0 && !extra) return { ok: true, ...made };
    const edit = new vscode.WorkspaceEdit();
    extra?.(edit);
    for (const e of result.edits) {
      edit.replace(
        this.uri,
        new vscode.Range(this.document.positionAt(e.start), this.document.positionAt(e.end)),
        e.newText,
      );
    }
    this.pendingParse = result.file;
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) return { ok: false, error: 'VS Code rejected the edit' };
    markTour(command);
    if (result.dropped) announceImplementedAgain(flowFromFile(result.file).doc, result.dropped);
    return { ok: true, ...made };
  }

  /** ELK layout of one whole level (default: the top), written to the layout block (one undo step). */
  async tidyUp(levelId: string = ROOT): Promise<CommandOutcome> {
    const snapshot = await this.snapshot();
    if (!snapshot.doc) return { ok: false, error: 'The document does not parse' };
    const level = buildModel(snapshot.doc).levels.get(levelId);
    if (!level) return { ok: false, error: 'No such level' };
    return this.runCommand({
      kind: 'tidyUp',
      positions: await layoutLevel(level, layoutDirection()),
    });
  }

  /** D-22 "Peek code": the node's play in its generated file; a subflow opens its level file. */
  async peekCode(node: Ulid): Promise<void> {
    const snapshot = await this.snapshot();
    if (!snapshot.doc) return;
    const result = engineFor(snapshot.doc).generate(snapshot.doc, {
      source: this.uri.path.split('/').pop() ?? 'flow.yaml',
    });
    if (!result.ok) {
      void vscode.window.showWarningMessage('No code is generated while the flow has errors');
      return;
    }
    const level = result.files.find((f) => f.level === node);
    const play = result.plays[node];
    const name = level?.name ?? play?.file;
    if (!name) {
      void vscode.window.showInformationMessage('Nothing leads to this node, so it has no play');
      return;
    }
    const uri = vscode.Uri.joinPath(generatedDir(this.uri), name);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      // AFD-71: a new flow has no code on disk until it is saved; offer to write it now.
      const pick = await vscode.window.showInformationMessage(
        "This flow's code is not written yet: saving writes it.",
        'Generate Code',
      );
      if (!pick) return;
      await vscode.commands.executeCommand(CMD.generateCode, this.uri, QUIET);
      const written = await vscode.workspace.fs.stat(uri).then(
        () => true,
        () => false,
      );
      if (written) await this.peekCode(node);
      return;
    }
    const editor = await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
    });
    markTourKey(CODE_SEEN);
    if (level || !play) return;
    const range = new vscode.Range(play.start, 0, play.end, 0);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
  }

  async openText(path?: readonly (string | number)[]): Promise<void> {
    const editor = await vscode.window.showTextDocument(this.document, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });
    if (!path || !this.built) return;
    // The whole element (a node with everything in it), not only its first line.
    const [s, e] = elementRangeOf(this.built.parsed.file, path);
    const range = new vscode.Range(this.document.positionAt(s), this.document.positionAt(e));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Resolves once a designer panel of this flow has loaded (AFD-25: PNG export opens one). */
  whenReady(timeoutMs: number = TIMEOUTS.designerReady): Promise<void> {
    if (this.readyPanels.size > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the designer did not open')), timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * AFD-25: a designer panel draws the SVG on a canvas and returns the PNG bytes. Only a browser
   * lays out the text, so PNG export needs the designer open.
   */
  async renderPng(svg: string, width: number, height: number): Promise<Uint8Array> {
    const panel = [...this.readyPanels].find((p) => p.active) ?? [...this.readyPanels][0];
    if (!panel) throw new Error('the designer is not open');
    const r = await this.pngs.request(
      (reqId) => this.post(panel, { type: 'renderPng', reqId, svg, width, height }),
      TIMEOUTS.designerPng,
      'drawing the PNG',
    );
    if (!r.data) throw new Error(r.error ?? 'drawing the PNG failed');
    return Buffer.from(r.data, 'base64');
  }

  /** Test mode: the first panel's DOM summary. */
  inspect(): Promise<DomSummary> {
    // AFD-97: a panel that has drawn (the newest), not one still loading.
    const panel = [...this.drawn.keys()].at(-1) ?? [...this.panels][0];
    if (!panel) return Promise.reject(new Error('no panel'));
    return this.inspects.request(
      (reqId) => this.post(panel, { type: 'inspect', reqId }),
      TIMEOUTS.designerInspect,
      'inspect',
    );
  }

  /** Opens a level (`root` or a subflow node id) in every panel of this flow. */
  setMode(mode: 'design' | 'code' | 'run'): void {
    this.broadcast({ type: 'setMode', mode });
  }

  openLevel(level: string): void {
    this.broadcast({ type: 'openLevel', level });
  }

  /** Selects a node in every panel, opening its level (tests). */
  reveal(node: Ulid): void {
    this.broadcast({ type: 'reveal', node });
  }

  /** AFD-17: the focused panel copies its selection (it knows what is selected). */
  copyNodes(): void {
    const panel = [...this.panels].find((p) => p.active) ?? [...this.panels][0];
    if (panel) this.post(panel, { type: 'clipboard', action: 'copy' });
  }

  /** AFD-17: the focused panel pastes the clipboard text on its level, where the pointer was. */
  async pasteNodes(): Promise<void> {
    const panel = [...this.panels].find((p) => p.active) ?? [...this.panels][0];
    const text = await vscode.env.clipboard.readText();
    if (panel) this.post(panel, { type: 'clipboard', action: 'paste', text });
  }

  /**
   * AFD-19 Complete IDs: real IDs for nodes and wires written without them, and keys in wires,
   * the boundary, decisions and layout replaced by IDs, in one edit (one undo step).
   */
  async completeIds(): Promise<CommandOutcome> {
    const text = this.document.getText();
    let result: ReturnType<typeof completeIds>;
    try {
      result = completeIds(text, this.deps.newId);
    } catch (e) {
      if (e instanceof YamlEditError) return { ok: false, error: e.message };
      throw e;
    }
    const left = result.unresolved.map((g) => g.message);
    if (result.text === text)
      return left.length > 0
        ? { ok: false, error: `Nothing to complete; still to fix by hand: ${left.join('; ')}` }
        : { ok: true };
    const edit = new vscode.WorkspaceEdit();
    this.ownText = result.text;
    for (const e of diffEdits(text, result.text))
      edit.replace(
        this.uri,
        new vscode.Range(this.document.positionAt(e.start), this.document.positionAt(e.end)),
        e.newText,
      );
    if (!(await vscode.workspace.applyEdit(edit)))
      return { ok: false, error: 'VS Code rejected the edit' };
    if (left.length > 0)
      void vscode.window.showWarningMessage(
        `IDs completed; still to fix by hand: ${left.join('; ')}`,
      );
    return { ok: true };
  }

  /**
   * AFD-16: an empty file (whitespace or comments only) gets the New Flow template, named after
   * the file, in one edit. Comments already there stay on top; a file with content is refused.
   */
  async initFlow(): Promise<CommandOutcome> {
    const text = this.document.getText();
    if (!isEmptyFile(parseYaml(text)))
      return { ok: false, error: 'The file has content: open it in the text editor to change it' };
    const base = (this.uri.path.split('/').pop() ?? 'flow').replace(/\.flow\.ya?ml$/i, '');
    const key = slugify(base, 'flow');
    const words = base.replace(/[-_.]+/g, ' ').trim() || 'Flow';
    const name = words.charAt(0).toUpperCase() + words.slice(1);
    let body =
      (text.trim() ? `${text.replace(/\s+$/, '')}\n` : '') +
      newFlowText(name, key, this.deps.newId);
    if (this.document.eol === vscode.EndOfLine.CRLF) body = body.replace(/\r?\n/g, '\r\n');
    const edit = new vscode.WorkspaceEdit();
    this.ownText = body;
    edit.replace(
      this.uri,
      new vscode.Range(this.document.positionAt(0), this.document.positionAt(text.length)),
      body,
    );
    return (await vscode.workspace.applyEdit(edit))
      ? { ok: true }
      : { ok: false, error: 'VS Code did not apply the edit' };
  }

  /** Test mode: resolves once an open panel has rendered `version` or later. */
  rendered(version: number): Promise<void> {
    if ([...this.drawn.values()].some((v) => v >= version)) return Promise.resolve();
    return new Promise((resolve) => this.renderWaiters.push({ version, resolve }));
  }

  dispose(): void {
    clearTimeout(this.changeTimer);
    this.deps.diagnostics.delete(this.uri);
    for (const p of this.panels) p.dispose();
    this.panels.clear();
  }
}

/** No YAML content yet: whitespace or comments only. */
function isEmptyFile(file: YamlFile): boolean {
  return file.errors.length === 0 && (file.doc.toJS() ?? null) === null;
}

/** The user's layout direction for unplaced nodes and Tidy Up; never written to the flow (AFD-42). */
function layoutDirection(): LayoutDirection {
  return vscode.workspace.getConfiguration('afd.canvas').get<LayoutDirection>('direction') === 'LR'
    ? 'LR'
    : 'TB';
}
