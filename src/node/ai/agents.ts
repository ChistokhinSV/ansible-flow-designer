// The agents Set Up AI Assistants knows (AFD-20) and how to tell they are on this machine: a
// program on PATH, their config folder in the home folder, an installed app or their VS Code
// extension. Agents it does not know get a guide with the skill and a ready MCP config instead.
// No VS Code import, so detection is tested against a temporary home folder.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { type Agent, claudeCommandLine, type Launch, SERVER_NAME, SKILL_NAME } from './writers';

export interface AgentInfo {
  id: Agent;
  label: string;
  /** Where the skill and the tools go, for the pick list. */
  detail: string;
  bins: string[];
  /** Paths under the home folder that only this agent creates. */
  markers: string[];
  /** Installed apps: under %LOCALAPPDATA% on Windows, absolute on macOS. */
  apps: { win?: string; mac?: string };
  /** VS Code extension IDs (lowercase). */
  extensions: string[];
}

export const AGENT_INFO: AgentInfo[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    detail: 'CLI and VS Code extension: skill in .claude/skills, tools via claude mcp',
    bins: ['claude'],
    markers: ['.claude.json'],
    apps: {},
    extensions: ['anthropic.claude-code'],
  },
  {
    id: 'codex',
    label: 'Codex',
    detail:
      'CLI, app and VS Code extension: skill in .agents/skills, tools in ~/.codex/config.toml',
    bins: ['codex'],
    markers: ['.codex'],
    apps: {},
    extensions: ['openai.chatgpt'],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    detail:
      'skill in ~/.gemini/skills (.agents/skills in a repository), tools in ~/.gemini/settings.json',
    bins: ['gemini'],
    markers: ['.gemini'],
    apps: {},
    extensions: ['google.gemini-cli-vscode-ide-companion'],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    detail: 'CLI and app: skill in .agents/skills, tools in ~/.config/opencode/opencode.json(c)',
    bins: ['opencode'],
    markers: ['.config/opencode', '.local/share/opencode'],
    apps: {},
    extensions: ['sst-dev.opencode'],
  },
  {
    id: 'zcode',
    label: 'ZCode',
    detail: 'app: skill in .agents/skills, tools in ~/.agents/mcp.json',
    bins: ['zcode'],
    markers: ['.zcode'],
    apps: { win: 'Programs/ZCode/ZCode.exe', mac: '/Applications/ZCode.app' },
    extensions: [],
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    detail:
      'skill in ~/.copilot/skills (.github/skills in a repository), tools in ~/.copilot/mcp-config.json',
    bins: ['copilot'],
    markers: ['.copilot/config.json', '.copilot/mcp-config.json'],
    apps: {},
    extensions: [],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    detail: 'skill in .claude/skills (Cursor reads it), tools in ~/.cursor/mcp.json',
    bins: ['cursor'],
    markers: ['.cursor'],
    apps: { win: 'Programs/cursor/Cursor.exe', mac: '/Applications/Cursor.app' },
    extensions: [],
  },
  // AFD-173: agents built into VS Code forks; paths from what each agent was seen to read (AFD-172).
  {
    id: 'kiro',
    label: 'Kiro',
    detail: 'skill in ~/.kiro/skills, tools in ~/.kiro/settings/mcp.json',
    bins: ['kiro'],
    markers: ['.kiro'],
    apps: { win: 'Programs/Kiro/Kiro.exe', mac: '/Applications/Kiro.app' },
    extensions: [],
  },
  {
    id: 'antigravity',
    label: 'Antigravity IDE',
    detail: 'skill in ~/.gemini/config/skills, tools in ~/.gemini/config/mcp_config.json',
    bins: ['antigravity-ide'],
    markers: ['.antigravity-ide', '.gemini/antigravity-ide'],
    apps: {
      win: 'Programs/Antigravity IDE/Antigravity IDE.exe',
      mac: '/Applications/Antigravity IDE.app',
    },
    extensions: [],
  },
  {
    id: 'devin',
    label: 'Devin Desktop (Windsurf)',
    detail:
      'skill in ~/.codeium/windsurf/skills, tools in Devin’s mcp_config.json (local agent mode)',
    bins: ['devin-desktop'],
    markers: ['.devin', '.codeium/windsurf'],
    apps: { win: 'Programs/Devin/Devin.exe', mac: '/Applications/Devin.app' },
    extensions: [],
  },
];

