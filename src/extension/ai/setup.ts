// Set Up AI Assistants / Remove AI Assistant Setup (AFD-19, AFD-20). Copilot needs nothing: the
// skill, instructions and tools are contributed by the extension. Other agents (Claude Code, Codex,
// Gemini CLI, OpenCode, ZCode, Copilot CLI, Cursor) get a copy of the skill (this repository or the
// user's home) and the MCP server registered for the user. After VS Code starts, agents found
// without the setup are offered it once, in one click; any other agent gets a guide.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { AGENT_INFO, agentLabel, findAgents, mcpJson, otherAgentGuide } from '../../node/ai/agents';
import {
  AGENTS,
  type Agent,
  applySetup,
  claudeCommandLine,
  claudeRunner,
  type Env,
  type Item,
  type Launch,
  planSetup,
  removeSetup,
  type Scope,
  SKILL_NAME,
  type SkillFiles,
  skillDirs,
  skillState,
  writeSkill,
} from '../../node/ai/writers';
import { logChannel } from '../log';
import { installServer, launchFor, onPath, programsOnPath } from './launcher';

const STATE = 'afd.ai.setup';
/** Agents already offered the setup (asked again only for new ones). */
const OFFERED = 'afd.ai.offered';
const NEVER = 'afd.ai.neverOffer';

interface SetupRecord {
  version: string;
  agents: Agent[];
  scope: Scope;
  repo?: string;
  runtime: string;
  /** The version the user said Not now to. */
  dismissed?: string;
}

export interface SetupPicks {
  agents: Agent[];
  scope: Scope;
  /** Tests: a temporary home and repository instead of the real ones. */
  home?: string;
  repo?: string;
}

