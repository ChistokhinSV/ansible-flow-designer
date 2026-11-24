// One session per open flow document: parse/validate cache, diagnostics, attached editor panels,
// and the command path webview → planned TextEdits → WorkspaceEdit (ADR-0001).

import * as vscode from 'vscode';
import { scanPaths } from '../core/drift/drift';
import type { CodeScan, DriftAction } from '../core/drift/types';
import { engineFor } from '../core/engine/engines';
import { codePreview } from '../core/engine/preview';
import { CommandError, type FlowCommand, planCommand } from '../core/flow/commands';
import { completeIds } from '../core/flow/completeIds';
import { elementRangeOf, flowFromFile, type ParsedFlow, parseFlow } from '../core/flow/document';
import { type IdFactory, isFileId, isFileKey, slugify } from '../core/flow/ids';
import { libraryFindings, usesLibrary } from '../core/flow/library';
import type { MergeSide } from '../core/flow/merge';
import { buildModel, modelOf, ROOT } from '../core/flow/model';
import { openFailPorts } from '../core/flow/openPorts';
import { quietRepoReads, repoFindings } from '../core/flow/origin';
import { versionEditFor } from '../core/flow/save';
import type { SchemaValidator } from '../core/flow/schema';
import { newFlowText } from '../core/flow/template';
import type { FlowDocument, Position, Ulid } from '../core/flow/types';
import { validateFlow } from '../core/flow/validate';
import { indexInputs, type VarIndex } from '../core/inventory/varIndex';
import type { LensFacts, LensId } from '../core/lens/types';
import { messageProblem } from '../core/messageCheck';
import type {
  CatalogRequest,
  CatalogStatus,
  DomSummary,
  HostMessage,
  MergeView,
  Notice,
  RunView,
  Snapshot,
  WebviewMessage,
} from '../core/protocol';
import { hostOutput, type OutputEntry } from '../core/run/events';
import type { ScenarioRequest } from '../core/scenario/edit';
import type { ScenarioCheck } from '../core/scenario/live';
import type { ScenarioResult } from '../core/scenario/scenarios';
import type { RepoState } from '../core/view/flowFacts';
import { inventoryPath } from '../core/view/inventorySources';
import { isWebLink, linksOf } from '../core/view/markdown';
import { flowOutline, nodeAtOffset } from '../core/view/outline';
import {
  addMarks,
  closedMarks,
  keepMarks,
  type OutsideMarks,
  outsideChanges,
} from '../core/view/outsideChanges';
import type { ServerChange } from '../core/view/serverChange';
import { undoSummary } from '../core/view/undoSummary';
import { pastAllows, VIEWER_REFUSAL } from '../core/viewer';
import { applyEdits, diffEdits } from '../core/yaml/edits';
import { parseYaml, type YamlFile } from '../core/yaml/parse';
import { YamlEditError } from '../core/yaml/transaction';
import { autoPositions, type LayoutDirection, layoutLevel, shownLayout } from '../node/autoLayout';
import { checkBindings } from '../node/catalog/bindingCheck';
import { repoFileFindings } from '../node/repoFiles';
import { roleFindings } from '../node/roleRefs';
import { sharedFindings } from '../node/sharedRefs';
import { TIMEOUTS } from '../node/timeouts';
import type { CatalogService } from './catalog/catalogService';
import { generatedDir } from './codegen';
import { CMD } from './commands/ids';
import { parseErrorDiagnostic, toDiagnostics } from './diagnostics';
import type { ProbeManager } from './env/environment';
import { showEnvironmentError } from './env/setupEnvironment';
import { choose, finish, mergeView, type WaitingMerge, waitingMerge } from './flowMerge';
import { authorName } from './gitHead';
import { pastOf } from './history/pastDocs';
import { webviewHtml } from './html';
import { logChannel } from './log';
import { checkLaunch, dropLaunch, planLaunch } from './run/launch';
import { listRuns, loadRun } from './run/pastRuns';
import type { RunDeps } from './run/runner';
import { announceFollow, followScenarios, scenariosUri } from './run/scenarioFollow';
import { failureFilters, pausePoints, pointSettings } from './run/stepRun';
import { showRunTerminal } from './run/terminal';
import { runnerConfigured } from './runner/runnerRun';
import type { ServerLibrary } from './runner/serverLibrary';
import type { ServerWatch, WatchedFlow } from './runner/serverWatch';
import { LensController, type OutsideBase } from './session/lensController';
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
import type { VarIndexService } from './varIndexService';

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

