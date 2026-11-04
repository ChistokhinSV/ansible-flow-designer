// What the extension's parts share (AFD-37): the services built at activation, the open flow
// sessions, and the one answer to "which flow does the user mean". Commands live in their area's
// module and get this object; activate() only composes.
import * as vscode from 'vscode';
import { createIdFactory } from '../core/flow/ids';
import { createSchemaValidator } from '../core/flow/schema';
import type { AwxDeps } from './awx/awxRun';
import { CatalogService, ensureCacheDir } from './catalog/catalogService';
import type { CodegenOutcome } from './codegen';
import { CMD } from './commands/ids';
import { ProbeManager } from './env/environment';
import { FlowSession, type SessionDeps } from './flowSession';
import type { PlaybookImportDeps } from './import/playbookImport';
import { logChannel } from './log';
import type { RunDeps } from './run/runner';

export const VIEW_TYPE = 'afd.flowEditor';

export const isFlow = (doc: vscode.TextDocument) => doc.uri.path.endsWith('.flow.yaml');

export class Host {
  readonly testMode: boolean;
  readonly log = logChannel();
  readonly diagnostics = vscode.languages.createDiagnosticCollection('ansible-flow');
  readonly codeDiagnostics = vscode.languages.createDiagnosticCollection('ansible-flow-code');
  readonly probeDir: string;
  readonly probes: ProbeManager;
  readonly catalog: CatalogService;
  readonly deps: SessionDeps;
  /** Imports bind short module names by the folder's catalog, when one is loaded (AFD-26). */
  readonly playbookDeps: PlaybookImportDeps;
  readonly sessions = new Map<string, FlowSession>();
  /** Each flow's text as last saved, for the version bump on the next save (ADR-0006). */
  readonly lastSaved = new Map<string, string>();
  /** The code generation started by each flow's last save (tests wait for it). */
  readonly savedCode = new Map<string, Promise<CodegenOutcome>>();

  constructor(readonly context: vscode.ExtensionContext) {
    this.testMode = context.extensionMode === vscode.ExtensionMode.Test;
    this.probeDir = vscode.Uri.joinPath(context.extensionUri, 'dist', 'probe').fsPath;
    this.probes = new ProbeManager(this.probeDir, ensureCacheDir(context.globalStorageUri), (l) =>
      l.startsWith('probe stderr:') ? this.log.debug(l) : this.log.info(l),
    );
    this.catalog = new CatalogService({
      storage: context.globalStorageUri,
      probes: this.probes,
      extensionUri: context.extensionUri,
      state: context.workspaceState,
    });
    this.deps = {
      extensionUri: context.extensionUri,
      diagnostics: this.diagnostics,
      schema: createSchemaValidator(),
      newId: createIdFactory(),
      testMode: this.testMode,
      catalog: this.catalog,
      sync: { probes: this.probes, catalog: this.catalog },
      lens: {
        probes: this.probes,
        state: context.workspaceState,
        storage: context.globalStorageUri,
      },
    };
    this.playbookDeps = {
      newId: this.deps.newId,
      resolveModule: (folder) => {
        const index = this.catalog.cached(folder)?.index;
        return index ? (name, collections) => index.resolve(name, collections).fqcn : undefined;
      },
    };
    context.subscriptions.push(
      this.log,
      this.diagnostics,
      this.codeDiagnostics,
      this.probes,
      this.catalog,
    );
  }

  get storage(): vscode.Uri {
    return this.context.globalStorageUri;
  }

  runDeps(uri: vscode.Uri): RunDeps {
    return {
      schema: this.deps.schema,
      probes: this.probes,
      probeDir: this.probeDir,
      storage: this.storage,
      state: this.context.workspaceState,
      testMode: this.testMode,
      report: (run) => this.sessions.get(uri.toString())?.setRun(run),
      designerOpen: () => this.sessions.get(uri.toString())?.hasPanels ?? false,
    };
  }

  awxDeps(uri: vscode.Uri): AwxDeps {
    return {
      secrets: this.context.secrets,
      storage: this.storage,
      state: this.context.workspaceState,
      schema: this.deps.schema,
      testMode: this.testMode,
      report: (run) => this.sessions.get(uri.toString())?.setRun(run),
      runCommand: async (command) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        return this.sessionFor(doc).runCommand(command);
      },
    };
  }

  sessionFor(document: vscode.TextDocument): FlowSession {
    const key = document.uri.toString();
    let session = this.sessions.get(key);
    if (!session) {
      session = new FlowSession(document, this.deps);
      this.sessions.set(key, session);
      if (!document.isDirty) this.lastSaved.set(key, document.getText());
    }
    return session;
  }

  /** The session of the active tab: the designer, or the flow open as text. */
  activeSession(): FlowSession | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const uri =
      input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText
        ? input.uri
        : undefined;
    return uri ? this.sessions.get(uri.toString()) : undefined;
  }

  /** A flow file open as text in the active editor. */
  private activeFlowText(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor?.document;
    return editor && isFlow(editor) ? editor.uri : undefined;
  }

  /** The flow a command means: its argument, else the active designer or flow editor. */
  targetUri(arg?: vscode.Uri): vscode.Uri | undefined {
    return arg ?? this.activeSession()?.uri ?? this.activeFlowText();
  }

  /**
   * The flow a command works on, opened as a document. Without one it says so (once per call),
   * instead of doing nothing; `quiet` skips the message (callers that report it themselves).
   */
  async resolveTargetFlow(
    arg?: vscode.Uri,
    options: { quiet?: boolean } = {},
  ): Promise<vscode.TextDocument | undefined> {
    const uri = this.targetUri(arg);
    if (uri) return vscode.workspace.openTextDocument(uri);
    if (!options.quiet && !this.testMode) {
      const create = 'New Flow…';
      void vscode.window
        .showInformationMessage(
          'Open a flow first: this command works on the flow in the designer or the editor.',
          create,
        )
        .then((pick) =>
          pick === create ? vscode.commands.executeCommand(CMD.newFlow) : undefined,
        );
    }
    return undefined;
  }

  /** A folder-level scope (the AWX settings, the catalog): the flow's, else the first folder. */
  scopeUri(arg?: vscode.Uri): vscode.Uri | undefined {
    return this.targetUri(arg) ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  openDesigner(uri: vscode.Uri): Thenable<unknown> {
    return vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { preview: false });
  }
}
