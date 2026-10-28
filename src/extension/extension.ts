import * as vscode from 'vscode';
import type { FlowCommand } from '../core/flow/commands';
import { parseFlow } from '../core/flow/document';
import { createIdFactory, slugify } from '../core/flow/ids';
import { createSchemaValidator } from '../core/flow/schema';
import { versionBump } from '../core/flow/semantic';
import { newFlowText } from '../core/flow/template';
import type { DomSummary } from '../core/protocol';
import { setIn } from '../core/yaml/ops';
import { type CommandOutcome, FlowSession, type PerfEvent, type SessionDeps } from './flowSession';
import { headText } from './gitHead';

export const VIEW_TYPE = 'afd.flowEditor';

const isFlow = (doc: vscode.TextDocument) => doc.uri.path.endsWith('.flow.yaml');

/** Exported from activate() in ExtensionMode.Test only (integration and perf suites). */
export interface AfdTestApi {
  run(uri: vscode.Uri, command: FlowCommand): Promise<CommandOutcome>;
  inspect(uri: vscode.Uri): Promise<DomSummary>;
  rendered(uri: vscode.Uri, version: number): Promise<void>;
  perf(uri: vscode.Uri): PerfEvent[];
  cspViolations(uri: vscode.Uri): string[];
  diagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[];
}

export function activate(context: vscode.ExtensionContext): AfdTestApi | undefined {
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  const diagnostics = vscode.languages.createDiagnosticCollection('ansible-flow');
  const deps: SessionDeps = {
    extensionUri: context.extensionUri,
    diagnostics,
    schema: createSchemaValidator(),
    newId: createIdFactory(),
    testMode,
  };
  const sessions = new Map<string, FlowSession>();
  const lastSaved = new Map<string, string>();

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
      if (isFlow(doc)) lastSaved.set(doc.uri.toString(), doc.getText());
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
    rendered: (uri, version) => get(uri).rendered(version),
    perf: (uri) => get(uri).perf,
    cspViolations: (uri) => get(uri).cspViolations,
    diagnostics: (uri) => diagnostics.get(uri) ?? [],
  };
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
