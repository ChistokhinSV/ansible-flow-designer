import * as vscode from 'vscode';
import type { CollectionFile } from '../core/catalog/types';
import type { CodeScan, DriftAction } from '../core/drift/types';
import type { FlowCommand } from '../core/flow/commands';
import { parseFlow } from '../core/flow/document';
import { createIdFactory, slugify } from '../core/flow/ids';
import { createSchemaValidator } from '../core/flow/schema';
import { versionBump } from '../core/flow/semantic';
import { newFlowText } from '../core/flow/template';
import type { CatalogRequest, CatalogStatus, DomSummary, RunView } from '../core/protocol';
import { setIn } from '../core/yaml/ops';
import { CatalogService, ensureCacheDir } from './catalog/catalogService';
import { type CodegenOutcome, generateFlow } from './codegen';
import { ProbeManager } from './env/environment';
import { type CommandOutcome, FlowSession, type PerfEvent, type SessionDeps } from './flowSession';
import { headText } from './gitHead';
import { auditUri } from './run/audit';
import { type RunDeps, type RunOptions, runFlow } from './run/runner';
import { type SyntaxOutcome, syntaxCheck } from './run/syntaxCheck';

export const VIEW_TYPE = 'afd.flowEditor';

const isFlow = (doc: vscode.TextDocument) => doc.uri.path.endsWith('.flow.yaml');

/** Exported from activate() in ExtensionMode.Test only (integration and perf suites). */
export interface AfdTestApi {
  run(uri: vscode.Uri, command: FlowCommand): Promise<CommandOutcome>;
  inspect(uri: vscode.Uri): Promise<DomSummary>;
  openLevel(uri: vscode.Uri, level: string): void;
  rendered(uri: vscode.Uri, version: number): Promise<void>;
  perf(uri: vscode.Uri): PerfEvent[];
  cspViolations(uri: vscode.Uri): string[];
  diagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[];
  /** The code generation started by the last save of this flow. */
  savedCode(uri: vscode.Uri): Promise<CodegenOutcome> | undefined;
  runFlow(uri: vscode.Uri, options: RunOptions): Promise<RunView>;
  syntaxCheck(uri: vscode.Uri): Promise<SyntaxOutcome>;
  auditLog(): Promise<Record<string, unknown>[]>;
  /** Serves the folder's catalog from these collection files instead of the probe (M5). */
  useCatalog(uri: vscode.Uri, files: CollectionFile[]): void;
  /** A properties-page catalog request for this flow, answered as the webview gets it. */
  catalog(uri: vscode.Uri, request: CatalogRequest): Promise<unknown>;
  catalogStatus(uri: vscode.Uri): CatalogStatus | undefined;
  /** M6: a real Re-sync from git (probe), the last scan, a scan from elsewhere, drift actions. */
  sync(uri: vscode.Uri): Promise<CodeScan | undefined>;
  useScan(uri: vscode.Uri, scan: CodeScan): void;
  driftAction(uri: vscode.Uri, action: DriftAction): Promise<CommandOutcome>;
}

