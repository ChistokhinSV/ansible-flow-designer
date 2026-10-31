import * as vscode from 'vscode';
import type { ToolResult } from '../core/ai/handlers';
import { runTool } from '../core/ai/handlers';
import type { CollectionFile } from '../core/catalog/types';
import type { CodeScan, DriftAction } from '../core/drift/types';
import type { FlowCommand } from '../core/flow/commands';
import { parseFlow } from '../core/flow/document';
import { createIdFactory, slugify } from '../core/flow/ids';
import { planSave } from '../core/flow/save';
import { createSchemaValidator } from '../core/flow/schema';
import { newFlowText } from '../core/flow/template';
import type { LensFacts, LensId } from '../core/lens/types';
import type { CatalogRequest, CatalogStatus, DomSummary, RunView } from '../core/protocol';
import { COMPLETE_IDS, CompleteIdsActions } from './ai/completeIdsAction';
import { hostFlowIO, registerFlowTools } from './ai/lmTools';
import { AiSetup, type SetupPicks } from './ai/setup';
import type { Agent, Item as SetupItem } from './ai/writers';
import { type ImportOutcome, type ImportRequest, importAwxWorkflow } from './awx/awxImport';
import {
  type AwxDeps,
  type AwxPicks,
  clearToken,
  launchInAwx,
  setToken,
  setupTemplate,
} from './awx/awxRun';
import { CatalogService, ensureCacheDir } from './catalog/catalogService';
import { type CodegenOutcome, generateFlow } from './codegen';
import { ProbeManager } from './env/environment';
import {
  announceImplementedAgain,
  type CommandOutcome,
  FlowSession,
  type PerfEvent,
  type SessionDeps,
} from './flowSession';
import { headText } from './gitHead';
import { registerHelp } from './help';
import { auditUri } from './run/audit';
import { type RunDeps, type RunOptions, runFlow } from './run/runner';
import { type SyntaxOutcome, syntaxCheck } from './run/syntaxCheck';
import { tourReached } from './tour';

export const VIEW_TYPE = 'afd.flowEditor';

const isFlow = (doc: vscode.TextDocument) => doc.uri.path.endsWith('.flow.yaml');

