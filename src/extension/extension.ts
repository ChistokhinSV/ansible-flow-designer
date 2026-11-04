// Activation composes the extension (AFD-37): the shared services (Host), the flow documents'
// lifecycle, the designer, and each area's commands. Commands live in their area's module.
import * as vscode from 'vscode';
import { parseFlow } from '../core/flow/document';
import { KEEP_RUNS, sweepRuns } from '../node/run/storage';
import { hostFlowIO, registerFlowTools } from './ai/lmTools';
import { AiSetup } from './ai/setup';
import { registerFlowCommands } from './commands/flowCommands';
import { CMD } from './commands/ids';
import { registerImportCommands } from './commands/importCommands';
import { registerRunCommands } from './commands/runCommands';
import { registerDocuments } from './documents';
import { registerExport } from './export';
import { registerFlowsView } from './flowsView';
import { registerHelp } from './help';
import { Host, isFlow, VIEW_TYPE } from './host';
import { registerInventoryView } from './inventoryView';
import { watchScenarioFiles } from './run/scenarios';
import { watchSharedSources } from './sharedSubflows';
import { type AfdTestApi, createTestApi } from './testApi';
import { initTour } from './tour';

export { VIEW_TYPE } from './host';
export type { AfdTestApi } from './testApi';

/** A flow with a step of its own (more than Start and its ends), from its text (AFD-73). */
function hasSteps(text: string): boolean {
  const nodes = parseFlow(text).doc?.nodes ?? [];
  return nodes.some((n) => n?.type !== 'start' && n?.type !== 'end');
}

export function activate(context: vscode.ExtensionContext): AfdTestApi | undefined {
  const host = new Host(context);
  // AFD-73: first-flow progress for the walkthrough and the designer's checklist.
  initTour(context.globalState);
  // No run is going yet: drop what earlier runs left behind (AFD-29), in the background.
  void sweepRuns(
    host.storage.fsPath,
    vscode.workspace.getConfiguration('afd').get<number>('runs.keep', KEEP_RUNS),
  ).catch(() => undefined);

  // AFD-19: Copilot's flow tools see the workspace's flows; edits are one undo step each.
  const flowIO = hostFlowIO({
    schema: host.deps.schema,
    newId: host.deps.newId,
    activeFlow: () => host.targetUri(),
    open: (uri) => host.openDesigner(uri),
    resolveModule: host.playbookDeps.resolveModule,
  });
  context.subscriptions.push(...registerFlowTools(flowIO));
  // AFD-22: the user guide, the walkthroughs and the sample flows.
  context.subscriptions.push(...registerHelp(context, (uri) => host.openDesigner(uri)));
  // AFD-25: draw.io and image exports of the flow the user means.
  context.subscriptions.push(
    ...registerExport({
      session: async (uri) => {
        const target = host.targetUri(uri);
        return target
          ? host.sessionFor(await vscode.workspace.openTextDocument(target))
          : undefined;
      },
      designer: async (uri) => {
        const session = host.sessionFor(await vscode.workspace.openTextDocument(uri));
        if (!session.hasPanels) await host.openDesigner(uri);
        await session.whenReady();
        return session;
      },
      agent: `Ansible Flow Designer ${context.extension.packageJSON.version as string}`,
    }),
  );
  const aiSetup = new AiSetup(context);
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.setupAi, () => aiSetup.setup()),
    vscode.commands.registerCommand(CMD.removeAi, () => aiSetup.remove()),
  );
  // AFD-20: the extension also starts after VS Code does (onStartupFinished) and checks a setup
  // from an older version. AFD-73: agents without it are offered it once a designer shows a flow
  // with a step, not before anyone has seen a flow.
  void (host.testMode ? aiSetup.refreshContext() : aiSetup.checkStale()).catch(() => undefined);
  let offerPending = !host.testMode;
  const offerOnce = (document: vscode.TextDocument) => {
    if (!offerPending || !hasSteps(document.getText())) return;
    offerPending = false;
    void aiSetup.offer().catch(() => undefined);
  };
  // The schema compiles on first use; where flows exist, do it now, before the first one opens.
  void vscode.workspace.findFiles('**/*.flow.yaml', '**/node_modules/**', 1).then(
    (found) => found.length > 0 && setTimeout(() => host.deps.schema({}), 0),
    () => undefined,
  );

  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, panel) {
      host.sessionFor(document).attach(panel);
      offerOnce(document);
    },
  };
  context.subscriptions.push(
    host.catalog.onStatus(({ folder, status }) => {
      for (const s of host.sessions.values()) s.catalogStatus(folder, status);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('afd.environment') || e.affectsConfiguration('ansible')) {
        host.probes.dispose();
        // The loaded catalog describes the old environment (AFD-32).
        host.catalog.environmentChanged();
      }
      // Unplaced nodes follow the layout direction at once (AFD-42).
      if (e.affectsConfiguration('afd.canvas.direction'))
        for (const s of host.sessions.values()) void s.refresh();
    }),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
    }),
    ...registerDocuments(host),
    ...registerFlowCommands(host),
    ...registerRunCommands(host),
    watchScenarioFiles(),
    watchSharedSources(host),
    ...registerImportCommands(host),
    ...registerFlowsView(),
    ...registerInventoryView(host),
  );
  for (const doc of vscode.workspace.textDocuments)
    if (isFlow(doc)) void host.sessionFor(doc).refresh();

  return host.testMode ? createTestApi(host, flowIO, aiSetup) : undefined;
}

export function deactivate(): void {}