export function activate(context: vscode.ExtensionContext): AfdTestApi | undefined {
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  const diagnostics = vscode.languages.createDiagnosticCollection('ansible-flow');
  const codeDiagnostics = vscode.languages.createDiagnosticCollection('ansible-flow-code');
  const probeDir = vscode.Uri.joinPath(context.extensionUri, 'dist', 'probe').fsPath;
  const probes = new ProbeManager(probeDir, ensureCacheDir(context.globalStorageUri));
  const catalog = new CatalogService({
    storage: context.globalStorageUri,
    probes,
    extensionUri: context.extensionUri,
    state: context.workspaceState,
  });
  const deps: SessionDeps = {
    extensionUri: context.extensionUri,
    diagnostics,
    schema: createSchemaValidator(),
    newId: createIdFactory(),
    testMode,
    catalog,
    sync: { probes, catalog },
  };
  const sessions = new Map<string, FlowSession>();
  const lastSaved = new Map<string, string>();
  const savedCode = new Map<string, Promise<CodegenOutcome>>();
  const runDeps = (uri: vscode.Uri): RunDeps => ({
    schema: deps.schema,
    probes,
    probeDir,
    storage: context.globalStorageUri,
    state: context.workspaceState,
    testMode,
    report: (run) => sessions.get(uri.toString())?.setRun(run),
  });
  const flowDoc = async (uri?: vscode.Uri) => {
    const target = uri ?? activeSession(sessions)?.uri;
    return target ? vscode.workspace.openTextDocument(target) : undefined;
  };
  const run = async (mode: RunOptions['mode'], uri?: vscode.Uri, options?: Partial<RunOptions>) => {
    const doc = await flowDoc(uri);
    if (!doc) return undefined;
    const result = await runFlow(doc, runDeps(doc.uri), { ...options, mode });
    if (result.state === 'error' && result.error !== 'Cancelled' && !options?.inputs)
      void vscode.window.showErrorMessage(result.error ?? 'The run failed');
    else if (result.state === 'done') void announceRun(result);
    return result;
  };

  const sessionFor = (document: vscode.TextDocument): FlowSession => {
    const key = document.uri.toString();
    let session = sessions.get(key);
    if (!session) {
      session = new FlowSession(document, deps);
      sessions.set(key, session);
      if (!document.isDirty) lastSaved.set(key, document.getText());
    }
    return session;
  };

  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, panel) {
      sessionFor(document).attach(panel);
    },
  };

  context.subscriptions.push(
    diagnostics,
    codeDiagnostics,
    probes,
    catalog,
    catalog.onStatus(({ folder, status }) => {
      for (const s of sessions.values()) s.catalogStatus(folder, status);
    }),
    vscode.commands.registerCommand('afd.catalog.rebuild', async (uri?: vscode.Uri) => {
      const target =
        uri ?? activeSession(sessions)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      const folder = target && vscode.workspace.getWorkspaceFolder(target);
      if (!folder) return void vscode.window.showErrorMessage('Open a repository folder first.');
      try {
        await catalog.ready(folder, true);
        const s = catalog.status(folder);
        void vscode.window.showInformationMessage(
          `Ansible catalog rebuilt: ${s.plugins ?? 0} plugins from ${s.collections ?? 0} collections.`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('afd.environment') || e.affectsConfiguration('ansible'))
        probes.dispose();
    }),
    vscode.commands.registerCommand('afd.runSkeleton', (uri?: vscode.Uri) => run('check', uri)),
    vscode.commands.registerCommand('afd.runReal', (uri?: vscode.Uri) => run('real', uri)),
    vscode.commands.registerCommand('afd.syntaxCheck', async (uri?: vscode.Uri) => {
      const doc = await flowDoc(uri);
      if (!doc) return;
      const outcome = await syntaxCheck(doc, deps.schema, probes, codeDiagnostics);
      if (outcome.ok) void vscode.window.showInformationMessage(outcome.message);
      else void vscode.window.showErrorMessage(outcome.message);
    }),
    vscode.commands.registerCommand('afd.showAudit', async () => {
      const uri = auditUri(context.globalStorageUri);
      try {
        await vscode.window.showTextDocument(uri, { preview: false });
      } catch {
        void vscode.window.showInformationMessage('No run has been launched yet.');
      }
    }),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isFlow(doc)) void sessionFor(doc).refresh();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0) void sessions.get(e.document.uri.toString())?.refresh();
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString();
      sessions.get(key)?.dispose();
      sessions.delete(key);
      lastSaved.delete(key);
    }),
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (isFlow(e.document))
        e.waitUntil(versionBumpEdits(e.document, lastSaved.get(e.document.uri.toString())));
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isFlow(doc)) return;
      lastSaved.set(doc.uri.toString(), doc.getText());
      if (vscode.workspace.getConfiguration('afd', doc.uri).get<boolean>('codegen.onSave', true)) {
        const code = writeCode(doc, deps, false);
        savedCode.set(doc.uri.toString(), code);
        // Implementation mode shows the code: once it is rewritten, sync again (M6).
        void code.then(() => sessions.get(doc.uri.toString())?.resyncIfScanned());
      }
    }),
    vscode.commands.registerCommand('afd.generate', async (uri?: vscode.Uri) => {
      const target = uri ?? activeSession(sessions)?.uri;
      const doc = target && (await vscode.workspace.openTextDocument(target));
      if (!doc) return;
      if (doc.isDirty) await doc.save();
      await writeCode(doc, deps, true);
    }),
    vscode.commands.registerCommand('afd.newFlow', () => newFlow(deps)),
    vscode.commands.registerCommand('afd.tidyUp', async () => {
      const session = activeSession(sessions);
      const outcome = await session?.tidyUp();
      if (outcome && !outcome.ok)
        void vscode.window.showErrorMessage(outcome.error ?? 'Tidy up failed');
    }),
    vscode.commands.registerCommand('afd.validate', async () => {
      await activeSession(sessions)?.refresh();
      await vscode.commands.executeCommand('workbench.actions.view.problems');
    }),
    vscode.commands.registerCommand('afd.openAsText', async (uri?: vscode.Uri) => {
      const target = uri ?? activeSession(sessions)?.uri;
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, 'default');
    }),
  );
  for (const doc of vscode.workspace.textDocuments) if (isFlow(doc)) void sessionFor(doc).refresh();

  if (!testMode) return undefined;
  const get = (uri: vscode.Uri) => {
    const s = sessions.get(uri.toString());
    if (!s) throw new Error(`no session for ${uri.toString()}`);
    return s;
  };
  return {
    run: (uri, command) => get(uri).runCommand(command),
    inspect: (uri) => get(uri).inspect(),
    openLevel: (uri, level) => get(uri).openLevel(level),
    rendered: (uri, version) => get(uri).rendered(version),
    perf: (uri) => get(uri).perf,
    cspViolations: (uri) => get(uri).cspViolations,
    diagnostics: (uri) => diagnostics.get(uri) ?? [],
    savedCode: (uri) => savedCode.get(uri.toString()),
    runFlow: async (uri, options) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      return runFlow(doc, runDeps(uri), options);
    },
    auditLog: async () => {
      try {
        const bytes = await vscode.workspace.fs.readFile(auditUri(context.globalStorageUri));
        return new TextDecoder()
          .decode(bytes)
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
    syntaxCheck: async (uri) =>
      syntaxCheck(
        await vscode.workspace.openTextDocument(uri),
        deps.schema,
        probes,
        codeDiagnostics,
      ),
    useCatalog: (uri, files) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) throw new Error(`no workspace folder for ${uri.toString()}`);
      catalog.useFiles(folder, files);
    },
    catalog: (uri, request) => get(uri).answerCatalog(request),
    sync: async (uri) => {
      await get(uri).sync();
      return get(uri).lastScan;
    },
    useScan: (uri, scan) => get(uri).useScan(scan),
    driftAction: (uri, action) => get(uri).driftAction(action),
    catalogStatus: (uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      return folder ? catalog.status(folder) : undefined;
    },
  };
}