/** Exported from activate() in ExtensionMode.Test only (integration and perf suites). */
export interface AfdTestApi {
  run(uri: vscode.Uri, command: FlowCommand): Promise<CommandOutcome>;
  inspect(uri: vscode.Uri): Promise<DomSummary>;
  openLevel(uri: vscode.Uri, level: string): void;
  /** Selects a node on the canvas (opening its level), as a click would. */
  reveal(uri: vscode.Uri, node: string): void;
  setMode(uri: vscode.Uri, mode: 'design' | 'implementation' | 'run'): void;
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
  /** M7: an AWX token for the configured URL, the template setup with fixed picks, a launch. */
  awxToken(uri: vscode.Uri, token: string): Promise<string | undefined>;
  awxSetup(
    uri: vscode.Uri,
    picks: AwxPicks,
  ): Promise<{ ok: boolean; error?: string; template?: string }>;
  awxLaunch(uri: vscode.Uri, inputs: Record<string, unknown>): Promise<RunView>;
  /** M8: the lens on the flow's panels, the facts its session gathered, the lens targets. */
  setLens(uri: vscode.Uri, lens: LensId | null): void;
  lensFacts(uri: vscode.Uri): LensFacts;
  setTargets(uri: vscode.Uri, targets: string): Promise<void>;
  /** AFD-16: the empty-file page's Create a flow here. */
  initFlow(uri: vscode.Uri): Promise<CommandOutcome>;
  /** M9: Import AWX Workflow with every pick given (writes the flow, does not open it). */
  importAwx(request: ImportRequest): Promise<ImportOutcome>;
  /** AFD-19: a Copilot flow tool, called as Copilot calls it (without the confirmation). */
  aiTool(name: string, input: unknown): Promise<ToolResult>;
  /** AFD-19: Set Up / Remove AI Assistants with the picks given and no questions. */
  setupAi(picks: SetupPicks): Promise<SetupItem[] | undefined>;
  removeAi(picks: {
    agents: Agent[];
    home?: string;
    repo?: string;
  }): Promise<SetupItem[] | undefined>;
  /** AFD-22: the walkthrough tour keys the designer's edits have set this session. */
  tour(): string[];
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
    lens: { probes, state: context.workspaceState, storage: context.globalStorageUri },
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
  const awxDeps = (uri: vscode.Uri): AwxDeps => ({
    secrets: context.secrets,
    storage: context.globalStorageUri,
    state: context.workspaceState,
    schema: deps.schema,
    testMode,
    report: (run) => sessions.get(uri.toString())?.setRun(run),
    runCommand: async (command) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      return sessionFor(doc).runCommand(command);
    },
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

  // AFD-19: Copilot's flow tools see the workspace's flows; edits are one undo step each.
  const flowIO = hostFlowIO({
    schema: deps.schema,
    newId: deps.newId,
    activeFlow: () => {
      const editor = vscode.window.activeTextEditor?.document;
      return activeSession(sessions)?.uri ?? (editor && isFlow(editor) ? editor.uri : undefined);
    },
    open: (uri) =>
      vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { preview: false }),
  });
  context.subscriptions.push(...registerFlowTools(flowIO));
  // AFD-22: the user guide, the walkthroughs and the sample flows.
  context.subscriptions.push(
    ...registerHelp(context, (uri) =>
      vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { preview: false }),
    ),
  );
  const aiSetup = new AiSetup(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('afd.setupAi', () => aiSetup.setup()),
    vscode.commands.registerCommand('afd.removeAi', () => aiSetup.remove()),
  );
  // AFD-20: the extension also starts after VS Code does (onStartupFinished), so agents found
  // without the setup are offered it even in folders without flows.
  void (
    testMode ? aiSetup.refreshContext() : aiSetup.checkStale().then(() => aiSetup.offer())
  ).catch(() => undefined);
  // The schema compiles on first use; where flows exist, do it now, before the first one opens.
  void vscode.workspace.findFiles('**/*.flow.yaml', '**/node_modules/**', 1).then(
    (found) => found.length > 0 && setTimeout(() => deps.schema({}), 0),
    () => undefined,
  );

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
    vscode.commands.registerCommand('afd.awx.launch', async (uri?: vscode.Uri) => {
      const doc = await flowDoc(uri);
      if (!doc) return undefined;
      const result = await launchInAwx(doc, awxDeps(doc.uri));
      if (result.state === 'error' && result.error !== 'Cancelled') {
        const setup = /Set Up AWX Template/.test(result.error ?? '')
          ? 'Set Up AWX Template'
          : undefined;
        const token = /Set AWX Token/.test(result.error ?? '') ? 'Set AWX Token' : undefined;
        const choice = await vscode.window.showErrorMessage(
          result.error ?? 'The AWX run failed',
          ...[setup, token].filter((x): x is string => !!x),
        );
        if (choice === setup)
          await vscode.commands.executeCommand('afd.awx.setupTemplate', doc.uri);
        if (choice === token) await vscode.commands.executeCommand('afd.awx.setToken', doc.uri);
      } else if (result.state === 'done') void announceRun(result);
      return result;
    }),
    vscode.commands.registerCommand('afd.awx.setupTemplate', async (uri?: vscode.Uri) => {
      const doc = await flowDoc(uri);
      if (!doc) return;
      const r = await setupTemplate(doc, awxDeps(doc.uri));
      if (r.ok)
        void vscode.window.showInformationMessage(
          `AWX job template "${r.template}" is ready; the flow now launches it.`,
        );
      else if (r.error !== 'Cancelled')
        void vscode.window.showErrorMessage(r.error ?? 'Setting up the AWX template failed');
    }),
    vscode.commands.registerCommand('afd.awx.setToken', async (uri?: vscode.Uri) => {
      const scope =
        uri ?? activeSession(sessions)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!scope) return;
      const error = await setToken(scope, context.secrets);
      if (error && error !== 'Cancelled') void vscode.window.showErrorMessage(error);
    }),
    vscode.commands.registerCommand('afd.awx.clearToken', async (uri?: vscode.Uri) => {
      const scope =
        uri ?? activeSession(sessions)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      if (scope) await clearToken(scope, context.secrets);
    }),
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
        e.waitUntil(saveEdits(e.document, lastSaved.get(e.document.uri.toString())));
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
    vscode.commands.registerCommand('afd.importAwxWorkflow', async () => {
      const outcome = await importAwxWorkflow(context.secrets, deps.newId);
      if (outcome.error) {
        if (outcome.error !== 'Cancelled') void vscode.window.showErrorMessage(outcome.error);
        return;
      }
      if (outcome.uri)
        await vscode.commands.executeCommand('vscode.openWith', outcome.uri, VIEW_TYPE);
      void announceImport(outcome);
    }),
    vscode.commands.registerCommand('afd.tidyUp', async () => {
      const session = activeSession(sessions);
      const outcome = await session?.tidyUp();
      if (outcome && !outcome.ok)
        void vscode.window.showErrorMessage(outcome.error ?? 'Tidy up failed');
    }),
    vscode.commands.registerCommand(COMPLETE_IDS, async (uri?: vscode.Uri) => {
      const doc = await flowDoc(uri);
      if (!doc) return;
      const outcome = await sessionFor(doc).completeIds();
      if (!outcome.ok) void vscode.window.showErrorMessage(outcome.error ?? 'IDs not completed');
    }),
    vscode.languages.registerCodeActionsProvider(
      { pattern: '**/*.flow.yaml' },
      new CompleteIdsActions(),
      { providedCodeActionKinds: CompleteIdsActions.kinds },
    ),
    vscode.commands.registerCommand('afd.copyNodes', () => activeSession(sessions)?.copyNodes()),
    vscode.commands.registerCommand('afd.pasteNodes', () => activeSession(sessions)?.pasteNodes()),
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
    aiTool: (name, input) => runTool(flowIO, name, input),
    setupAi: (picks) => aiSetup.setup(picks, false),
    removeAi: (picks) => aiSetup.remove(picks),
    tour: () => tourReached(),
    inspect: (uri) => get(uri).inspect(),
    openLevel: (uri, level) => get(uri).openLevel(level),
    reveal: (uri, node) => get(uri).reveal(node),
    setMode: (uri, mode) => get(uri).setMode(mode),
    setLens: (uri, lens) => get(uri).setLens(lens),
    lensFacts: (uri) => get(uri).lensFacts,
    setTargets: (uri, targets) => get(uri).useTargets(targets),
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
    awxToken: (uri, token) => setToken(uri, context.secrets, token),
    awxSetup: async (uri, picks) =>
      setupTemplate(await vscode.workspace.openTextDocument(uri), awxDeps(uri), picks),
    awxLaunch: async (uri, inputs) =>
      launchInAwx(await vscode.workspace.openTextDocument(uri), awxDeps(uri), {
        inputs,
        yes: true,
      }),
    importAwx: (request) => importAwxWorkflow(context.secrets, deps.newId, request),
    initFlow: (uri) => get(uri).initFlow(),
    catalogStatus: (uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      return folder ? catalog.status(folder) : undefined;
    },
  };
}

