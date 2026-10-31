// One session per open flow document: parse/validate cache, diagnostics, attached editor panels,
// and the command path webview → planned TextEdits → WorkspaceEdit (ADR-0001).
import * as vscode from 'vscode';
import type { CodeScan, DriftAction } from '../core/drift/types';
import { optionA } from '../core/engine/optionA';
import { codePreview } from '../core/engine/preview';
import { CommandError, type FlowCommand, planCommand } from '../core/flow/commands';
import { completeIds } from '../core/flow/completeIds';
import { elementRangeOf, flowFromFile, type ParsedFlow } from '../core/flow/document';
import { type IdFactory, slugify } from '../core/flow/ids';
import { buildModel, ROOT } from '../core/flow/model';
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
  RunView,
  Snapshot,
  WebviewMessage,
} from '../core/protocol';
import { diffEdits } from '../core/yaml/edits';
import { parseYaml, type YamlFile } from '../core/yaml/parse';
import { YamlEditError } from '../core/yaml/transaction';
import { autoPositions, layoutLevel, shownLayout } from '../node/autoLayout';
import { checkBindings } from '../node/catalog/bindingCheck';
import type { CatalogService } from './catalog/catalogService';
import { generatedDir } from './codegen';
import { parseErrorDiagnostic, toDiagnostics } from './diagnostics';
import type { ProbeManager } from './env/environment';
import { authorName } from './gitHead';
import { webviewHtml } from './html';
import { LensController } from './session/lensController';
import { RequestTracker } from './session/requests';
import { SyncController } from './session/syncController';
import type { SyncDeps } from './sync/codeSync';
import { openCode } from './sync/driftActions';
import { markTour } from './tour';

