// AI integration diagnostics (AFD-172, epic AFD-170): what this editor is, which APIs its agent
// side offers, how the MCP server would start, and how each fork's agent is configured on this
// machine. A Markdown report for the developer's notes and the tickets; read-only.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { COPILOT_PREFIX } from '../../core/ai/contributions';
import {
  agentRegistrations,
  configLines,
  hostConfigs,
  registrationLines,
} from '../../node/ai/hostConfig';
import { detectHost, HOSTS } from '../../node/ai/hosts';
import { sqliteAvailable } from '../../node/catalog/catalogIndex';
import { cursorApi, extraNamespaces, hasMcpProviderApi, lmTools, membersOf } from '../compat';
import { logChannel } from '../log';
import { onPath, serverPath } from './launcher';

/** The editor's own agent: command prefixes (`cursor.`, not `cursorMove`) and extension IDs. */
const AGENT_PREFIX =
  /^(cursor|anysphere|composer|aichat|kiro|kiroAgent|antigravity|jetski|devin|windsurf|codeium|cascade|copilot|github\.copilot|gemini|google|agent|agents|mcp)$/i;
const AGENT_WORDS = /mcp|skill|plugin|steering|powers?\b/i;
const AGENT_EXTENSION =
  /agent|cursor|anysphere|kiro|antigravity|google|devin|windsurf|codeium|copilot|gemini|claude|\bmcp|amazon|aws/i;

function agentCommand(id: string): boolean {
  const prefix = id.split('.')[0] ?? id;
  return (
    AGENT_PREFIX.test(prefix) || (id.includes('.') && AGENT_WORDS.test(id.slice(prefix.length)))
  );
}

function run(
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) =>
    execFile(file, args, { timeout: 10_000, windowsHide: true, env }, (err, out, errOut) =>
      done({ ok: !err, out: (err ? errOut || err.message : out).toString().trim().slice(0, 200) }),
    ),
  );
}