async function announceRun(run: RunView): Promise<void> {
  const s = run.summary;
  const failed = s ? Object.keys(s.outcome).length + s.failures.length : 0;
  const what = run.mode === 'check' ? 'Skeleton run (check mode)' : 'Run';
  const text = s?.stoppedEarly
    ? `${what} stopped early (exit ${run.rc}): see the terminal`
    : `${what} finished (exit ${run.rc}): ${s?.hosts.length ?? 0} host(s), ${failed} failed`;
  const show = 'Show Terminal';
  const pick = await (failed > 0 || run.rc !== 0
    ? vscode.window.showWarningMessage(text, show)
    : vscode.window.showInformationMessage(text, show));
  if (pick === show) await vscode.commands.executeCommand('workbench.action.terminal.focus');
}

export function deactivate(): void {}

function activeSession(sessions: Map<string, FlowSession>): FlowSession | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  const uri =
    input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText
      ? input.uri
      : undefined;
  return uri ? sessions.get(uri.toString()) : undefined;
}

/**
 * Writes generated/ for a flow (ADR-0009). On save this is quiet unless something needs the user;
 * from the command, files edited by hand can be overwritten after a confirmation.
 */
async function writeCode(
  doc: vscode.TextDocument,
  deps: SessionDeps,
  explicit: boolean,
): Promise<CodegenOutcome> {
  let outcome = await generateFlow(doc, deps.schema);
  if (!outcome.ok) {
    if (explicit) void vscode.window.showErrorMessage(outcome.error ?? 'Code generation failed');
    else vscode.window.setStatusBarMessage(`$(warning) ${outcome.error}`, 6000);
    return outcome;
  }
  if (outcome.kept.length > 0) {
    const names = outcome.kept.map((u) => vscode.workspace.asRelativePath(u)).join(', ');
    const overwrite = 'Overwrite';
    const asked = vscode.window.showWarningMessage(
      `Generated code was edited by hand and was not updated: ${names}`,
      { modal: explicit },
      overwrite,
    );
    // On save the answer may come much later (or never); the save path must not wait for it.
    if (!explicit) {
      void asked.then((pick) =>
        pick === overwrite ? generateFlow(doc, deps.schema, { force: true }) : undefined,
      );
      return outcome;
    }
    if ((await asked) === overwrite) {
      const forced = await generateFlow(doc, deps.schema, { force: true });
      outcome = { ...forced, written: [...outcome.written, ...forced.written] };
    }
  }
  const n = outcome.written.length;
  if (n > 0 || explicit) {
    const where = outcome.dir ? vscode.workspace.asRelativePath(outcome.dir) : 'generated';
    vscode.window.setStatusBarMessage(
      n > 0 ? `$(check) Generated ${n} file(s) in ${where}` : `$(check) ${where} is up to date`,
      4000,
    );
  }
  return outcome;
}

