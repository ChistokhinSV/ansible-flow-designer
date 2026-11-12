// Activation composes the extension (AFD-37): the shared services (Host), the flow documents'
// lifecycle, the designer, and each area's commands. Commands live in their area's module.
import * as vscode from 'vscode';
import { parseFlow } from '../core/flow/document';
import { KEEP_RUNS, sweepRuns } from '../node/run/storage';
import { hostSummary, showAiDiagnostics } from './ai/diagnostics';
import { HostIntegration } from './ai/hostIntegration';
import { hostFlowIO, registerFlowTools } from './ai/lmTools';
import { AiSetup } from './ai/setup';
import { registerFlowCommands } from './commands/flowCommands';
import { CMD } from './commands/ids';
import { registerImportCommands } from './commands/importCommands';
import { registerRunCommands } from './commands/runCommands';
import { registerDocuments } from './documents';
import { registerExport } from './export';
import { Feedback, registerFeedback } from './feedback';
import { registerFlowsView } from './flowsView';
import { registerHelp } from './help';
import { Host, isFlow, VIEW_TYPE } from './host';
import { registerInventoryView } from './inventoryView';
import { logChannel } from './log';
import { registerOutline } from './outline';
import { ScenarioLive } from './run/scenarioLive';
import { ScenarioTests } from './run/testController';
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
  context.subscriptions.push(...registerFlowTools(flowIO, (line) => logChannel().warn(line)));
  // AFD-22: the user guide, the walkthroughs and the sample flows.
  context.subscriptions.push(...registerHelp(context, (uri) => host.openDesigner(uri)));
  // AFD-201: feedback without telemetry; the uninstall page's marker follows its answers.
  // Tests see the links the feedback commands open; no browser opens.
  const feedbackLinks: string[] = [];
  const feedback = new Feedback(
    context,
    host.testMode
      ? {
          open: async (url) => {
            feedbackLinks.push(url);
          },
        }
      : {},
  );
  context.subscriptions.push(...registerFeedback(feedback));
  void feedback.syncMarker();
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
  // AFD-174: the agent built into this editor (Cursor, Kiro, Antigravity IDE, Devin Desktop).
  const hostAi = new HostIntegration(context, () => aiSetup.skillFiles());
  context.subscriptions.push(hostAi);
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.setupAi, () => aiSetup.setup()),
    vscode.commands.registerCommand(CMD.removeAi, async () => {
      const removed = await aiSetup.remove();
      if (removed) await hostAi.removed();
    }),
    vscode.commands.registerCommand(CMD.diagnoseAi, () => showAiDiagnostics(context)),
  );
  // AFD-172: which editor this is and what its agent side offers, one line for the log.
  logChannel().info(hostSummary());
  // AFD-20: the extension also starts after VS Code does (onStartupFinished) and checks a setup
  // from an older version. AFD-73: agents without it are offered it once a designer shows a flow
  // with a step, not before anyone has seen a flow.
  const staleAsked: Promise<boolean> = host.testMode
    ? aiSetup.refreshContext().then(
        () => true,
        () => true,
      )
    : aiSetup.checkStale().catch(() => true);
  if (!host.testMode) void hostAi.start().catch(() => undefined);
  let offerPending = !host.testMode;
  const offerOnce = (document: vscode.TextDocument) => {
    if (!offerPending || !hasSteps(document.getText())) return;
    offerPending = false;
    // This editor's own agent first; the general offer leaves it out and waits if that asked.
    // AFD-201: the feedback notice last, only when nothing else asked at this start.
    void (async () => {
      if (await hostAi.offer()) return;
      if (await aiSetup.offer(hostAi.agent)) return;
      if (await staleAsked) return;
      await feedback.maybeAsk();
    })().catch(() => undefined);
  };
  // The schema compiles on first use; where flows exist, do it now, before the first one opens.
  // AFD-155: from the index's own list, so start-up walks the workspace once, without
  // node_modules and .git (a string exclude here replaced files.exclude).
  void host.index.list().then(
    (found) => found.length > 0 && setTimeout(() => host.deps.schema({}), 0),
    () => undefined,
  );

  host.scenarioLive = new ScenarioLive(host);
  // AFD-118: scenarios in the Testing view.
  host.scenarioTests = new ScenarioTests(host);
  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, panel) {
      host.sessionFor(document).attach(panel);
      // AFD-201: a day of real use is a day the designer showed a flow with steps.
      if (hasSteps(document.getText())) void feedback.noteUse().catch(() => undefined);
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
      // Unplaced nodes follow the layout direction at once (AFD-42). AFD-164: recheck builds the
      // snapshot again; refresh answered with the one cached for the unchanged document version.
      if (e.affectsConfiguration('afd.canvas.direction'))
        for (const s of host.sessions.values()) void s.recheck();
    }),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
      // AFD-157: a hidden designer keeps its level, mode, lens, selection and an unsaved
      // binding draft. Without this the webview reloads on every tab switch and loses them
      // without asking; the cost is the hidden webview's memory, one per open designer.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    ...registerDocuments(host),
    ...registerOutline(host),
    ...registerFlowCommands(host),
    ...registerRunCommands(host),
    host.scenarioLive,
    host.scenarioTests,
    watchSharedSources(host),
    ...registerImportCommands(host),
    ...host.index.start(),
    // AFD-93: the flow panel's line about the workspace follows the index.
    host.index.onDidChange(async () => {
      const state = await host.index.state();
      for (const s of host.sessions.values()) s.repoState(state);
    }),
    ...registerFlowsView(host),
    ...registerInventoryView(host),
  );
  for (const doc of vscode.workspace.textDocuments)
    if (isFlow(doc)) void host.sessionFor(doc).refresh();

  return host.testMode
    ? createTestApi(host, flowIO, aiSetup, context, { feedback, links: feedbackLinks })
    : undefined;
}

export function deactivate(): void {}
