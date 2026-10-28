// One session per open flow document: parse/validate cache, diagnostics, attached editor panels,
// and the command path webview → planned TextEdits → WorkspaceEdit (ADR-0001).
import * as vscode from 'vscode';
import { CommandError, type FlowCommand, planCommand } from '../core/flow/commands';
import { flowFromFile, type ParsedFlow, rangeOf } from '../core/flow/document';
import type { IdFactory } from '../core/flow/ids';
import { buildModel, ROOT } from '../core/flow/model';
import { openFailPorts } from '../core/flow/openPorts';
import type { SchemaValidator } from '../core/flow/schema';
import type { Position, Ulid } from '../core/flow/types';
import { validateFlow } from '../core/flow/validate';
import type { DomSummary, HostMessage, Snapshot, WebviewMessage } from '../core/protocol';
import { parseYaml, type YamlFile } from '../core/yaml/parse';
import { YamlEditError } from '../core/yaml/transaction';
import { autoPositions, layoutLevel } from './autoLayout';
import { parseErrorDiagnostic, toDiagnostics } from './diagnostics';
import { webviewHtml } from './html';

export interface SessionDeps {
  extensionUri: vscode.Uri;
  diagnostics: vscode.DiagnosticCollection;
  schema: SchemaValidator;
  newId: IdFactory;
  testMode: boolean;
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
      const { model, findings } = validateFlow(parsed.doc, this.deps.schema(parsed.doc));
      const root = model.levels.get(ROOT);
      snapshot = {
        docVersion: version,
        doc: parsed.doc,
        stale: false,
        findings,
        openPorts: openFailPorts(model),
        autoPositions: root ? await this.cachedAutoPositions(root, parsed.doc.layout) : {},
      };
      this.lastGood = snapshot;
      this.deps.diagnostics.set(this.uri, toDiagnostics(this.document, file, findings));
    }
    this.built = { version, parsed, snapshot };
    return snapshot;
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
      case 'tidyUp': {
        const outcome = await this.tidyUp();
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

  /** Plans a command against the current text and applies it as one WorkspaceEdit (one undo step). */
  async runCommand(command: FlowCommand): Promise<CommandOutcome> {
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
    if (result.edits.length === 0) return { ok: true, created: result.created };
    const edit = new vscode.WorkspaceEdit();
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

  /** ELK layout of the whole top level, written to the layout block (one undo step). */
  async tidyUp(): Promise<CommandOutcome> {
    const snapshot = await this.snapshot();
    if (!snapshot.doc) return { ok: false, error: 'The document does not parse' };
    const root = buildModel(snapshot.doc).levels.get(ROOT);
    if (!root) return { ok: false, error: 'No top level' };
    return this.runCommand({ kind: 'tidyUp', positions: await layoutLevel(root) });
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
