// The test API activate() returns in ExtensionMode.Test (integration and perf suites), out of
// activate (AFD-37). Production code never calls it.
import * as vscode from 'vscode';
import type { ToolResult } from '../core/ai/handlers';
import { type FlowIO, runTool } from '../core/ai/handlers';
import type { CollectionFile } from '../core/catalog/types';
import type { CodeScan, DriftAction } from '../core/drift/types';
import type { FlowCommand } from '../core/flow/commands';
import type { LensFacts, LensId } from '../core/lens/types';
import type { CatalogRequest, CatalogStatus, DomSummary, RunView } from '../core/protocol';
import type { Agent, Item as SetupItem } from '../node/ai/writers';
import type { AiSetup, SetupPicks } from './ai/setup';
import { type ImportOutcome, type ImportRequest, importAwxWorkflow } from './awx/awxImport';
import { type AwxPicks, launchInAwx, setToken, setupTemplate } from './awx/awxRun';
import type { CodegenOutcome } from './codegen';
import type { CommandOutcome, PerfEvent } from './flowSession';
import type { Host } from './host';
import {
  importPlaybooks,
  type PlaybookImportOutcome,
  type PlaybookImportRequest,
} from './import/playbookImport';
import { auditUri } from './run/audit';
import { type RunOptions, runFlow } from './run/runner';
import { type SyntaxOutcome, syntaxCheck } from './run/syntaxCheck';
import { tourReached } from './tour';

/** Exported from activate() in ExtensionMode.Test only (integration and perf suites). */
export interface AfdTestApi {
  run(uri: vscode.Uri, command: FlowCommand): Promise<CommandOutcome>;
  inspect(uri: vscode.Uri): Promise<DomSummary>;
  openLevel(uri: vscode.Uri, level: string): void;
  /** Selects a node on the canvas (opening its level), as a click would. */
  reveal(uri: vscode.Uri, node: string): void;
  setMode(uri: vscode.Uri, mode: 'design' | 'code' | 'run'): void;
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
  ): Promise<{ ok: boolean; error?: string; template?: string; survey?: string }>;
  awxLaunch(uri: vscode.Uri, inputs: Record<string, unknown>): Promise<RunView>;
  /** M8: the lens on the flow's panels, the facts its session gathered, the lens targets. */
  setLens(uri: vscode.Uri, lens: LensId | null): void;
  lensFacts(uri: vscode.Uri): LensFacts;
  setTargets(uri: vscode.Uri, targets: string): Promise<void>;
  /** AFD-16: the empty-file page's Create a flow here. */
  initFlow(uri: vscode.Uri): Promise<CommandOutcome>;
  /** M9: Import AWX Workflow with every pick given (writes the flow, does not open it). */
  importAwx(request: ImportRequest): Promise<ImportOutcome>;
  importPlaybooks(request: PlaybookImportRequest): Promise<PlaybookImportOutcome>;
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

export function createTestApi(host: Host, flowIO: FlowIO, aiSetup: AiSetup): AfdTestApi {
  const get = (uri: vscode.Uri) => {
    const s = host.sessions.get(uri.toString());
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
    diagnostics: (uri) => host.diagnostics.get(uri) ?? [],
    savedCode: (uri) => host.savedCode.get(uri.toString()),
    runFlow: async (uri, options) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      return runFlow(doc, host.runDeps(uri), options);
    },
    auditLog: async () => {
      try {
        const bytes = await vscode.workspace.fs.readFile(auditUri(host.storage));
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
        host.deps.schema,
        host.probes,
        host.codeDiagnostics,
      ),
    useCatalog: (uri, files) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) throw new Error(`no workspace folder for ${uri.toString()}`);
      host.catalog.useFiles(folder, files);
    },
    catalog: (uri, request) => get(uri).answerCatalog(request),
    sync: async (uri) => {
      await get(uri).sync();
      return get(uri).lastScan;
    },
    useScan: (uri, scan) => get(uri).useScan(scan),
    driftAction: (uri, action) => get(uri).driftAction(action),
    awxToken: (uri, token) => setToken(uri, host.context.secrets, token),
    awxSetup: async (uri, picks) =>
      setupTemplate(await vscode.workspace.openTextDocument(uri), host.awxDeps(uri), picks),
    awxLaunch: async (uri, inputs) =>
      launchInAwx(await vscode.workspace.openTextDocument(uri), host.awxDeps(uri), {
        inputs,
        yes: true,
      }),
    // Tests import as is unless they ask for the AI mode.
    importAwx: (request) =>
      importAwxWorkflow(host.context.secrets, host.deps.newId, { mode: 'as-is', ...request }),
    importPlaybooks: (request) => importPlaybooks(host.playbookDeps, { mode: 'as-is', ...request }),
    initFlow: (uri) => get(uri).initFlow(),
    catalogStatus: (uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      return folder ? host.catalog.status(folder) : undefined;
    },
  };
}