const list = (names: string[]) =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export class AiSetup {
  /** The extension's one log (AFD-37); the setup's lines start with "AI setup". */
  private readonly log = logChannel();

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get version(): string {
    return (this.context.extension.packageJSON as { version: string }).version;
  }

  private get record(): SetupRecord | undefined {
    return this.context.globalState.get<SetupRecord>(STATE);
  }

  private async env(home = homedir(), repo?: string): Promise<Env> {
    const claude = await onPath('claude');
    return { home, ...(repo ? { repo } : {}), ...(claude ? { claude: claudeRunner(claude) } : {}) };
  }

  /** The known agents installed here, with why each was found. */
  async found(home = homedir()): Promise<Map<Agent, string>> {
    const programs = await programsOnPath(AGENT_INFO.flatMap((a) => a.bins));
    return findAgents({
      home,
      ...(process.env.LOCALAPPDATA ? { localAppData: process.env.LOCALAPPDATA } : {}),
      platform: process.platform,
      onPath: async (name) => programs.get(name),
      extensions: vscode.extensions.all.map((e) => e.id.toLowerCase()),
    });
  }

  /** The skill as the extension ships it: skills/ansible-flow/**. */
  async skillFiles(): Promise<SkillFiles> {
    const root = join(this.context.extensionUri.fsPath, 'skills', SKILL_NAME);
    const files: SkillFiles['files'] = {};
    const walk = async (dir: string) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) await walk(path);
        else files[relative(root, path).split(sep).join('/')] = await fs.readFile(path, 'utf8');
      }
    };
    await walk(root);
    return { version: this.version, files };
  }

  private async launch(): Promise<Launch> {
    return launchFor(await installServer(this.context));
  }

  private show(path: string, home: string): string {
    return path.startsWith(home) ? `~${path.slice(home.length).split(sep).join('/')}` : path;
  }

  private describe(items: Item[], home: string): string[] {
    const verb = {
      create: 'Create',
      update: 'Update',
      unchanged: 'Unchanged',
      skip: 'Skip',
      remove: 'Remove',
    };
    return items.map((i) => {
      const what = i.what === 'skill' ? 'skill' : 'tools (MCP)';
      const target =
        i.agent === 'claude' && i.what === 'mcp'
          ? 'claude mcp add -s user ansible-flow'
          : this.show(i.target, home);
      return `${verb[i.action]}: ${agentLabel(i.agent)} ${what}, ${target}${i.note ? ` (${i.note})` : ''}`;
    });
  }

  /**
   * Asks which agents and where, previews, writes. Picks skip the questions (tests, updates, the
   * one-click offer); confirm shows the preview first, announce the result after.
   */
  async setup(picks?: SetupPicks, confirm = true, announce = confirm): Promise<Item[] | undefined> {
    const chosen = picks ?? (await this.ask());
    if (!chosen) return undefined;
    if (chosen.agents.length === 0) return [];
    const env = await this.env(chosen.home, chosen.repo);
    const [launch, skill] = await Promise.all([this.launch(), this.skillFiles()]);
    const items = await planSetup(chosen.agents, chosen.scope, env, launch, skill);
    const lines = this.describe(items, env.home);
    if (confirm) {
      const go = await vscode.window.showInformationMessage(
        'Set up AI assistants for Ansible flows?',
        {
          modal: true,
          detail: `${lines.join('\n')}\n\nConfig files get a one-time .afd-backup copy first.`,
        },
        'Apply',
      );
      if (go !== 'Apply') return undefined;
    }
    await applySetup(items, env, launch, skill);
    this.log.info(`AI setup (${this.version}):`);
    for (const line of lines) this.log.info(`AI setup:   ${line}`);
    if (!chosen.home) {
      const record: SetupRecord = {
        version: this.version,
        agents: chosen.agents,
        scope: chosen.scope,
        ...(chosen.repo ? { repo: chosen.repo } : {}),
        runtime: launch.command,
      };
      await this.context.globalState.update(STATE, record);
    }
    await this.refreshContext();
    if (announce) void this.announce(items, launch);
    return items;
  }

  private async announce(items: Item[], launch: Launch): Promise<void> {
    const claudeSkipped = items.some(
      (i) => i.agent === 'claude' && i.what === 'mcp' && i.action === 'skip',
    );
    const agents = list([...new Set(items.map((i) => agentLabel(i.agent)))]);
    const message = claudeSkipped
      ? `Set up ${agents}. Claude Code is not on PATH: copy the command and run it once it is installed. Restart running agents to load the flow tools.`
      : `Set up ${agents}: they can now read and edit Ansible flows. Restart running agents to load the flow tools.`;
    const pick = await vscode.window.showInformationMessage(
      message,
      ...(claudeSkipped ? ['Copy Command'] : []),
      'Show Log',
    );
    if (pick === 'Copy Command') await vscode.env.clipboard.writeText(claudeCommandLine(launch));
    if (pick === 'Show Log') this.log.show();
  }

  private async ask(): Promise<SetupPicks | undefined> {
    const found = await this.found();
    const done = new Set(this.record?.agents ?? []);
    const other = {
      label: 'Other agent…',
      description: 'a guide, the skill to copy and a ready MCP config',
      detail: 'Cline, Qwen Code, Claude Desktop and any agent that reads skills and MCP servers',
      picked: false,
      id: undefined,
    };
    const picked = await vscode.window.showQuickPick(
      [
        ...AGENT_INFO.map((a) => ({
          label: a.label,
          description: found.has(a.id)
            ? `found (${found.get(a.id)})${done.has(a.id) ? ', set up' : ''}`
            : 'not found: config only',
          detail: a.detail,
          picked: found.has(a.id),
          id: a.id as Agent | undefined,
        })),
        other,
      ],
      {
        title:
          'Set Up AI Assistants (Copilot in VS Code needs nothing: its skill and tools are built in)',
        placeHolder: 'Agents to give the ansible-flow skill and flow tools',
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!picked?.length) return undefined;
    if (picked.some((p) => p === other)) void this.otherAgent();
    const agents = picked.flatMap((p) => (p.id ? [p.id] : []));
    if (agents.length === 0) return { agents: [], scope: 'user' };
    const folder = vscode.workspace.workspaceFolders?.[0];
    const scope = await vscode.window.showQuickPick(
      [
        ...(folder
          ? [
              {
                label: `This repository (${folder.name})`,
                detail:
                  'Skill copies in .claude/skills, .agents/skills or .github/skills: commit them to share with the team',
                scope: 'repo' as const,
              },
            ]
          : []),
        {
          label: 'Just me (every repository)',
          detail:
            'Skill copies in each agent’s folder in your home folder (~/.claude/skills, ~/.agents/skills, ~/.kiro/skills, …)',
          scope: 'user' as const,
        },
      ],
      {
        title: 'Where should the skill go? (the tools are registered for you either way)',
        ignoreFocusOut: true,
      },
    );
    if (!scope) return undefined;
    return {
      agents,
      scope: scope.scope,
      ...(scope.scope === 'repo' && folder ? { repo: folder.uri.fsPath } : {}),
    };
  }

  /** Agents setup does not know: a guide with this machine's command, the skill and the config. */
  async otherAgent(): Promise<void> {
    const launch = await this.launch();
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: otherAgentGuide(launch),
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    const pick = await vscode.window.showInformationMessage(
      'Another agent: copy the skill to the folder it reads skills from, and add the MCP config.',
      'Copy Skill To Folder…',
      'Copy MCP Config',
    );
    if (pick === 'Copy MCP Config') await vscode.env.clipboard.writeText(mcpJson(launch));
    if (pick === 'Copy Skill To Folder…') {
      const [folder] =
        (await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          openLabel: 'Copy the skill here',
          title: 'The folder your agent reads skills from (e.g. .agents/skills)',
        })) ?? [];
      if (!folder) return;
      const dir = join(folder.fsPath, SKILL_NAME);
      const state = await skillState(dir);
      if (state?.foreign) {
        void vscode.window.showWarningMessage(`${dir} exists and is not ours; left as it is.`);
        return;
      }
      await writeSkill(dir, await this.skillFiles());
      this.log.info(`AI setup: skill copied for another agent: ${dir}`);
      void vscode.window.showInformationMessage(`The skill is in ${dir}. Restart the agent.`);
    }
  }

  async remove(picks?: {
    agents: Agent[];
    home?: string;
    repo?: string;
  }): Promise<Item[] | undefined> {
    const agents = picks?.agents ?? [...AGENTS];
    const repo = picks?.repo ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const env = await this.env(picks?.home, repo);
    if (!picks) {
      const go = await vscode.window.showWarningMessage(
        'Remove the ansible-flow skill copies and flow tools registered for your AI agents?',
        {
          modal: true,
          detail:
            'Only what Set Up AI Assistants wrote is removed. Copilot keeps its built-in skill and tools.',
        },
        'Remove',
      );
      if (go !== 'Remove') return undefined;
    }
    const removed = await removeSetup(agents, env);
    this.log.info('AI setup: removed:');
    for (const line of this.describe(removed, env.home)) this.log.info(`AI setup:   ${line}`);
    if (!picks?.home) await this.context.globalState.update(STATE, undefined);
    await this.refreshContext(env.home);
    if (!picks)
      void vscode.window.showInformationMessage(
        removed.length ? `Removed ${removed.length} item(s); see the log.` : 'Nothing to remove.',
      );
    return removed;
  }

  /** Copilot reads skill folders too: hide the built-in copy while one is on disk (no duplicates). */
  async refreshContext(home = homedir()): Promise<void> {
    const dirs = [
      ...(vscode.workspace.workspaceFolders ?? []).flatMap((f) =>
        ['.github', '.claude', '.agents'].map((d) => join(f.uri.fsPath, d, 'skills', SKILL_NAME)),
      ),
      ...['.copilot', '.claude', '.agents'].map((d) => join(home, d, 'skills', SKILL_NAME)),
    ];
    const states = await Promise.all(
      dirs.map((d) =>
        fs.stat(join(d, 'SKILL.md')).then(
          () => true,
          () => false,
        ),
      ),
    );
    await vscode.commands.executeCommand('setContext', 'afd.skillOnDisk', states.some(Boolean));
    // AFD-73: Remove AI Assistant Setup… shows in the Command Palette once there is one.
    await vscode.commands.executeCommand(
      'setContext',
      'afd.ai.configured',
      (this.record?.agents.length ?? 0) > 0,
    );
  }

  /**
   * After activation: refresh the server copy, and when the setup is from an older version (or the
   * VS Code runtime it uses moved), offer one update per version.
   */
  async checkStale(): Promise<void> {
    await this.refreshContext();
    const record = this.record;
    if (!record) return;
    await installServer(this.context);
    const moved = record.runtime !== 'node' && record.runtime !== process.execPath;
    if ((record.version === this.version && !moved) || record.dismissed === this.version) return;
    const env: Env = { home: homedir(), ...(record.repo ? { repo: record.repo } : {}) };
    const dirs = [...new Set(record.agents.flatMap((a) => skillDirs(a, record.scope, env)))];
    const edited = (await Promise.all(dirs.map(skillState))).some((s) => s?.edited.length);
    const pick = await vscode.window.showInformationMessage(
      `The AI assistant setup is from Ansible Flow Designer ${record.version}${moved ? ' and points to a VS Code that moved' : ''}. Update it?${edited ? ' Your edits to the skill copies will be replaced.' : ''}`,
      'Update',
      'Not now',
    );
    if (pick === 'Update')
      await this.setup(
        {
          agents: record.agents,
          scope: record.scope,
          ...(record.repo ? { repo: record.repo } : {}),
        },
        false,
        true,
      );
    else if (pick === 'Not now')
      await this.context.globalState.update(STATE, { ...record, dismissed: this.version });
  }

  /**
   * AFD-20: offer the setup once to agents found without it. AFD-73: only once a designer shows a
   * flow with a step (not in any workspace at startup); Set Up… shows what it writes before writing
   * it; an agent counts as offered once the user answered (or closed the notice).
   */
  async offer(exclude?: Agent): Promise<void> {
    if (this.context.globalState.get<boolean>(NEVER)) return;
    const record = this.record;
    const offered = new Set(this.context.globalState.get<Agent[]>(OFFERED) ?? []);
    const found = await this.found();
    // AFD-174: the agent built into this editor is offered on its own (HostIntegration).
    const pending = [...found.keys()].filter(
      (a) => a !== exclude && !record?.agents.includes(a) && !offered.has(a),
    );
    if (pending.length === 0) return;
    const names = list(pending.map(agentLabel));
    const pick = await vscode.window.showInformationMessage(
      `${names} can help you design flows once ${pending.length > 1 ? 'they have' : 'it has'} the ansible-flow skill and flow tools. Set ${pending.length > 1 ? 'them' : 'it'} up for every repository? You see what is written first.`,
      'Set Up…',
      'Choose…',
      'Not Now',
      'Don’t Ask Again',
    );
    await this.context.globalState.update(OFFERED, [...offered, ...pending]);
    if (pick === 'Set Up…') {
      const agents = [...new Set([...(record?.agents ?? []), ...pending])];
      await this.setup({ agents, scope: 'user' }, true, true);
    } else if (pick === 'Choose…') await this.setup();
    else if (pick === 'Don’t Ask Again') await this.context.globalState.update(NEVER, true);
  }
}
