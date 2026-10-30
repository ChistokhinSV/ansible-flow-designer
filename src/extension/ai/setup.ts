// Set Up AI Assistants / Remove AI Assistant Setup (AFD-19). Copilot needs nothing: the skill,
// instructions and tools are contributed by the extension. Terminal agents (Claude Code, Codex,
// Gemini) get a copy of the skill (this repository or the user's home, asked each time) and the
// MCP server registered for the user. Every change is previewed first and logged.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { installServer, launchFor, onPath } from './launcher';
import {
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
  skillState,
} from './writers';

const STATE = 'afd.ai.setup';
const AGENTS: { id: Agent; label: string; bin: string; detail: string }[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    detail: 'CLI and its VS Code extension: skill in .claude/skills, tools via `claude mcp`',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    bin: 'codex',
    detail: 'skill in .agents/skills, tools in ~/.codex/config.toml',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    detail: 'skill in .agents/.gemini skills, tools in ~/.gemini/settings.json',
  },
];

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

export class AiSetup {
  private readonly log: vscode.OutputChannel;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.log = vscode.window.createOutputChannel('Ansible Flow: AI setup');
    context.subscriptions.push(this.log);
  }

  private get version(): string {
    return (this.context.extension.packageJSON as { version: string }).version;
  }

  private async env(home = homedir(), repo?: string): Promise<Env> {
    const claude = await onPath('claude');
    return { home, ...(repo ? { repo } : {}), ...(claude ? { claude: claudeRunner(claude) } : {}) };
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
      return `${verb[i.action]}: ${AGENTS.find((a) => a.id === i.agent)?.label} ${what}, ${target}${i.note ? ` (${i.note})` : ''}`;
    });
  }

  /** Asks which agents and where, previews, writes. Picks skip the questions (tests, updates). */
  async setup(picks?: SetupPicks, confirm = true): Promise<Item[] | undefined> {
    const chosen = picks ?? (await this.ask());
    if (!chosen) return undefined;
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
    this.log.appendLine(`[${new Date().toISOString()}] Set up (${this.version}):`);
    for (const line of lines) this.log.appendLine(`  ${line}`);
    if (!chosen.home) {
      const record: SetupRecord = { version: this.version, ...chosen, runtime: launch.command };
      await this.context.globalState.update(STATE, record);
    }
    await this.refreshContext();
    if (confirm) void this.announce(items, launch);
    return items;
  }

  private async announce(items: Item[], launch: Launch): Promise<void> {
    const claudeSkipped = items.some(
      (i) => i.agent === 'claude' && i.what === 'mcp' && i.action === 'skip',
    );
    const message = claudeSkipped
      ? 'AI assistants set up. Claude Code is not on PATH: copy the command and run it once it is installed. Restart running agents to load the tools.'
      : 'AI assistants set up. Restart running agents (claude, codex, gemini) to load the flow tools.';
    const pick = await vscode.window.showInformationMessage(
      message,
      ...(claudeSkipped ? ['Copy Command'] : []),
      'Show Log',
    );
    if (pick === 'Copy Command') await vscode.env.clipboard.writeText(claudeCommandLine(launch));
    if (pick === 'Show Log') this.log.show();
  }

  private async ask(): Promise<SetupPicks | undefined> {
    const found = await Promise.all(AGENTS.map(async (a) => !!(await onPath(a.bin))));
    const picked = await vscode.window.showQuickPick(
      AGENTS.map((a, i) => ({
        label: a.label,
        description: found[i] ? 'found on PATH' : 'not found: config only',
        detail: a.detail,
        picked: found[i],
        id: a.id,
      })),
      {
        title: 'Set Up AI Assistants (Copilot needs nothing: its skill and tools are built in)',
        placeHolder: 'Terminal agents to give the ansible-flow skill and flow tools',
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!picked?.length) return undefined;
    const folder = vscode.workspace.workspaceFolders?.[0];
    const scope = await vscode.window.showQuickPick(
      [
        ...(folder
          ? [
              {
                label: `This repository (${folder.name})`,
                detail:
                  'Skill copies in .claude/skills and .agents/skills: commit them to share with the team',
                scope: 'repo' as const,
              },
            ]
          : []),
        {
          label: 'Just me (every repository)',
          detail: 'Skill copies in ~/.claude/skills, ~/.agents/skills, ~/.gemini/skills',
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
      agents: picked.map((p) => p.id),
      scope: scope.scope,
      ...(scope.scope === 'repo' && folder ? { repo: folder.uri.fsPath } : {}),
    };
  }

  async remove(picks?: {
    agents: Agent[];
    home?: string;
    repo?: string;
  }): Promise<Item[] | undefined> {
    const agents = picks?.agents ?? AGENTS.map((a) => a.id);
    const repo = picks?.repo ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const env = await this.env(picks?.home, repo);
    if (!picks) {
      const go = await vscode.window.showWarningMessage(
        'Remove the ansible-flow skill copies and flow tools registered for Claude Code, Codex and Gemini?',
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
    this.log.appendLine(`[${new Date().toISOString()}] Removed:`);
    for (const line of this.describe(removed, env.home)) this.log.appendLine(`  ${line}`);
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
  }

  /**
   * After activation: refresh the server copy, and when the setup is from an older version (or the
   * VS Code runtime it uses moved), offer one update per version.
   */
  async checkStale(): Promise<void> {
    await this.refreshContext();
    const record = this.context.globalState.get<SetupRecord>(STATE);
    if (!record) return;
    await installServer(this.context);
    const moved = record.runtime !== 'node' && record.runtime !== process.execPath;
    if ((record.version === this.version && !moved) || record.dismissed === this.version) return;
    const edited = (
      await Promise.all(
        AGENTS.filter((a) => record.agents.includes(a.id)).map(async () => {
          const dirs = [
            join(homedir(), '.claude', 'skills', SKILL_NAME),
            ...(record.repo ? [join(record.repo, '.claude', 'skills', SKILL_NAME)] : []),
          ];
          return (await Promise.all(dirs.map(skillState))).some((s) => s?.edited.length);
        }),
      )
    ).some(Boolean);
    const pick = await vscode.window.showInformationMessage(
      `The AI assistant setup is from Ansible Flow Designer ${record.version}${moved ? ' and points to a VS Code that moved' : ''}. Update it?${edited ? ' Your edits to the skill copies will be replaced.' : ''}`,
      'Update',
      'Not now',
    );
    if (pick === 'Update')
      await this.setup({
        agents: record.agents,
        scope: record.scope,
        ...(record.repo ? { repo: record.repo } : {}),
      });
    else if (pick === 'Not now')
      await this.context.globalState.update(STATE, { ...record, dismissed: this.version });
  }
}