/** How long typing in a text editor settles before the designer catches up (AFD-38). */
const TYPING_SETTLES_MS = 150;

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
  private readonly inspects = new RequestTracker<DomSummary>();
  private readonly pngs = new RequestTracker<{ data?: string; error?: string }>();
  /** AFD-25: panels that have loaded, and callers waiting for one (PNG export). */
  private readonly readyPanels = new Set<vscode.WebviewPanel>();
  private readyWaiters: (() => void)[] = [];
  private readonly renderWaiters: { version: number; resolve: () => void }[] = [];
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
    const key = JSON.stringify([
      level.nodes.map((n) => [n?.id, n?.type, layout?.[n?.id ?? ''] ?? null]),
      level.edges.map((e) => [e?.from?.node, e?.to?.node]),
    ]);
    const hit = this.layoutCache.get(key);
    if (hit) return hit;
    const positions = await autoPositions(level, layout);
    if (this.layoutCache.size > 20) this.layoutCache.clear();
    this.layoutCache.set(key, positions);
    return positions;
  }

  /** Rebuilds after a document change and pushes the snapshot to every panel. */
  async refresh(): Promise<void> {
    const snapshot = await this.snapshot();
    if (snapshot.docVersion !== this.document.version) return;
    this.broadcast({ type: 'snapshot', snapshot });
    if (snapshot.doc && !snapshot.stale) this.lens.followed(snapshot.doc);
  }

  /**
   * The document changed. The designer's own edits, and undo in the designer, show at once;
   * typing in a text editor settles for a moment first, instead of parsing, validating,
   * generating and laying out at every key (AFD-38).
   */
  changed(): void {
    clearTimeout(this.changeTimer);
    const typing = vscode.window.visibleTextEditors.some((e) => e.document === this.document);
    if (!typing || this.pendingParse?.text === this.document.getText()) {
      void this.refresh();
      return;
    }
    this.changeTimer = setTimeout(() => void this.refresh(), TYPING_SETTLES_MS);
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
    this.panels.add(panel);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'webview')],
    };
    panel.webview.html = webviewHtml(panel.webview, this.deps.extensionUri);
    const sub = panel.webview.onDidReceiveMessage((m: WebviewMessage) => {
      void this.onMessage(panel, m);
    });
    panel.onDidDispose(() => {
      sub.dispose();
      this.panels.delete(panel);
      this.readyPanels.delete(panel);
    });
  }

  private post(panel: vscode.WebviewPanel, message: HostMessage): void {
    void panel.webview.postMessage(message);
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
        this.post(panel, { type: 'snapshot', snapshot: await this.snapshot() });
        this.post(panel, { type: 'run', run: this.lastRun });
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
      case 'requestPaste': {
        const text = await vscode.env.clipboard.readText();
        this.post(panel, { type: 'clipboard', action: 'paste', text, at: m.at });
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
        // Through the command, so the walkthrough step that waits for it checks off (AFD-22).
        await vscode.commands.executeCommand('afd.validate');
        break;
      case 'openGuide':
        await vscode.commands.executeCommand('afd.openGuide', m.page);
        break;
      case 'run':
        await vscode.commands.executeCommand(
          m.mode === 'check' ? 'afd.runSkeleton' : 'afd.runReal',
          this.uri,
        );
        break;
      case 'launchAwx':
        await vscode.commands.executeCommand('afd.awx.launch', this.uri);
        break;
      case 'generate':
        await vscode.commands.executeCommand('afd.generate', this.uri);
        break;
      case 'showRunOutput': {
        // Only URLs the host itself got from AWX: the run, or one of its approvals (AFD-11).
        const url = m.approval
          ? this.lastRun?.awx?.approvals?.[m.approval]?.url
          : this.lastRun?.awx?.url;
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
        else if (!m.approval)
          await vscode.commands.executeCommand('workbench.action.terminal.focus');
        break;
      }
      case 'peekCode':
        await this.peekCode(m.node);
        break;
      case 'tidyUp': {
        const outcome = await this.tidyUp(m.level);
        if (!outcome.ok) void vscode.window.showErrorMessage(outcome.error ?? 'Tidy up failed');
        break;
      }
      case 'inspectResult':
        this.inspects.answer(m.reqId, m.result);
        break;
      case 'pngRendered':
        this.pngs.answer(m.reqId, m);
        break;
      case 'export':
        if (m.format === 'drawio')
          await vscode.commands.executeCommand('afd.exportDrawio', this.uri);
        else await vscode.commands.executeCommand('afd.exportImage', this.uri, { level: m.level });
        break;
      case 'perf':
        this.perf.push({ event: m.event, ms: m.ms, docVersion: m.docVersion });
        if (m.event === 'render' || m.event === 'firstRender') {
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
    const command =
      (input.kind === 'setDecision' ||
        input.kind === 'ignoreDrift' ||
        input.kind === 'acceptFinding') &&
      !input.by
        ? { ...input, by: await authorName(this.uri) }
        : input;
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
    return this.runCommand({ kind: 'tidyUp', positions: await layoutLevel(level) });
  }

  /** D-22 "Peek code": the node's play in its generated file; a subflow opens its level file. */
  async peekCode(node: Ulid): Promise<void> {
    const snapshot = await this.snapshot();
    if (!snapshot.doc) return;
    const result = optionA.generate(snapshot.doc, {
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
      void vscode.window.showInformationMessage(
        'Save the flow to generate its code (or run Generate Playbook)',
      );
      return;
    }
    const editor = await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
    });
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
  whenReady(timeoutMs = 30_000): Promise<void> {
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
      60_000,
      'drawing the PNG',
    );
    if (!r.data) throw new Error(r.error ?? 'drawing the PNG failed');
    return Buffer.from(r.data, 'base64');
  }

  /** Test mode: the first panel's DOM summary. */
  inspect(): Promise<DomSummary> {
    const panel = [...this.panels][0];
    if (!panel) return Promise.reject(new Error('no panel'));
    return this.inspects.request(
      (reqId) => this.post(panel, { type: 'inspect', reqId }),
      10_000,
      'inspect',
    );
  }

  /** Opens a level (`root` or a subflow node id) in every panel of this flow. */
  setMode(mode: 'design' | 'implementation' | 'run'): void {
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
      return { ok: false, error: 'The file has content: open it as text to change it' };
    const base = (this.uri.path.split('/').pop() ?? 'flow').replace(/\.flow\.ya?ml$/i, '');
    const key = slugify(base, 'flow');
    const words = base.replace(/[-_.]+/g, ' ').trim() || 'Flow';
    const name = words.charAt(0).toUpperCase() + words.slice(1);
    let body =
      (text.trim() ? `${text.replace(/\s+$/, '')}\n` : '') +
      newFlowText(name, key, this.deps.newId);
    if (this.document.eol === vscode.EndOfLine.CRLF) body = body.replace(/\r?\n/g, '\r\n');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.uri,
      new vscode.Range(this.document.positionAt(0), this.document.positionAt(text.length)),
      body,
    );
    return (await vscode.workspace.applyEdit(edit))
      ? { ok: true }
      : { ok: false, error: 'VS Code did not apply the edit' };
  }

  /** Test mode: resolves once a panel has rendered `version` or later. */
  rendered(version: number): Promise<void> {
    if (
      this.perf.some(
        (p) => (p.event === 'render' || p.event === 'firstRender') && p.docVersion >= version,
      )
    ) {
      return Promise.resolve();
    }
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
