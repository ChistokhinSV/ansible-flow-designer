// The editor the extension runs in (AFD-172, epic AFD-170): VS Code, or a fork whose built-in
// agent reads its own MCP and skill configuration. One table of where each agent looks, so the
// diagnostics and the integration (AFD-173/174) share the paths. Checked against
// each editor's own code or bundled docs on 2026-11-08 (Cursor 3.29 on VS Code 1.128, Antigravity
// IDE 1.107, Devin Desktop 3.12 on 1.141, Kiro 1.4 on 1.131). No VS Code import.
import { join } from 'node:path';

export type HostId = 'vscode' | 'cursor' | 'antigravity' | 'windsurf' | 'kiro' | 'other';

export interface HostEnv {
  home: string;
  platform: NodeJS.Platform;
  /** XDG_CONFIG_HOME, which Devin honours outside Windows. */
  xdgConfig?: string;
}

export interface HostInfo {
  id: HostId;
  /** The editor, as people call it. */
  label: string;
  /** Its built-in agent. */
  agent: string;
  /** User-level MCP files the agent reads; the first is where an entry goes. */
  mcp(env: HostEnv): string[];
  /** User-level skill folders the agent reads (each holds one folder per skill). */
  skills(env: HostEnv): string[];
  /** Where plugin bundles go (plugin.json, MCP file, skills/), if the agent loads them. */
  plugins?(env: HostEnv): string;
  /** What is known and what is still to be probed. */
  note: string;
}

const h = (env: HostEnv, ...parts: string[]) => join(env.home, ...parts);

export const HOSTS: Record<HostId, HostInfo> = {
  vscode: {
    id: 'vscode',
    label: 'VS Code',
    agent: 'Copilot',
    mcp: () => [],
    skills: () => [],
    note: 'Copilot gets the tools (lm.registerTool) and the skill (chatSkills) from the extension itself.',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    agent: 'Cursor Agent',
    mcp: (env) => [h(env, '.cursor', 'mcp.json')],
    skills: (env) => [
      h(env, '.cursor', 'skills'),
      h(env, '.agents', 'skills'),
      h(env, '.claude', 'skills'),
    ],
    note: 'Reads ~/.cursor/mcp.json (sends no roots: the server starts in the home folder) and all three skill folders. vscode.cursor.mcp.registerServer works: shown as extension-<name>, 11 tools, node or the editor runtime. No plugins.registerPath in 3.29. Cursor 3 may open its agent window (Glass), where extensions may not run.',
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity IDE',
    agent: 'Antigravity agent',
    mcp: (env) => [h(env, '.gemini', 'config', 'mcp_config.json')],
    // Its global customization root is ~/.gemini/config (skills/, plugins/); ~/.gemini/skills is
    // Gemini CLI's and not read by Antigravity IDE (AFD-172 probe).
    skills: (env) => [h(env, '.gemini', 'config', 'skills')],
    plugins: (env) => h(env, '.gemini', 'config', 'plugins'),
    note: 'Reads ~/.gemini/config/mcp_config.json (no roots; cwd is the workspace) and ~/.gemini/config/skills; refreshMcpServers() (vscode.antigravityExtensibility) reloads servers live. Bundles in ~/.gemini/config/plugins load their skills but not their MCP servers; writeMcpConfig folders are not loaded.',
  },
  windsurf: {
    id: 'windsurf',
    label: 'Devin Desktop (Windsurf)',
    agent: 'Devin',
    // Devin's own code: %USERPROFILE%\AppData\Roaming\devin on Windows, else $XDG_CONFIG_HOME/devin
    // or ~/.config/devin. It still reads Windsurf's ~/.codeium/windsurf too (both probed, AFD-172).
    mcp: (env) => [
      env.platform === 'win32'
        ? h(env, 'AppData', 'Roaming', 'devin', 'mcp_config.json')
        : join(env.xdgConfig || h(env, '.config'), 'devin', 'mcp_config.json'),
      h(env, '.codeium', 'windsurf', 'mcp_config.json'),
    ],
    // ~/.devin/skills is not read (AFD-172 probe).
    skills: (env) => [h(env, '.codeium', 'windsurf', 'skills'), h(env, '.agents', 'skills')],
    note: "No extension API. Its local agent (the cloud/local switch on local) reads both MCP files (no roots; cwd is the workspace; asks before tool calls) and also runs servers from Claude Code's and Cursor's configs (config importers in devin.exe). Skills from ~/.codeium/windsurf/skills and ~/.agents/skills.",
  },
  kiro: {
    id: 'kiro',
    label: 'Kiro',
    agent: 'Kiro agent',
    mcp: (env) => [h(env, '.kiro', 'settings', 'mcp.json')],
    skills: (env) => [h(env, '.kiro', 'skills')],
    plugins: (env) => h(env, '.kiro', 'powers', 'installed'),
    note: 'No extension API. Reads ~/.kiro/settings/mcp.json (no roots; cwd is the workspace; asks before each tool call) and ~/.kiro/skills. A bundle in ~/.kiro/powers/installed is not loaded.',
  },
  other: {
    id: 'other',
    label: 'an editor built on VS Code',
    agent: 'its agent',
    mcp: () => [],
    skills: () => [],
    note: 'Unknown editor: Set Up AI Assistants and Other agent… cover it.',
  },
};

/** Which editor this is, from vscode.env.appName and uriScheme (the scheme is the surer of the two). */
export function detectHost(app: { appName: string; uriScheme: string }): HostId {
  const scheme = app.uriScheme.toLowerCase();
  const name = app.appName.toLowerCase();
  const is = (...words: string[]) => words.some((w) => scheme.startsWith(w) || name.includes(w));
  if (is('cursor')) return 'cursor';
  if (is('antigravity')) return 'antigravity';
  if (is('devin', 'windsurf')) return 'windsurf';
  if (is('kiro')) return 'kiro';
  if (
    scheme.startsWith('vscode') ||
    name.includes('visual studio code') ||
    name.includes('vscodium') ||
    name.includes('code - oss')
  )
    return 'vscode';
  return 'other';
}
