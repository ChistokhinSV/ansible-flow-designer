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
import { timingStats } from '../core/lens/history';
import { inventoryPatterns } from '../core/lens/inventory';
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
import { autoPositions, layoutLevel } from './autoLayout';
import { checkBindings } from './catalog/bindingCheck';
import type { CatalogService } from './catalog/catalogService';
import { generatedDir } from './codegen';
import { parseErrorDiagnostic, toDiagnostics } from './diagnostics';
import type { ProbeManager } from './env/environment';
import { authorName } from './gitHead';
import { webviewHtml } from './html';
import { readCode, readInventory, rememberedTargets, rememberTargets } from './lens/lensFacts';
import { readHistory, recordRun } from './run/history';
import { type SyncDeps, scanFlow } from './sync/codeSync';
import { generateStub, openCode, writeSpecs } from './sync/driftActions';
import { markTour } from './tour';

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
  /** Lens facts gathered for this flow (M8) and the lens the panels show. */
  lensFacts: LensFacts = {};
  private lensOpen?: LensId;
  /** Targets and patterns of the last inventory read: a new pattern reads again. */
  private inventoryKey?: string;
  private codeKey?: string;

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
      const shown = model.doc;

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
        doc: shown,
        stale: false,
        findings,
        openPorts: openFailPorts(model),
        autoPositions: await this.allAutoPositions(model, shown.layout),
        plays: preview?.plays,
        ...(gaps > 0 ? { idGaps: gaps } : {}),
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
    if (this.lensOpen && snapshot.doc && !snapshot.stale) void this.gatherLens(snapshot.doc, false);
  }

  /** Facts for the open lens; the inventory is read only when targets or patterns changed. */
  private async gatherLens(doc: FlowDocument, refresh: boolean): Promise<void> {
    const lens = this.lensOpen;
    const deps = this.deps.lens;
    if (!lens) return;
    const bindings = JSON.stringify(
      [...buildModel(doc).nodes.values()].map((e) => e.node.impl?.ref ?? ''),
    );
    if (lens !== 'data' && lens !== 'timing' && (refresh || this.codeKey !== bindings)) {
      this.codeKey = bindings;
      this.lensFacts.code = await readCode(this.uri, doc, this.deps.catalog);
      this.broadcast({ type: 'lensFacts', facts: { code: this.lensFacts.code } });
    }
    if (lens === 'timing' && deps && (refresh || !this.lensFacts.timing)) {
      this.lensFacts.timing = timingStats(await readHistory(deps.storage, doc.flow.id));
      this.broadcast({ type: 'lensFacts', facts: { timing: this.lensFacts.timing } });
    }
    if ((lens === 'inventory' || lens === 'access') && deps) {
      const targets = rememberedTargets(doc, deps.state);
      const key = `${targets}|${inventoryPatterns(doc, targets, this.lensFacts.code).join('|')}`;
      const current = this.lensFacts.inventory;
      if (!refresh && this.inventoryKey === key && current?.state !== 'error') return;
      this.inventoryKey = key;
      this.lensFacts.inventory = { state: 'loading', targets, facts: current?.facts };
      this.broadcast({ type: 'lensFacts', facts: { inventory: this.lensFacts.inventory } });
      try {
        const { facts, inventory } = await readInventory(
          this.uri,
          doc,
          deps.probes,
          targets,
          this.lensFacts.code,
        );
        this.lensFacts.inventory = { state: 'ready', facts, targets, inventory };
      } catch (e) {
        this.inventoryKey = undefined;
        this.lensFacts.inventory = { state: 'error', error: (e as Error).message, targets };
      }
      this.broadcast({ type: 'lensFacts', facts: { inventory: this.lensFacts.inventory } });
    }
  }

  async openLens(lens: LensId | null, refresh = false): Promise<void> {
    this.lensOpen = lens ?? undefined;
    const doc = (await this.snapshot()).doc;
    if (doc) await this.gatherLens(doc, refresh);
  }

  /** The Inventory lens's "Set targets": asks, remembers with the run inputs, reads again. */
  private async askTargets(): Promise<void> {
    const deps = this.deps.lens;
    const doc = (await this.snapshot()).doc;
    if (!deps || !doc) return;
    const text = await vscode.window.showInputBox({
      title: `${doc.flow.name}: flow targets`,
      prompt: 'Hosts or groups the flow runs on, comma-separated (remembered for runs too)',
      value: rememberedTargets(doc, deps.state),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Enter at least one host or group'),
    });
    if (text === undefined) return;
    await rememberTargets(doc, deps.state, text);
    await this.gatherLens(doc, true);
  }

  /** Test API: targets without the input box. */
  async useTargets(text: string): Promise<void> {
    const deps = this.deps.lens;
    const doc = (await this.snapshot()).doc;
    if (!deps || !doc) return;
    await rememberTargets(doc, deps.state, text);
    await this.gatherLens(doc, true);
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
        if (Object.keys(this.lensFacts).length > 0)
          this.post(panel, { type: 'lensFacts', facts: this.lensFacts });
        break;
      case 'lens':
        await this.openLens(m.lens, m.refresh);
        break;
      case 'setTargets':
        await this.askTargets();
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
    const deps = this.deps.lens;
    const id = this.built?.parsed.doc?.flow.id;
    if (deps && id && run.state === 'done')
      void recordRun(deps.storage, id, run).then((entries) => {
        if (!entries) return;
        this.lensFacts.timing = timingStats(entries);
        this.broadcast({ type: 'lensFacts', facts: { timing: this.lensFacts.timing } });
      });
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
    this.deps.diagnostics.delete(this.uri);
    for (const p of this.panels) p.dispose();
    this.panels.clear();
  }
}

/** No YAML content yet: whitespace or comments only. */
function isEmptyFile(file: YamlFile): boolean {
  return file.errors.length === 0 && (file.doc.toJS() ?? null) === null;
}