export const agentLabel = (id: Agent) => AGENT_INFO.find((a) => a.id === id)?.label ?? id;

export interface Probe {
  home: string;
  /** %LOCALAPPDATA% on Windows. */
  localAppData?: string;
  platform: NodeJS.Platform;
  onPath(name: string): Promise<string | undefined>;
  /** Installed VS Code extension IDs, lowercase. */
  extensions: string[];
}

const exists = (path: string) =>
  fs.stat(path).then(
    () => true,
    () => false,
  );

/** Why an agent counts as installed, or undefined when nothing points to it. */
async function evidence(info: AgentInfo, probe: Probe): Promise<string | undefined> {
  for (const bin of info.bins) if (await probe.onPath(bin)) return `${bin} on PATH`;
  const ext = info.extensions.find((e) => probe.extensions.includes(e));
  if (ext) return `VS Code extension ${ext}`;
  for (const m of info.markers) if (await exists(join(probe.home, m))) return `~/${m}`;
  const app =
    probe.platform === 'win32' && info.apps.win && probe.localAppData
      ? join(probe.localAppData, info.apps.win)
      : probe.platform === 'darwin'
        ? info.apps.mac
        : undefined;
  if (app && (await exists(app))) return `${info.label} app`;
  return undefined;
}

/** The known agents on this machine, each with why it was found. */
export async function findAgents(probe: Probe): Promise<Map<Agent, string>> {
  const found = new Map<Agent, string>();
  const why = await Promise.all(AGENT_INFO.map((info) => evidence(info, probe)));
  AGENT_INFO.forEach((info, i) => {
    const w = why[i];
    if (w) found.set(info.id, w);
  });
  return found;
}

/** The MCP entry most agents take (an "mcpServers" object). */
export function mcpJson(launch: Launch): string {
  const entry = {
    command: launch.command,
    args: launch.args,
    ...(launch.env ? { env: launch.env } : {}),
  };
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2);
}

/** A guide for agents setup does not know: where the skill and the tools go, with this machine's command. */
export function otherAgentGuide(launch: Launch): string {
  const fence = '```';
  return [
    '# Ansible flows in another AI agent',
    '',
    'Ansible Flow Designer gives AI agents two things. Set Up AI Assistants writes both for Claude Code, Codex, Gemini CLI, OpenCode, ZCode, GitHub Copilot CLI, Cursor, Kiro, Antigravity IDE and Devin Desktop (Windsurf); for any other agent, do it once by hand:',
    '',
    `1. **The skill** \`${SKILL_NAME}\`: the rules, the workflow and the format reference. Use _Copy Skill To Folder…_ and pick the folder your agent reads skills from: many read \`.agents/skills\` or \`.claude/skills\` in the repository or in your home folder.`,
    `2. **The flow tools**: an MCP server (stdio) named \`${SERVER_NAME}\`. Most agents take this entry in their MCP config (_Copy MCP Config_):`,
    '',
    `${fence}json`,
    mcpJson(launch),
    fence,
    '',
    '   As a command line:',
    '',
    `${fence}text`,
    `${
      launch.env
        ? `${Object.entries(launch.env)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')} `
        : ''
    }"${launch.command}" ${launch.args.map((a) => `"${a}"`).join(' ')}`,
    fence,
    '',
    '3. Restart the agent and ask it, for example, to "create an Ansible flow that upgrades the firewalls, with checks before and after and a rollback".',
    '',
    'Where some agents keep their MCP config (check the agent’s documentation, these move):',
    '',
    '| Agent | MCP config |',
    '| --- | --- |',
    '| Qwen Code | `~/.qwen/settings.json` (`mcpServers`) |',
    '| Cline, Roo Code | MCP Servers panel, Configure (`mcpServers`) |',
    '| Claude Desktop | `claude_desktop_config.json` (`mcpServers`) |',
    '',
    'The server file lives in VS Code’s storage for this extension and is refreshed with every update; the command stays the same unless VS Code itself moves. Without Node 20+ on PATH the command uses VS Code’s own runtime (`ELECTRON_RUN_AS_NODE=1`).',
    '',
    `Claude Code, for reference: \`${claudeCommandLine(launch)}\``,
    '',
  ].join('\n');
}