/** ADR-0006: on save, bump flow.version once relative to Git HEAD (or the last saved text). */
async function versionBumpEdits(
  document: vscode.TextDocument,
  lastSaved: string | undefined,
): Promise<vscode.TextEdit[]> {
  const current = parseFlow(document.getText());
  if (!current.doc) return [];
  const baseText = (await headText(document.uri)) ?? lastSaved;
  if (baseText === undefined) return [];
  const base = parseFlow(baseText);
  if (!base.doc) return [];
  const next = versionBump(current.doc, base.doc);
  if (next === undefined) return [];
  const result = setIn(current.file, ['flow', 'version'], next);
  if (!result.ok) return [];
  return result.edits.map((e) =>
    vscode.TextEdit.replace(
      new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)),
      e.newText,
    ),
  );
}

async function newFlow(deps: SessionDeps): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder =
    folders.length > 1
      ? await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Repository for the new flow' })
      : folders[0];
  if (!folder) {
    void vscode.window.showErrorMessage('Open a folder (the automation repository) first.');
    return;
  }
  const name = await vscode.window.showInputBox({
    title: 'New flow',
    prompt: 'Flow name',
    placeHolder: 'Edge baseline',
    validateInput: (v) => (v.trim() ? undefined : 'Enter a name'),
  });
  if (!name) return;
  const key = slugify(name, 'flow');
  const uri = vscode.Uri.joinPath(folder.uri, 'flows', key, `${key}.flow.yaml`);
  try {
    await vscode.workspace.fs.stat(uri);
    void vscode.window.showErrorMessage(`${vscode.workspace.asRelativePath(uri)} already exists.`);
    return;
  } catch {
    // Does not exist yet: create it.
  }
  await vscode.workspace.fs.writeFile(
    uri,
    new TextEncoder().encode(newFlowText(name.trim(), key, deps.newId)),
  );
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
}