/** Reads a property that a fork may guard with a throwing getter. */
function safe<T>(read: () => T): T | string {
  try {
    return read();
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

/** The one-line summary logged at activation. */
export function hostSummary(): string {
  const host = detectHost(vscode.env);
  const cursor = safe(() => cursorApi(vscode));
  return [
    `AI host: ${host} (${vscode.env.appName}, VS Code API ${vscode.version}, Node ${process.versions.node})`,
    `lm tools: ${lmTools(vscode) ? 'yes' : 'no'}`,
    `MCP provider API: ${hasMcpProviderApi(vscode) ? 'yes' : 'no'}`,
    `vscode.cursor: ${typeof cursor === 'object' && cursor ? Object.keys(cursor).sort().join(', ') || 'empty' : 'no'}`,
  ].join('; ');
}

export async function aiDiagnostics(context: vscode.ExtensionContext): Promise<string> {
  const host = detectHost(vscode.env);
  const info = HOSTS[host];
  const lm = lmTools(vscode);
  const ours = lm ? lm.tools.filter((t) => t.name.startsWith(COPILOT_PREFIX)).length : 0;
  const cursor = safe(() => cursorApi(vscode));
  const node = await onPath('node');
  const nodeVersion = node ? await run(node, ['--version']) : undefined;
  const asNode = await run(
    process.execPath,
    ['-e', 'process.stdout.write(process.versions.node)'],
    {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  );
  const commands = (await vscode.commands.getCommands(true)).filter(agentCommand);
  const byPrefix = new Map<string, string[]>();
  for (const c of commands) {
    const prefix = c.split('.')[0] ?? c;
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), c]);
  }
  const extensions = vscode.extensions.all
    .filter((e) => AGENT_EXTENSION.test(e.id))
    .map(
      (e) =>
        `${e.id} ${(e.packageJSON as { version?: string }).version ?? ''}${e.isActive ? ' (active)' : ''}`,
    )
    .sort();
  const setup = context.globalState.get<{ agents?: string[]; scope?: string; version?: string }>(
    'afd.ai.setup',
  );
  const files = {
    home: homedir(),
    platform: process.platform,
    xdgConfig: process.env.XDG_CONFIG_HOME,
  };
  const configs = await hostConfigs(files);
  // AFD-195: what each agent's entry starts, against this extension's copy.
  const server = serverPath(context);
  const registered = await agentRegistrations(files);
  const ext = (context.extension.packageJSON as { version: string }).version;
  const lines = [
    `# AI integration diagnostics: ${vscode.env.appName}`,
    '',
    `Ansible Flow Designer ${ext}, ${new Date().toISOString()}`,
    '',
    '## Editor',
    '',
    `- Detected: **${host}** (${info.label}; agent: ${info.agent})`,
    `- appName: ${vscode.env.appName}; appHost: ${vscode.env.appHost}; uriScheme: ${vscode.env.uriScheme}; remote: ${vscode.env.remoteName ?? 'none'}`,
    `- VS Code API: ${vscode.version}; Node ${process.versions.node}; Electron ${process.versions.electron ?? 'none'}; ${process.platform} ${process.arch}`,
    `- execPath: \`${process.execPath}\``,
    '',
    '## How the MCP server would start',
    '',
    `- node on PATH: ${node ? `\`${node}\` ${nodeVersion?.out ?? ''}` : 'none'}`,
    `- The editor's runtime as Node (ELECTRON_RUN_AS_NODE): ${asNode.ok ? `works, Node ${asNode.out}` : `fails (${asNode.out})`}`,
    `- node:sqlite (module catalog): ${sqliteAvailable() ? 'yes' : 'no'}`,
    '',
    '## APIs',
    '',
    `- lm.registerTool: ${lm ? `yes; ${lm.tools.length} tools listed, ${ours} of ours` : 'no'}`,
    `- lm.registerMcpServerDefinitionProvider: ${hasMcpProviderApi(vscode) ? 'yes' : 'no'}`,
    `- vscode.cursor: ${typeof cursor === 'string' ? cursor : cursor ? membersOf(cursor).join(', ') || 'empty' : 'no'}`,
    `- Other namespaces on the vscode module: ${safe(() => extraNamespaces(vscode).join(', ')) || 'none'}`,
    // An editor's own namespace may be its agent's extension API (antigravityExtensibility, …).
    ...(() => {
      const extra = safe(() => extraNamespaces(vscode));
      return typeof extra === 'string'
        ? []
        : extra.map((ns) => {
            const members = safe(() =>
              membersOf((vscode as unknown as Record<string, unknown>)[ns]),
            );
            return `  - \`${ns}\`: ${typeof members === 'string' ? members : members.slice(0, 40).join(', ') || 'empty'}`;
          });
    })(),
    '',
    `## Agent commands (${commands.length})`,
    '',
    ...[...byPrefix.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 25)
      .map(
        ([p, cs]) =>
          `- \`${p}\` (${cs.length}): ${cs.slice(0, 8).join(', ')}${cs.length > 8 ? ', …' : ''}`,
      ),
    '',
    `## Agent extensions (${extensions.length})`,
    '',
    ...extensions.map((e) => `- ${e}`),
    '',
    '## Agent configuration on this machine',
    '',
    ...configs.flatMap((c) => configLines(c, server)),
    '## Flow tools registered for agents',
    '',
    `- This extension's server: \`${server}\` (${existsSync(server) ? 'there' : '**missing**'})`,
    ...registrationLines(registered, server),
    '',
    '## Set Up AI Assistants',
    '',
    setup
      ? `- ${setup.agents?.join(', ') || 'no agents'} (${setup.scope ?? '?'}), version ${setup.version ?? '?'}`
      : '- Not run',
    '',
  ];
  return lines.join('\n');
}

/** Ansible Flow: Show AI Integration Diagnostics. */
export async function showAiDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const report = await aiDiagnostics(context);
  logChannel().info(`AI diagnostics\n${report}`);
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: report });
  await vscode.window.showTextDocument(doc, { preview: false });
}
