// One session per open flow document: parse/validate cache, diagnostics, attached editor panels,
// and the command path webview → planned TextEdits → WorkspaceEdit (ADR-0001).
import * as vscode from 'vscode';
import type { CodeScan, DriftAction } from '../core/drift/types';
import { optionA } from '../core/engine/optionA';
import { codePreview } from '../core/engine/preview';
import { CommandError, type FlowCommand, planCommand } from '../core/flow/commands';
import { flowFromFile, type ParsedFlow, rangeOf } from '../core/flow/document';
import type { IdFactory } from '../core/flow/ids';
import { buildModel, ROOT } from '../core/flow/model';
import { openFailPorts } from '../core/flow/openPorts';
import type { SchemaValidator } from '../core/flow/schema';
import type { Position, Ulid } from '../core/flow/types';
import { validateFlow } from '../core/flow/validate';
import type {
  CatalogRequest,
  CatalogStatus,
  DomSummary,
  HostMessage,
  RunView,
  Snapshot,
  WebviewMessage,
} from '../core/protocol';
import { parseYaml, type YamlFile } from '../core/yaml/parse';
import { YamlEditError } from '../core/yaml/transaction';
import { autoPositions, layoutLevel } from './autoLayout';
import { checkBindings } from './catalog/bindingCheck';
import type { CatalogService } from './catalog/catalogService';
import { generatedDir } from './codegen';
import { parseErrorDiagnostic, toDiagnostics } from './diagnostics';
import { authorName } from './gitHead';
import { webviewHtml } from './html';
import { type SyncDeps, scanFlow } from './sync/codeSync';
import { generateStub, openCode, writeSpecs } from './sync/driftActions';

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
}

export class FlowSession implements vscode.Disposable {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private built?: { version: number; parsed: ParsedFlow; snapshot: Snapshot };
  private building?: { version: number; promise: Promise<Snapshot> };
  private lastGood?: Snapshot;
  /** Parse produced by our own last command; reused when the document text matches it. */
  private pendingParse?: YamlFile;
  private layoutCache = new Map<string, Record<Ulid, Position>>();
  private nextReq = 1;
  private readonly inspectWaiters = new Map<number, (r: DomSummary) => void>();
  private readonly renderWaiters: { version: number; resolve: () => void }[] = [];
  readonly perf: PerfEvent[] = [];
  readonly cspViolations: string[] = [];
  /** Last skeleton or real run of this flow (shown in the top bar and inspector). */
  lastRun: RunView | null = null;
  /** Last code sync (M6); a save re-syncs once there is one. */
  lastScan?: CodeScan;
  private syncing?: Promise<void>;