/** The webview requests answered by an `ack` (AFD-152). */
const ACKED = new Set<WebviewMessage['type']>([
  'command',
  'driftAction',
  'scenarioEdit',
  'scenarioUndo',
]);

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
  /** AFD-116: changes to a flow's scenarios file from the designer, and taking them back. */
  scenarios?: {
    edit(flow: vscode.Uri, doc: FlowDocument, request: ScenarioRequest): Promise<CommandOutcome>;
    undo(flow: vscode.Uri): Promise<CommandOutcome>;
  };
  /** AFD-284: the server's branch, for a flow in a clone of an Ansible Flow Server project. */
  server?: ServerWatch;
  /** AFD-295: the server's library, for the flow's copies of its subflows. */
  library?: ServerLibrary;
  /** AFD-340: the repository's variables, for where a value comes from. */
  vars?: VarIndexService;
  /** AFD-377: what flow.version moves against (ADR-0006), so a designer edit carries its bump. */
  versionBase?: (uri: vscode.Uri) => string | undefined;
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
  /**
   * AFD-104: the flow before its outside changes, kept from when the marks began: the Changes
   * lens compares with it. A save rewrites what the shown store keeps, so it is held here.
   */
  private outsideBase?: OutsideBase;
  private marks?: OutsideMarks;
  /** AFD-283: a merge of this flow git left to the designer. */
  private merge?: WaitingMerge;
  /** AFD-284: what changed on the server's branch, as the designer shows it. */
  private serverChange: ServerChange | null = null;
  /** AFD-284: this session as the server watch sees it. */
  private readonly watched: WatchedFlow;
  /**
   * AFD-171: the designer is opening again and comparing with the flow it last showed. Editors that
   * keep the document loaded after the designer closed (Antigravity IDE) reload a change made on
   * disk meanwhile only now: that reload (`reload`, the text read from disk) belongs to the marks
   * of the closed time, not to a live outside edit.
   */
  private reopening = false;
  private reload?: string;
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
  /** AFD-340: the repository's variables as last sent, and the request they answer. */
  private vars?: { key: string; index: VarIndex | null };
  private varsAsked?: string;
  /** Lens facts (M8) and code sync (M6), each in its own controller (AFD-38). */
  private readonly lens: LensController;
  private readonly code: SyncController;

  constructor(
    readonly document: vscode.TextDocument,
    private readonly deps: SessionDeps,
  ) {
    const broadcast = (m: HostMessage) => this.broadcast(m);
    const snapshot = () => this.snapshot();
    this.lens = new LensController(document.uri, deps, broadcast, snapshot, () => this.outsideBase);
    this.code = new SyncController(document.uri, deps, broadcast, snapshot, (c, extra) =>
      this.runCommand(c, extra),
    );
    this.watched = {
      uri: this.document.uri,
      text: () => this.document.getText(),
      isDirty: () => this.document.isDirty,
      save: async () => this.document.save(),
      setServerChange: (change) => {
        this.serverChange = change;
        this.broadcast({ type: 'serverChange', change });
      },
      compareWith: async (ref) => {
        await this.lens.compareWith(ref);
        this.setLens('changes');
      },
    };
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
      // AFD-340: a name the repository sets is not unknown to the step that reads it.
      const own = this.vars?.index
        ? quietRepoReads(validated.findings, model, this.vars.index)
        : validated.findings;
      const findings = [
        ...own,
        ...(preview?.findings ?? []),
        ...(catalog ? checkBindings(parsed.doc, catalog.index, catalog.environment) : []),
        // Shared subflows against their sources (AFD-60).
        ...sharedFindings(this.uri.fsPath, parsed.doc, folder?.uri.fsPath),
        // AFD-293: roles expanded into subflows against the role's files.
        ...roleFindings(parsed.doc, folder?.uri.fsPath),
        // AFD-295: library copies against the server's library, as listed last.
        ...libraryFindings(parsed.doc, this.libraryFor(parsed.doc)),
        // AFD-291: files steps read from the repository.
        ...repoFileFindings(parsed.doc, folder?.uri.fsPath),
        // AFD-340: an input default that hides the inventory's value.
        ...(this.vars?.index ? repoFindings(model, this.vars.index) : []),
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
    // Ports shape the layout (AFD-192): the wires' ports and each node's optional ports and branches.
    const key = JSON.stringify([
      direction,
      level.nodes.map((n) => [
        n?.id,
        n?.type,
        n?.ports ?? null,
        n?.branches ?? null,
        layout?.[n?.id ?? ''] ?? null,
      ]),
      level.edges.map((e) => [e?.from?.node, e?.from?.port, e?.to?.node, e?.to?.port]),
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
  /** AFD-294: the wire style setting changed: open panels redraw their wires. */
  wireStyleChanged(): void {
    const style = wireStyleOf(this.document.uri);
    for (const p of this.readyPanels) this.post(p, { type: 'wireStyle', style });
  }

  /**
   * AFD-295: the library listing for a flow with library copies; a stale one is listed again in
   * the background, and the flow is checked again when what the library offers changed.
   */
  private libraryFor(doc: FlowDocument) {
    const library = this.deps.library;
    if (!library || !usesLibrary(doc)) return undefined;
    if (library.stale(this.uri))
      void library
        .refresh(this.uri)
        .then((changed) => (changed ? this.recheck() : undefined))
        .catch(() => undefined);
    return library.cached(this.uri);
  }

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
      void this.updateVars(snapshot.doc).catch(() => undefined);
    }
  }

  /**
   * AFD-340: the repository's variables for this flow (its inventory, and the roles, playbooks and
   * task files its steps run), sent when they change; the findings then take them in.
   */
  private async updateVars(doc: FlowDocument): Promise<void> {
    const service = this.deps.vars;
    const folder = vscode.workspace.getWorkspaceFolder(this.uri);
    if (!service || !folder || pastOf(this.document.uri)) return;
    const inventory = inventoryPath(
      vscode.workspace.getConfiguration('afd', this.uri).get<string>('run.inventory', ''),
    );
    const request = { inventory, ...indexInputs(doc.nodes) };
    const key = `${service.generation}|${JSON.stringify(request)}`;
    if (this.vars?.key === key || this.varsAsked === key) return;
    this.varsAsked = key;
    const index = await service.index(folder.uri, request).catch(() => null);
    if (this.varsAsked !== key) return;
    const same = JSON.stringify(index) === JSON.stringify(this.vars?.index ?? null);
    this.vars = { key, index };
    if (same) return;
    this.broadcast({ type: 'varIndex', index, openFiles: true });
    // The findings depend on it.
    await this.recheck();
  }

  /** AFD-340: a file the index may read changed: read it again for the flow as shown. */
  varsChanged(): void {
    const doc = this.lastGood?.doc;
    if (doc) void this.updateVars(doc).catch(() => undefined);
  }

  /** AFD-340: the host picked in the Inventory view. */
  originHost(host: string | null): void {
    this.broadcast({ type: 'originHost', host });
  }

  /** AFD-85: an outside edit adds its steps and wires; the person's own edits only drop gone ones. */
  private mark(doc: FlowDocument): void {
    const before = this.marks;
    const was = this.shownDoc;
    // AFD-171: with no designer open, a change is one made while closed, which markClosed marks
    // against the flow as last shown when the designer opens again (AFD-92). VS Code closes the
    // document soon after its designer; editors that keep it loaded (Antigravity IDE) reach here,
    // and reload such a change only as the designer opens.
    const text = this.document.getText();
    const late = this.reopening || (this.reload !== undefined && this.reload === text);
    if (this.reload === text) this.reload = undefined;
    if (this.outsideEdit && this.shownDoc && this.panels.size > 0 && !late)
      this.marks = addMarks(
        this.marks,
        outsideChanges(this.shownDoc, doc),
        doc,
        new Date().toISOString(),
      );
    else this.marks = keepMarks(this.marks, doc);
    this.outsideEdit = false;
    this.shownDoc = doc;
    if (!before && this.marks && was)
      this.outsideBase = { doc: was, at: this.marks.since, closed: false };
    if (!this.marks) this.outsideBase = undefined;
    if (JSON.stringify(before) !== JSON.stringify(this.marks)) {
      this.broadcast({ type: 'outsideMarks', marks: this.marks ?? null });
      void this.lens.outsideChanged();
    }
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
    // AFD-239: an undo or a redo says what it did: the flow before it, against the flow after.
    const verb =
      reason === vscode.TextDocumentChangeReason.Undo
        ? 'Undid'
        : reason === vscode.TextDocumentChangeReason.Redo
          ? 'Redid'
          : undefined;
    const before = verb && this.hasPanels ? this.built?.parsed.doc : undefined;
    const refresh = async () => {
      await this.refresh();
      if (verb && before) this.sayUndo(before, verb);
    };
    const typing = vscode.window.visibleTextEditors.some((e) => e.document === this.document);
    if (!typing || this.pendingParse?.text === this.document.getText()) {
      void refresh();
      return;
    }
    this.changeTimer = setTimeout(() => void refresh(), TIMEOUTS.typingSettles);
  }

  private sayUndo(before: FlowDocument, verb: 'Undid' | 'Redid'): void {
    const after = this.built?.version === this.document.version ? this.built.parsed.doc : undefined;
    if (!after) return;
    try {
      this.broadcast({
        type: 'notify',
        level: 'info',
        text: undoSummary(before, after, verb).text,
      });
    } catch (e) {
      // The message is a courtesy: a flow the diff cannot read still undoes.
      logChannel().appendLine(`undo summary: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** AFD-236, AFD-240: shows the node whose YAML holds a place in the text, on the canvas. */
  revealAt(offset: number): void {
    const parsed = this.built?.version === this.document.version ? this.built.parsed : undefined;
    if (!parsed?.doc) return;
    try {
      const node = nodeAtOffset(flowOutline(parsed.file, modelOf(parsed.doc)), offset);
      if (node) this.reveal(node);
    } catch {
      // No node there to show.
    }
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
      // AFD-165: a message of the wrong shape is refused before any handler reads it.
      const bad = messageProblem(m);
      if (bad) {
        this.messageFailed(panel, m, new Error(`Refused a designer message (${bad})`));
        return;
      }
      // AFD-152: a handler that throws still answers, or the designer waits for it forever.
      this.onMessage(panel, m).catch((e: unknown) => this.messageFailed(panel, m, e));
    });
    // AFD-73: the first-flow checklist follows the user's progress in every open designer.
    const progress = onFirstFlow((s) => this.post(panel, { type: 'firstFlow', ...s }));
    panel.onDidDispose(() => {
      sub.dispose();
      progress.dispose();
      this.panels.delete(panel);
      this.readyPanels.delete(panel);
      this.drawn.delete(panel);
      if (this.panels.size === 0) {
        this.deps.server?.forget(this.watched);
        this.serverChange = null;
        // AFD-171: the marks end with the designer, as they do in VS Code, where the document and
        // this session close with it; editors that keep the document loaded keep the session.
        this.marks = undefined;
        this.outsideBase = undefined;
        void this.rememberShown();
      }
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
    this.reopening = true;
    try {
      await this.markClosedNow();
    } finally {
      this.reopening = false;
    }
  }

  private async markClosedNow(): Promise<void> {
    const shown = await this.deps.shown?.recall(this.document.uri);
    if (!shown) return;
    // AFD-171: a document kept loaded may not have reloaded a change made on disk while closed.
    let disk: string | undefined;
    if (!this.document.isDirty && this.document.uri.scheme === 'file') {
      try {
        const text = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(this.document.uri),
        );
        if (text !== this.document.getText()) disk = text;
      } catch {
        // Unreadable now: compare with the document.
      }
    }
    if (shown.text === (disk ?? this.document.getText())) return;
    const before = parseFlow(shown.text).doc;
    const snapshot = await this.snapshot();
    const now =
      disk === undefined ? (snapshot.stale ? undefined : snapshot.doc) : parseFlow(disk).doc;
    if (!before || !now) return;
    if (disk !== undefined && disk !== this.document.getText()) this.reload = disk;
    const marks = closedMarks(this.marks, before, now, shown.at);
    if (marks === this.marks) return;
    this.marks = marks;
    this.outsideBase = { doc: before, at: shown.at, closed: true };
    void this.lens.outsideChanged();
    // A panel not ready yet gets them after its snapshot ('ready').
    for (const p of this.readyPanels) this.post(p, { type: 'outsideMarks', marks: marks ?? null });
  }

  /** Clear: the marks go, and the flow as it is now is what the designer last showed. */
  async clearOutside(): Promise<void> {
    this.marks = undefined;
    this.outsideBase = undefined;
    void this.lens.outsideChanged();
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

  /**
   * AFD-152: what a failed message handler still owes the webview. A request gets its answer with
   * the error (its "Saving…" ends), anything else an error notice; the log keeps the stack.
   */
  private messageFailed(panel: vscode.WebviewPanel, m: WebviewMessage, e: unknown): void {
    const error = e instanceof Error ? e.message : String(e);
    logChannel().error(
      `designer message ${m?.type ?? '?'} failed: ${e instanceof Error ? (e.stack ?? error) : error}`,
    );
    const reqId =
      m && typeof m === 'object' && 'reqId' in m && typeof m.reqId === 'number'
        ? m.reqId
        : undefined;
    if (reqId !== undefined && m.type === 'catalog')
      this.post(panel, { type: 'catalogReply', reqId, ok: false, error });
    else if (reqId !== undefined && m.type === 'runOutput')
      this.post(panel, { type: 'runOutputReply', reqId, error });
    else if (reqId !== undefined && ACKED.has(m.type))
      this.post(panel, { type: 'ack', reqId, ok: false, error });
    else this.post(panel, { type: 'notify', level: 'error', text: error });
  }

  private async onMessage(panel: vscode.WebviewPanel, m: WebviewMessage): Promise<void> {
    // AFD-320: a past version (History) reads only; the designer hides the rest, this refuses it.
    const past = pastOf(this.document.uri);
    if (past && !pastAllows(m.type)) throw new Error(VIEWER_REFUSAL);
    switch (m.type) {
      case 'ready':
        this.readyPanels.add(panel);
        for (const w of this.readyWaiters.splice(0)) w();
        this.post(panel, {
          type: 'config',
          testMode: this.deps.testMode,
          expandSubflows:
            vscode.workspace
              .getConfiguration('afd', this.document.uri)
              .get<boolean>('canvas.expandSubflows') !== false,
          // AFD-276: Run on Server is offered once a server is set up.
          runner: runnerConfigured(this.document.uri),
          wireStyle: wireStyleOf(this.document.uri),
          // AFD-346: VS Code runs flows step by step (a past version is not run).
          ...(past ? {} : { stepRuns: true, debugRuns: true }),
          ...(past
            ? {
                viewer: true,
                past: {
                  hash: past.hash,
                  author: past.author,
                  date: past.date,
                  subject: past.subject,
                  path: past.path,
                },
              }
            : {}),
        });
        this.post(panel, { type: 'firstFlow', ...firstFlowState() });
        this.post(panel, { type: 'snapshot', snapshot: await this.snapshot() });
        this.post(panel, { type: 'run', run: this.lastRun });
        void this.sendRuns(panel).catch(() => undefined);
        if (!past) void this.sendPausePoints(panel).catch(() => undefined);
        if (this.marks) this.post(panel, { type: 'outsideMarks', marks: this.marks });
        // AFD-283: a merge waiting for choices (not awaited: git answers when it answers).
        void this.showMerge(panel).catch(() => undefined);
        // AFD-284: the server's branch, when this clone is a server project's.
        if (this.serverChange)
          this.post(panel, { type: 'serverChange', change: this.serverChange });
        void this.deps.server?.follow(this.watched).catch(() => undefined);
        // AFD-93: not awaited, so 'ready' posts the rest at once; a panel closed by then gets nothing.
        void this.deps.repo?.().then((state) => {
          if (this.readyPanels.has(panel)) this.post(panel, { type: 'repoState', state });
        });
        if (this.scenarioCheck) this.post(panel, { type: 'scenarioCheck', ...this.scenarioCheck });
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
        if (this.vars?.index)
          this.post(panel, { type: 'varIndex', index: this.vars.index, openFiles: true });
        // AFD-320: a past version opens on what its commit changed.
        if (past) {
          this.post(panel, { type: 'setLens', lens: 'changes' });
          await this.openLens('changes');
        }
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
        void vscode.commands.executeCommand(CMD.runScenarios, this.uri, m.names);
        break;
      // AFD-116: scenarios changed from the designer, each one edit of the scenarios file.
      case 'scenarioEdit': {
        const doc = (await this.snapshot()).doc;
        const outcome =
          doc && this.deps.scenarios
            ? await this.deps.scenarios.edit(this.uri, doc, m.request)
            : { ok: false, error: 'The flow does not read: fix it first' };
        this.post(panel, { type: 'ack', reqId: m.reqId, ...outcome });
        break;
      }
      case 'scenarioUndo': {
        const outcome = this.deps.scenarios
          ? await this.deps.scenarios.undo(this.uri)
          : { ok: false, error: 'Nothing to undo' };
        this.post(panel, { type: 'ack', reqId: m.reqId, ...outcome });
        break;
      }
      case 'openScenarios': {
        const doc = (await this.snapshot()).doc;
        if (doc && isFileKey(doc.flow?.key))
          await vscode.window.showTextDocument(scenariosUri(this.uri, doc), {
            viewColumn: vscode.ViewColumn.Beside,
          });
        break;
      }
      case 'expandRole':
        void vscode.commands.executeCommand(CMD.expandRole, this.uri, m.node);
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
        await openCode(this.uri, m.path, m.line, scanPaths(this.lastScan)).catch((e: Error) =>
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
      case 'flowHistory':
        await vscode.commands.executeCommand(CMD.flowHistory, this.document.uri);
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
      case 'sendFeedback':
        await vscode.commands.executeCommand(CMD.sendFeedback);
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
        if (m.debug) await vscode.commands.executeCommand(CMD.runDebug, this.uri, { mode: m.mode });
        else if (m.step)
          await vscode.commands.executeCommand(CMD.runStepByStep, this.uri, { mode: m.mode });
        else await vscode.commands.executeCommand(CMD.runLaunch, this.uri, m.mode);
        break;
      // AFD-346: the Run panel's and the toolbar's Step, Continue, Pause and Stop.
      case 'stepRun':
        await vscode.commands.executeCommand(
          m.command === 'step'
            ? CMD.stepNext
            : m.command === 'continue'
              ? CMD.stepContinue
              : m.command === 'pause'
                ? CMD.stepPause
                : m.command === 'retry'
                  ? CMD.debugRetry
                  : CMD.stopRun,
          this.uri,
        );
        break;
      case 'togglePausePoint':
        await vscode.commands.executeCommand(CMD.togglePausePoint, this.uri, m.node);
        break;
      case 'setPausePoint':
        await vscode.commands.executeCommand(CMD.setPausePoint, this.uri, m.node, m.point);
        break;
      case 'setFailureFilters':
        await vscode.commands.executeCommand(CMD.setFailureFilters, this.uri, m.failures);
        break;
      case 'runPartial':
        await vscode.commands.executeCommand(CMD.runPartial, this.uri, {
          node: m.node,
          only: m.only,
        });
        break;
      case 'showRun':
        await this.showPastRun(m.id);
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
          m.step === true,
          m.debug === true,
        );
        break;
      case 'launchCancel':
        dropLaunch(m.token);
        break;
      case 'launchSave':
        // AFD-300: offered by Ansible Flow Server only; VS Code's plans never have canSave.
        break;
      case 'launchSwitch':
        // AFD-257: the plan was made for the old environment or inventory: a new one after.
        dropLaunch(m.token);
        await vscode.commands.executeCommand(
          m.what === 'environment' ? CMD.switchEnvironment : CMD.switchInventory,
          this.uri,
        );
        // AFD-376: as it was: a Debug dialog stays one, with its tick and the fields as typed.
        await this.openLaunch(
          m.mode,
          undefined,
          m.texts ? { texts: m.texts } : undefined,
          m.step === true,
          m.debug === true,
        );
        break;
      case 'clearOutside':
        await this.clearOutside();
        break;
      case 'serverUpdate':
        await this.serverUpdate(m.show);
        break;
      case 'serverDismiss':
        this.deps.server?.dismiss(this.watched);
        break;
      case 'mergeChoose':
        await this.chooseMerge(m.id, m.side);
        break;
      case 'mergeFinish':
        await this.finishMerge();
        break;
      case 'launchAwx':
        await vscode.commands.executeCommand(CMD.awxLaunch, this.uri);
        break;
      case 'launchRunner':
        await vscode.commands.executeCommand(CMD.runnerLaunch, this.uri);
        break;
      case 'stopRun':
        await vscode.commands.executeCommand(CMD.stopRun, this.uri);
        break;
      // AFD-273: VS Code shows approvals; AWX decides them in AWX, local runs by themselves.
      // AFD-276: a run on the server: its approval is decided there, as the user.
      case 'approve': {
        const runner = this.lastRun?.source === 'runner' ? this.lastRun.runner : undefined;
        if (!runner) break;
        const error = await vscode.commands.executeCommand<string | undefined>(
          CMD.runnerDecide,
          this.uri,
          runner.runId,
          m.node,
          m.decision,
          m.comment,
        );
        this.tell(
          panel,
          error
            ? { level: 'error', text: error }
            : { level: 'info', text: `The approval is ${m.decision}; the run goes on.` },
        );
        break;
      }
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
          ? (this.lastRun?.awx?.approvals?.[m.approval]?.url ??
            this.lastRun?.approvals?.[m.approval]?.url)
          : (this.lastRun?.awx?.url ?? this.lastRun?.runner?.url);
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
      case 'setWireStyle':
        // AFD-294: the canvas toggle keeps the style as the user's setting; every designer follows.
        await vscode.workspace
          .getConfiguration('afd')
          .update('canvas.wireStyle', m.style, vscode.ConfigurationTarget.Global);
        return;
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
      case 'names':
        return catalog.names(folder, request.type);
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
    prefill?: { targets?: string; texts?: Record<string, string> },
    /** AFD-346: Step by step chosen in the dialog (Run Step by Step). */
    step = false,
    /** ADR-0040: a debug run (Debug Flow). */
    debug = false,
  ): Promise<void> {
    const deps = this.deps.run?.(this.uri);
    const panel = [...this.panels].find((p) => p.active) ?? [...this.panels][0];
    if (!deps || !panel) return;
    const r = await planLaunch(this.document, deps, mode, prefill);
    if (!r.ok) {
      if (r.environment)
        showEnvironmentError(r.error, () => this.openLaunch(mode, undefined, prefill, step, debug));
      else this.post(panel, { type: 'notify', level: 'error', text: r.error });
      return;
    }
    const plan = { ...r.plan, steps: { on: step, ...(debug ? { debug: true } : {}) } };
    this.post(panel, { type: 'launch', plan, ...(notice ? { notice } : {}) });
  }

  /** AFD-346: the flow's pause points (ADR-0040: with their settings and the failure filters). */
  private async pointsMessage(): Promise<HostMessage | undefined> {
    const state = this.deps.run?.(this.uri).state;
    const flowId = (await this.snapshot()).doc?.flow.id;
    if (!state || !flowId) return undefined;
    const settings = pointSettings(state, flowId);
    return {
      type: 'pausePoints',
      points: pausePoints(state, flowId),
      ...(settings.length ? { settings } : {}),
      failures: failureFilters(state, flowId),
    };
  }

  /** AFD-346: the flow's pause points, to every designer of it. */
  async showPausePoints(): Promise<void> {
    const m = await this.pointsMessage();
    if (m) this.broadcast(m);
  }

  /** AFD-346: the pause points kept for this flow (workspace state). */
  private async sendPausePoints(panel: vscode.WebviewPanel): Promise<void> {
    const m = await this.pointsMessage();
    if (m) this.post(panel, m);
  }

  /**
   * AFD-81: what one host did in one node of the last local run, read from its kept events (they
   * are redacted when the run ends, so a live run has to end first).
   */
  async runOutput(node: Ulid, host: string): Promise<{ entries?: OutputEntry[]; error?: string }> {
    const run = this.lastRun;
    // AFD-276: a run on the server keeps its output there.
    if (run?.source === 'runner' && run.runner)
      return (
        (await vscode.commands.executeCommand<{ entries?: OutputEntry[]; error?: string }>(
          CMD.runnerHostOutput,
          this.uri,
          run.runner.runId,
          node,
          host,
        )) ?? { error: 'The server did not answer' }
      );
    const flowId = this.built?.parsed.doc?.flow.id;
    const storage = this.deps.lens?.storage;
    if (run?.source !== 'local' || !isFileId(flowId) || !storage)
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

  /** AFD-115: the live check of the flow's scenarios, sent to every designer and kept for new ones. */
  private scenarioCheck: { check: ScenarioCheck; undo: number } | undefined;

  setScenarioCheck(check: ScenarioCheck, undo = 0): void {
    this.scenarioCheck = { check, undo };
    this.broadcast({ type: 'scenarioCheck', check, undo });
  }

  get scenarioState(): ScenarioCheck | undefined {
    return this.scenarioCheck?.check;
  }

  showScenarios(results: ScenarioResult[], show?: string): void {
    // A designer opened for Show on Canvas gets them when it is ready.
    this.scenarios = { results, show };
    this.broadcast({ type: 'scenarios', results, ...(show ? { show } : {}) });
  }

  setRun(run: RunView): void {
    this.lastRun = run;
    this.broadcast({ type: 'run', run });
    this.lens.ran(run, this.built?.parsed.doc?.flow.id);
    // AFD-245: a run that ended is in the list of kept runs from now on.
    if (run.state !== 'running') void this.sendRuns().catch(() => undefined);
  }

  /** AFD-245: the kept runs of this flow, to one panel or to all. */
  private async sendRuns(panel?: vscode.WebviewPanel): Promise<void> {
    const storage = this.deps.run?.(this.uri).storage;
    const flowId = (await this.snapshot()).doc?.flow.id;
    if (!storage || !flowId) return;
    const message = { type: 'runs' as const, runs: await listRuns(storage, flowId) };
    // The panel may have closed while the list was read.
    if (!panel) this.broadcast(message);
    else if (this.readyPanels.has(panel)) this.post(panel, message);
  }

  /** AFD-245: an earlier run on the canvas again; its per-host output is read from its folder. */
  private async showPastRun(id: string): Promise<void> {
    const storage = this.deps.run?.(this.uri).storage;
    const flowId = (await this.snapshot()).doc?.flow.id;
    const run = storage && flowId ? await loadRun(storage, flowId, id) : undefined;
    if (!run) {
      this.broadcast({ type: 'notify', level: 'error', text: 'That run is no longer kept' });
      void this.sendRuns().catch(() => undefined);
      return;
    }
    this.lastRun = { ...run, past: true };
    this.broadcast({ type: 'run', run: this.lastRun });
  }

  /** Plans a command against the current text and applies it as one WorkspaceEdit (one undo step). */
  /**
   * AFD-153: commands run one at a time. A second command planned before the first one's edit
   * reached the document would plan against the old text: VS Code rejects its edit, and the
   * first one's change looks like an edit from outside the designer.
   */
  runCommand(
    input: FlowCommand,
    /** Adds file operations to the same WorkspaceEdit (M6 stubs): one undo step with the design. */
    extra?: (edit: vscode.WorkspaceEdit) => void,
  ): Promise<CommandOutcome> {
    // AFD-320: a past version (History) is the file as a commit left it: nothing changes it.
    if (pastOf(this.document.uri)) return Promise.resolve({ ok: false, error: VIEWER_REFUSAL });
    // AFD-316: a command that waits long says what it waited for, in the Ansible Flow log: the
    // canvas showed "Saving…" for minutes after a step dropped on a wire, and nothing told why.
    const asked = Date.now();
    const watch = new CommandWatch(input.kind, asked);
    const next = this.commands.then(() => {
      watch.phase('started', Date.now() - asked);
      return this.runOneCommand(input, extra, watch);
    });
    this.commands = next.catch(() => undefined);
    return next.finally(() => watch.done());
  }

  private commands: Promise<unknown> = Promise.resolve();

  private async runOneCommand(
    input: FlowCommand,
    extra?: (edit: vscode.WorkspaceEdit) => void,
    watch?: CommandWatch,
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
    watch?.phase('reading the flow (snapshot)');
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
    // AFD-115: renamed or moved steps are renamed in the scenarios file too, in the same edit.
    watch?.phase('the scenarios file');
    const follow = await followScenarios(
      this.uri,
      snapshot.doc,
      flowFromFile(result.file).doc,
    ).catch(() => undefined);
    follow?.apply(edit);
    // AFD-377: the version bump goes in the same edit, so one Undo takes back both and a save
    // after it adds no step of its own (which lost Redo).
    const bumps = versionEditFor(
      text,
      flowFromFile(result.file).doc,
      this.deps.versionBase?.(this.uri),
    );
    const apart = bumps.every((v) =>
      result.edits.every((e) => v.end <= e.start || v.start >= e.end),
    );
    const bump = apart ? bumps : [];
    for (const e of [...result.edits, ...bump]) {
      edit.replace(
        this.uri,
        new vscode.Range(this.document.positionAt(e.start), this.document.positionAt(e.end)),
        e.newText,
      );
    }
    const pending = bump.length
      ? parseYaml(applyEdits(text, [...result.edits, ...bump]))
      : result.file;
    this.pendingParse = pending;
    watch?.phase('VS Code applying the edit');
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      // AFD-153: the text it describes never came; the next change is not this command's.
      if (this.pendingParse === pending) this.pendingParse = undefined;
      return { ok: false, error: 'VS Code rejected the edit' };
    }
    markTour(command);
    if (follow) announceFollow(follow);
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

  /** AFD-284: Update (pull) from the server note; with `show`, the Changes lens after. */
  async serverUpdate(show: boolean): Promise<void> {
    await this.deps.server?.update(this.watched, show);
  }

  /** AFD-283: the merge git left for this flow, read again (test API and panels). */
  async mergeState(): Promise<MergeView | undefined> {
    await this.showMerge();
    return this.merge ? mergeView(this.merge, this.document.getText()).view : undefined;
  }

  /** AFD-283: Mine or Theirs for one conflict; the file follows. */
  async chooseMerge(id: string, side: MergeSide): Promise<void> {
    if (!this.merge) return;
    choose(this.merge, id, side);
    await this.applyMerge();
  }

  /** AFD-283: Finish merge: saved, the waiting state gone, the file added to git's index. */
  async finishMerge(): Promise<boolean> {
    if (!this.merge) return false;
    const w = this.merge;
    this.merge = undefined;
    if (this.document.isDirty) await this.document.save();
    this.broadcast({ type: 'mergeConflicts', merge: null });
    try {
      await finish(w);
    } catch (e) {
      void vscode.window.showErrorMessage(`git add failed: ${(e as Error).message}`);
      return false;
    }
    void vscode.window.showInformationMessage(
      `${w.file} is merged (git add); commit to finish the merge.`,
    );
    return true;
  }

  /** AFD-283: tells a panel (or every panel) about the merge git left for this flow, if any. */
  private async showMerge(panel?: vscode.WebviewPanel): Promise<void> {
    if (this.uri.scheme !== 'file') return;
    this.merge = await waitingMerge(this.uri.fsPath);
    if (!this.merge) return;
    const { view } = mergeView(this.merge, this.document.getText());
    if (panel) this.post(panel, { type: 'mergeConflicts', merge: view });
    else this.broadcast({ type: 'mergeConflicts', merge: view });
  }

  /** AFD-283: the file says what the merge's choices say, in one edit (one undo step). */
  private async applyMerge(): Promise<void> {
    if (!this.merge) return;
    const text = this.document.getText();
    const { view, text: next } = mergeView(this.merge, text);
    this.broadcast({ type: 'mergeConflicts', merge: view });
    if (next === undefined || next === text) return;
    const edit = new vscode.WorkspaceEdit();
    this.ownText = next;
    for (const e of diffEdits(text, next))
      edit.replace(
        this.uri,
        new vscode.Range(this.document.positionAt(e.start), this.document.positionAt(e.end)),
        e.newText,
      );
    if (!(await vscode.workspace.applyEdit(edit)))
      void vscode.window.showErrorMessage('VS Code did not apply the merge choice');
  }

  /** Test mode: resolves once an open panel has rendered `version` or later. */
  rendered(version: number): Promise<void> {
    if ([...this.drawn.values()].some((v) => v >= version)) return Promise.resolve();
    return new Promise((resolve) => this.renderWaiters.push({ version, resolve }));
  }

  dispose(): void {
    this.deps.server?.forget(this.watched);
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
export function layoutDirection(): LayoutDirection {
  return vscode.workspace.getConfiguration('afd.canvas').get<LayoutDirection>('direction') === 'LR'
    ? 'LR'
    : 'TB';
}

/** AFD-294: how the canvas draws wires (`afd.canvas.wireStyle`). */
export function wireStyleOf(uri?: vscode.Uri): 'stepped' | 'curved' {
  return vscode.workspace.getConfiguration('afd', uri).get<string>('canvas.wireStyle') === 'curved'
    ? 'curved'
    : 'stepped';
}

/**
 * AFD-316: what a command is waiting for, logged when it waits longer than `SLOW_MS` (then every
 * 30 s, and once more when it ends), so a "Saving…" that stays can be traced.
 */
class CommandWatch {
  static readonly SLOW_MS = 5_000;
  private at = 'waiting behind the commands before it';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private told = false;

  constructor(
    private readonly kind: string,
    private readonly asked: number,
  ) {
    this.timer = setTimeout(() => this.tell(), CommandWatch.SLOW_MS);
  }

  phase(at: string, queuedMs?: number): void {
    this.at = at;
    if (queuedMs !== undefined && queuedMs > CommandWatch.SLOW_MS)
      logChannel().warn(`command ${this.kind} waited ${queuedMs} ms behind the commands before it`);
  }

  private tell(): void {
    this.told = true;
    logChannel().warn(
      `command ${this.kind} has waited ${Date.now() - this.asked} ms, now at: ${this.at}`,
    );
    this.timer = setTimeout(() => this.tell(), 30_000);
  }

  done(): void {
    clearTimeout(this.timer);
    if (this.told)
      logChannel().warn(`command ${this.kind} ended after ${Date.now() - this.asked} ms`);
  }
}