async function announceImport(outcome: ImportOutcome): Promise<void> {
  const c = outcome.counts;
  const text = `Imported ${vscode.workspace.asRelativePath(outcome.uri as vscode.Uri)}: ${c?.steps ?? 0} step(s), ${c?.implemented ?? 0} implemented, ${c?.drafts ?? 0} draft.`;
  const show = outcome.notes.length ? 'Show notes' : undefined;
  const pick = await vscode.window.showInformationMessage(text, ...(show ? [show] : []));
  if (pick === show)
    await vscode.window.showQuickPick(outcome.notes, {
      title: 'What the import could not map one to one',
      canPickMany: false,
    });
}

async function announceRun(run: RunView): Promise<void> {
  const s = run.summary;
  const failed = s ? Object.keys(s.outcome).length + s.failures.length : 0;
  const what = run.awx
    ? `AWX job #${run.awx.jobId} (${run.awx.status})`
    : run.mode === 'check'
      ? 'Skeleton run (check mode)'
      : 'Run';
  const text = s?.stoppedEarly
    ? `${what} stopped early (exit ${run.rc}): see the ${run.awx ? 'job output' : 'terminal'}`
    : `${what} finished (exit ${run.rc}): ${s?.hosts.length ?? 0} host(s), ${failed} failed`;
  const show = run.awx ? 'Open in AWX' : 'Show Terminal';
  const pick = await (failed > 0 || run.rc !== 0
    ? vscode.window.showWarningMessage(text, show)
    : vscode.window.showInformationMessage(text, show));
  if (pick !== show) return;
  if (run.awx) await vscode.env.openExternal(vscode.Uri.parse(run.awx.url));
  else await vscode.commands.executeCommand('workbench.action.terminal.focus');
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

async function diskText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/**
 * On save: tested nodes edited by hand since the file on disk are implemented again (decision 15),
 * and flow.version moves once relative to Git HEAD, or the last saved text (ADR-0006).
 */
async function saveEdits(
  document: vscode.TextDocument,
  lastSaved: string | undefined,
): Promise<vscode.TextEdit[]> {
  const text = document.getText();
  const saved = (await diskText(document.uri)) ?? lastSaved;
  const base = (await headText(document.uri)) ?? lastSaved;
  let plan: ReturnType<typeof planSave>;
  try {
    plan = planSave(text, saved, base);
  } catch {
    return [];
  }
  announceImplementedAgain(parseFlow(text).doc, plan.dropped);
  return plan.edits.map((e) =>
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
