// Editor APIs newer than the engine floor (AFD-171). The extension declares VS Code 1.94 so that
// VS Code forks install it (Cursor, Windsurf / Devin Desktop, Antigravity IDE, Kiro); an API added
// later is looked up where it is used, never assumed, and its absence turns that feature off.
// The types are the parts we use, copied from @types/vscode 1.140. Only types come from 'vscode'
// here: callers pass the module in, so unit tests can pass a fake.
import type * as vscode from 'vscode';

export interface ToolConfirmationMessages {
  title: string;
  message: string | vscode.MarkdownString;
}

export interface PreparedToolInvocation {
  invocationMessage?: string | vscode.MarkdownString;
  confirmationMessages?: ToolConfirmationMessages;
}

export interface ToolPrepareOptions<T> {
  input: T;
}

export interface ToolInvocationOptions<T> {
  input: T;
  toolInvocationToken: unknown;
}

/** VS Code's LanguageModelTool (1.95). */
export interface LanguageModelTool<T> {
  invoke(
    options: ToolInvocationOptions<T>,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<unknown>;
  prepareInvocation?(
    options: ToolPrepareOptions<T>,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<PreparedToolInvocation>;
}

export interface ToolInformation {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object | undefined;
  readonly tags: readonly string[];
}

/** Language-model tools: registered for Copilot's agent and listed for diagnostics. */
export interface LmTools {
  registerTool<T>(name: string, tool: LanguageModelTool<T>): vscode.Disposable;
  readonly tools: readonly ToolInformation[];
  /** A tool result of one text part (LanguageModelToolResult of a LanguageModelTextPart). */
  textResult(text: string): unknown;
}

interface LmModule {
  lm?: {
    registerTool?: <T>(name: string, tool: LanguageModelTool<T>) => vscode.Disposable;
    tools?: readonly ToolInformation[];
  };
  LanguageModelToolResult?: new (content: unknown[]) => unknown;
  LanguageModelTextPart?: new (value: string) => unknown;
}

/**
 * The language-model tools API, or undefined where the editor has none: VS Code before 1.95, and
 * forks whose own agent does not read it (Cursor stubs the namespace).
 */
export function lmTools(api: unknown): LmTools | undefined {
  const m = api as LmModule;
  const lm = m.lm;
  const Result = m.LanguageModelToolResult;
  const Text = m.LanguageModelTextPart;
  if (!lm || typeof lm.registerTool !== 'function' || !Result || !Text) return undefined;
  const register = lm.registerTool.bind(lm);
  return {
    registerTool: (name, tool) => register(name, tool),
    get tools() {
      return lm.tools ?? [];
    },
    textResult: (text) => new Result([new Text(text)]),
  };
}

/** Cursor's MCP server definition (stdio). */
export interface CursorStdioServer {
  name: string;
  server: { command: string; args: string[]; env?: Record<string, string> };
}

/** Cursor's own extension API (`vscode.cursor`), the parts AFD-170 probes. */
export interface CursorApi {
  mcp?: {
    registerServer?(server: CursorStdioServer): unknown;
    unregisterServer?(name: string): unknown;
  };
  plugins?: { registerPath?(path: string): unknown };
}

/** `vscode.cursor` in Cursor, undefined elsewhere. */
export function cursorApi(api: unknown): CursorApi | undefined {
  const c = (api as { cursor?: unknown }).cursor;
  return c && typeof c === 'object' ? (c as CursorApi) : undefined;
}

/** Whether the editor has VS Code's MCP server definition provider API (1.101). */
export function hasMcpProviderApi(api: unknown): boolean {
  const lm = (api as { lm?: { registerMcpServerDefinitionProvider?: unknown } }).lm;
  return typeof lm?.registerMcpServerDefinitionProvider === 'function';
}

/** VS Code's own API namespaces; any other lower-case object on the module is an editor's addition. */
export const KNOWN_NAMESPACES = new Set([
  'authentication',
  'chat',
  'comments',
  'commands',
  'debug',
  'env',
  'extensions',
  'l10n',
  'languages',
  'lm',
  'notebooks',
  'scm',
  'tasks',
  'tests',
  'window',
  'workspace',
]);

/** Lower-case objects on the vscode module that VS Code itself does not have (`cursor`, …). */
export function extraNamespaces(api: unknown): string[] {
  return Object.keys(api as object)
    .filter((k) => /^[a-z]/.test(k) && k !== 'default' && !KNOWN_NAMESPACES.has(k))
    .filter((k) => {
      const v = (api as Record<string, unknown>)[k];
      return !!v && typeof v === 'object';
    })
    .sort();
}

/** The member names of an object, two levels deep (`mcp.registerServer`), for the diagnostics. */
export function membersOf(value: unknown, depth = 2): string[] {
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const k of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[k];
    const inner = depth > 1 && v && typeof v === 'object' ? membersOf(v, depth - 1) : [];
    if (inner.length) out.push(...inner.map((m) => `${k}.${m}`));
    else out.push(typeof v === 'function' ? `${k}()` : k);
  }
  return out;
}

/**
 * Antigravity IDE's extension API for its agent's MCP servers (found by AFD-172 diagnostics):
 * `writeMcpConfig(name, json)` writes ~/.gemini/<ide>/plugins/<extension id>.<name>/mcp_config.json,
 * `getMcpConfig(name)` reads it back, `refreshMcpServers()` makes the agent load the change.
 */
export interface AntigravityApi {
  getMcpConfig?(name: string): Promise<string | undefined>;
  writeMcpConfig?(name: string, content: string): Promise<void>;
  refreshMcpServers?(): Promise<void>;
}

export function antigravityApi(api: unknown): AntigravityApi | undefined {
  const a = (api as { antigravityExtensibility?: unknown }).antigravityExtensibility;
  return a && typeof a === 'object' ? (a as AntigravityApi) : undefined;
}