  constructor(
    readonly document: vscode.TextDocument,
    private readonly deps: SessionDeps,
  ) {}

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
      snapshot = {
        docVersion: version,
        doc: this.lastGood?.doc ?? null,
        stale: true,
        parseError: err?.message ?? 'The document does not parse',
        findings: this.lastGood?.findings ?? [],
        openPorts: this.lastGood?.openPorts ?? [],
        autoPositions: this.lastGood?.autoPositions ?? {},
      };
      this.deps.diagnostics.set(
        this.uri,
        err ? [parseErrorDiagnostic(this.document, err.message, err.offset)] : [],
      );
    } else {
      const validated = validateFlow(parsed.doc, this.deps.schema(parsed.doc));
      const { model } = validated;

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
      snapshot = {
        docVersion: version,
        doc: parsed.doc,
        stale: false,
        findings,
        openPorts: openFailPorts(model),
        autoPositions: await this.allAutoPositions(model, parsed.doc.layout),
        plays: preview?.plays,
      };
      this.lastGood = snapshot;
      this.deps.diagnostics.set(this.uri, toDiagnostics(this.document, file, findings));
    }
    this.built = { version, parsed, snapshot };
    return snapshot;
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
        this.post(panel, { type: 'config', testMode: this.deps.testMode });
        this.post(panel, { type: 'snapshot', snapshot: await this.snapshot() });
        this.post(panel, { type: 'run', run: this.lastRun });
        if (this.catalogFolder && this.deps.catalog)
          this.post(panel, {
            type: 'catalogStatus',
            status: this.deps.catalog.status(this.catalogFolder),
          });
        if (this.lastScan) this.post(panel, { type: 'sync', state: 'done', scan: this.lastScan });
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
      case 'validate':
        await this.refresh();
        await vscode.commands.executeCommand('workbench.actions.view.problems');
        break;
      case 'run':
        await vscode.commands.executeCommand(
          m.mode === 'check' ? 'afd.runSkeleton' : 'afd.runReal',
          this.uri,
        );
        break;
      case 'generate':
        await vscode.commands.executeCommand('afd.generate', this.uri);
        break;
      case 'showRunOutput':
        await vscode.commands.executeCommand('workbench.action.terminal.focus');
        break;
      case 'peekCode':
        await this.peekCode(m.node);
        break;
      case 'tidyUp': {
        const outcome = await this.tidyUp(m.level);
        if (!outcome.ok) void vscode.window.showErrorMessage(outcome.error ?? 'Tidy up failed');
        break;
      }
      case 'inspectResult':
        this.inspectWaiters.get(m.reqId)?.(m.result);
        this.inspectWaiters.delete(m.reqId);
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
    if (this.syncing) return this.syncing;
    const run = async () => {
      const snapshot = await this.snapshot();
      if (!snapshot.doc || !this.deps.sync) return;
      this.broadcast({ type: 'sync', state: 'syncing', scan: this.lastScan });
      try {
        this.lastScan = await scanFlow(this.uri, snapshot.doc, this.deps.sync);
        this.broadcast({ type: 'sync', state: 'done', scan: this.lastScan });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.broadcast({ type: 'sync', state: 'error', scan: this.lastScan, error });
      }
    };
    this.syncing = run().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  /** After a save: the generated code changed, so a shown sync is out of date. */
  resyncIfScanned(): void {
    if (this.lastScan && this.hasPanels) void this.sync();
  }

  /** Test mode: a scan from elsewhere (no probe). */
  useScan(scan: CodeScan): void {
    this.lastScan = scan;
    this.broadcast({ type: 'sync', state: 'done', scan });
  }

  async driftAction(action: DriftAction): Promise<CommandOutcome> {
    const doc = (await this.snapshot()).doc;
    if (!doc) return { ok: false, error: 'The flow does not parse' };
    const host = { uri: this.uri, doc, runCommand: this.runCommand.bind(this) };
    let outcome: CommandOutcome;
    switch (action.kind) {
      case 'generateStub':
        outcome = await generateStub(host, action.node, action.role);
        break;
      case 'writeSpecs':
        outcome = await writeSpecs(host, action.node, this.lastScan);
        break;
      case 'resync':
        await this.sync();
        return { ok: true };
      case 'regenerate':
        await vscode.commands.executeCommand('afd.generate', this.uri);
        outcome = { ok: true };
        break;
      default:
        return { ok: false, error: `${action.kind} is not a host action` };
    }
    if (outcome.ok) void this.sync();
    return outcome;
  }

  setRun(run: RunView): void {
    this.lastRun = run;
    this.broadcast({ type: 'run', run });
  }

  /** Plans a command against the current text and applies it as one WorkspaceEdit (one undo step). */
  async runCommand(
    input: FlowCommand,
    /** Adds file operations to the same WorkspaceEdit (M6 stubs): one undo step with the design. */
    extra?: (edit: vscode.WorkspaceEdit) => void,
  ): Promise<CommandOutcome> {
    // The webview never names the author of a decision; the host does (decision 13).
    const command =
      (input.kind === 'setDecision' || input.kind === 'ignoreDrift') && !input.by
        ? { ...input, by: await authorName(this.uri) }
        : input;
    const snapshot = await this.snapshot();
    if (snapshot.stale)
      return {
        ok: false,
        error: 'The document has YAML errors; fix them in the text editor first',
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
    if (result.edits.length === 0 && !extra) return { ok: true, created: result.created };
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
    return { ok: true, created: result.created };
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
    const [s, e] = rangeOf(this.built.parsed.file, path);
    const range = new vscode.Range(this.document.positionAt(s), this.document.positionAt(e));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Test mode: the first panel's DOM summary. */
  inspect(): Promise<DomSummary> {
    const panel = [...this.panels][0];
    if (!panel) return Promise.reject(new Error('no panel'));
    const reqId = this.nextReq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('inspect timed out')), 10_000);
      this.inspectWaiters.set(reqId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.post(panel, { type: 'inspect', reqId });
    });
  }

  /** Opens a level (`root` or a subflow node id) in every panel of this flow. */
  openLevel(level: string): void {
    this.broadcast({ type: 'openLevel', level });
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
    this.deps.diagnostics.delete(this.uri);
    for (const p of this.panels) p.dispose();
    this.panels.clear();
  }
}
