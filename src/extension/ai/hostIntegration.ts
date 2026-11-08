// The agent built into the editor this runs in (AFD-174, epic AFD-170), the way Copilot gets the
// flow tools in VS Code. Cursor: through its extension API at every start, with the open folders
// as the server's roots; nothing is written. Kiro, Antigravity IDE and Devin Desktop read files
// only: after one consent they get the MCP entry and the skill (the Set Up AI Assistants writers),
// kept up to date at each start. What each reads was checked in the editors (AFD-172).
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import * as vscode from 'vscode';
import { agentLabel } from '../../node/ai/agents';
import { detectHost, HOSTS, type HostId } from '../../node/ai/hosts';
import {
  type Agent,
  applySetup,
  type Env,
  type Item,
  type Launch,
  planSetup,
  SERVER_NAME,
  SKILL_NAME,
  type SkillFiles,
} from '../../node/ai/writers';
import { antigravityApi, cursorApi } from '../compat';
import { logChannel } from '../log';
import { absoluteLaunch, installServer } from './launcher';

const STATE = 'afd.ai.host';
const SETTING = 'hostIntegration';

/** Set Up AI Assistants' agent for each editor's built-in agent. */
export const HOST_AGENT: Partial<Record<HostId, Agent>> = {
  cursor: 'cursor',
  antigravity: 'antigravity',
  kiro: 'kiro',
  windsurf: 'devin',
};

interface HostRecord {
  /** yes: kept up to date at each start; later: asked again after an update; never. */
  state: 'yes' | 'later' | 'never';
  version: string;
}

export interface HostOptions {
  /** Tests: another editor and home folder than this one's. */
  host?: HostId;
  home?: string;
}

const readJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const hasServer = (data: Record<string, unknown> | undefined) =>
  !!(data?.mcpServers as Record<string, unknown> | undefined)?.[SERVER_NAME];

export class HostIntegration implements vscode.Disposable {
  readonly host: HostId;
  readonly agent: Agent | undefined;
  private readonly home: string;
  private readonly log = logChannel();
  private cursorRegistered = false;
  /** The activation work; the consent notice waits for it (Cursor's registration decides it). */
  private starting?: Promise<void>;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly skillFiles: () => Promise<SkillFiles>,
    options: HostOptions = {},
  ) {
    this.host = options.host ?? detectHost(vscode.env);
    this.agent = HOST_AGENT[this.host];
    this.home = options.home ?? homedir();
  }

  private get version(): string {
    return (this.context.extension.packageJSON as { version: string }).version;
  }

  private get record(): HostRecord | undefined {
    return this.context.globalState.get<HostRecord>(STATE);
  }

  private label(): string {
    return HOSTS[this.host].agent;
  }

  /** On for a fork's agent, in a local window, unless afd.ai.hostIntegration is off. */
  get enabled(): boolean {
    return (
      !!this.agent &&
      !vscode.env.remoteName &&
      vscode.workspace.getConfiguration('afd.ai').get<boolean>(SETTING, true)
    );
  }

  private env(): Env {
    return { home: this.home, platform: process.platform, xdgConfig: process.env.XDG_CONFIG_HOME };
  }

  private async launch(): Promise<Launch> {
    return absoluteLaunch(await installServer(this.context));
  }

  /** At activation: Cursor's registration, then silent updates of what the user agreed to. */
  start(): Promise<void> {
    this.starting ??= this.begin();
    return this.starting;
  }

  private async begin(): Promise<void> {
    if (!this.enabled) {
      if (this.agent && vscode.env.remoteName)
        this.log.info(`AI host: ${this.label()} is not set up from a remote window`);
      return;
    }
    if (this.record?.state === 'never') return;
    await this.registerCursor();
    if (this.record?.state === 'yes') await this.update(false);
  }

  /**
   * Cursor: vscode.cursor.mcp.registerServer, shown to its agent as extension-ansible-flow. The
   * open folders go as AFD_MCP_ROOTS: Cursor sends the server no roots and starts it in the home
   * folder. Registered again when the folders change; unregistered when the extension stops.
   */
  private async registerCursor(): Promise<void> {
    const mcp = cursorApi(vscode)?.mcp;
    if (this.host !== 'cursor' || !mcp?.registerServer) return;
    const register = async () => {
      const launch = await this.launch();
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const env = {
        ...(launch.env ?? {}),
        ...(folders.length ? { AFD_MCP_ROOTS: folders.join(delimiter) } : {}),
      };
      if (this.cursorRegistered) await Promise.resolve(mcp.unregisterServer?.(SERVER_NAME));
      await Promise.resolve(
        mcp.registerServer?.({
          name: SERVER_NAME,
          server: { command: launch.command, args: launch.args, env },
        }),
      );
      this.cursorRegistered = true;
      this.log.info(
        `AI host: Cursor Agent has the flow tools (extension-${SERVER_NAME}) for ${folders.length ? folders.join(', ') : 'no folder'}`,
      );
    };
    try {
      await register();
      this.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
          void register().catch((e: unknown) => this.failed(e));
        }),
      );
      if (hasServer(await readJson(join(this.home, '.cursor', 'mcp.json'))))
        this.log.info(
          `AI host: ~/.cursor/mcp.json also has ${SERVER_NAME} (Set Up AI Assistants); Cursor Agent lists both. Remove AI Assistant Setup for Cursor takes the file entry back.`,
        );
    } catch (e) {
      this.failed(e);
    }
  }

  private failed(e: unknown): void {
    this.log.warn(`AI host: ${e instanceof Error ? e.message : String(e)}`);
  }

  /** The skill folders this editor's agent reads that already hold a copy, ours or not. */
  private async skillElsewhere(): Promise<boolean> {
    const dirs = HOSTS[this.host]
      .skills({ home: this.home, platform: process.platform })
      .map((d) => join(d, SKILL_NAME, 'SKILL.md'));
    const found = await Promise.all(
      dirs.map((d) =>
        fs.stat(d).then(
          () => true,
          () => false,
        ),
      ),
    );
    return found.some(Boolean);
  }

  /** What this editor's agent still needs: the skill and (unless it has it otherwise) the MCP entry. */
  async plan(): Promise<{ items: Item[]; launch: Launch; skill: SkillFiles }> {
    if (!this.agent)
      return { items: [], launch: { command: '', args: [] }, skill: { version: '', files: {} } };
    const [launch, skill] = await Promise.all([this.launch(), this.skillFiles()]);
    const all = await planSetup([this.agent], 'user', this.env(), launch, skill);
    const skillElsewhere = await this.skillElsewhere();
    // Devin also runs the servers registered for Claude Code and Cursor: a second entry would
    // show the tools twice.
    const devinHasIt =
      this.host === 'windsurf' &&
      (hasServer(await readJson(join(this.home, '.claude.json'))) ||
        hasServer(await readJson(join(this.home, '.cursor', 'mcp.json'))));
    const items = all.filter((i) => {
      if (i.what === 'mcp' && this.host === 'cursor' && this.cursorRegistered) return false;
      if (i.what === 'mcp' && devinHasIt) return false;
      // A copy in another folder this agent reads is enough; ours where we wrote it is kept fresh.
      if (i.what === 'skill' && i.action === 'create' && skillElsewhere) return false;
      return true;
    });
    return { items, launch, skill };
  }

  private show(path: string): string {
    return path.startsWith(this.home)
      ? `~${path.slice(this.home.length).replaceAll('\\', '/')}`
      : path;
  }

  /**
   * Once a designer shows a flow with a step (AFD-73): asks to give this editor's agent the tools
   * and the skill. Returns whether it asked, so the general offer waits for another time.
   */
  async offer(): Promise<boolean> {
    if (!this.enabled) return false;
    await this.starting?.catch(() => undefined);
    const record = this.record;
    if (record?.state === 'yes' || record?.state === 'never') return false;
    if (record?.state === 'later' && record.version === this.version) return false;
    const { items } = await this.plan();
    const todo = items.filter((i) => i.action === 'create' || i.action === 'update');
    if (todo.length === 0) return false;
    // Say what this writes: in Cursor the tools come through its API, so often only the skill.
    const parts = todo.map(
      (i) =>
        `${i.what === 'mcp' ? 'the flow tools' : 'the ansible-flow skill'} (${this.show(i.target)})`,
    );
    const question = todo.every((i) => i.action === 'update')
      ? `Update ${parts.join(' and ')} that ${this.label()} reads to Ansible Flow Designer ${this.version}?`
      : `Give ${this.label()} ${parts.join(' and ')}?`;
    const pick = await vscode.window.showInformationMessage(
      `${question} Kept up to date from then on; Remove AI Assistant Setup takes it back.`,
      'Set Up',
      'Not Now',
      'Don’t Ask Again',
    );
    if (pick === 'Set Up') {
      await this.context.globalState.update(STATE, { state: 'yes', version: this.version });
      await this.update(true);
    } else if (pick === 'Don’t Ask Again')
      await this.context.globalState.update(STATE, { state: 'never', version: this.version });
    else await this.context.globalState.update(STATE, { state: 'later', version: this.version });
    return true;
  }

  /** Writes what changed (a new version, a moved runtime); tells the agent to reload where it can. */
  async update(announce: boolean): Promise<Item[]> {
    const { items, launch, skill } = await this.plan();
    const todo = items.filter((i) => i.action === 'create' || i.action === 'update');
    if (todo.length === 0) return [];
    await applySetup(todo, this.env(), launch, skill);
    for (const i of todo)
      this.log.info(
        `AI host: ${i.action} ${agentLabel(i.agent)} ${i.what}, ${this.show(i.target)}`,
      );
    for (const i of items.filter((x) => x.action === 'skip'))
      this.log.info(`AI host: skipped ${this.show(i.target)}${i.note ? ` (${i.note})` : ''}`);
    const live = await this.reload();
    if (announce)
      void vscode.window.showInformationMessage(
        live
          ? `${this.label()} has the Ansible flow tools and skill. Ask it to create or change a flow.`
          : `${this.label()} has the Ansible flow tools and skill. Start a new chat${this.host === 'windsurf' ? ' with the agent set to local' : ''} to use them.`,
      );
    return todo;
  }

  /** Antigravity IDE reloads its MCP servers on request; the others read the files themselves. */
  private async reload(): Promise<boolean> {
    const ag = antigravityApi(vscode);
    if (this.host !== 'antigravity' || !ag?.refreshMcpServers) return this.host === 'kiro';
    try {
      await ag.refreshMcpServers();
      return true;
    } catch (e) {
      this.failed(e);
      return false;
    }
  }

  /** Remove AI Assistant Setup took the files back: no more updates, and Cursor's registration ends. */
  async removed(): Promise<void> {
    await this.context.globalState.update(STATE, { state: 'never', version: this.version });
    if (this.cursorRegistered) {
      await Promise.resolve(cursorApi(vscode)?.mcp?.unregisterServer?.(SERVER_NAME));
      this.cursorRegistered = false;
    }
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    if (this.cursorRegistered)
      void Promise.resolve(cursorApi(vscode)?.mcp?.unregisterServer?.(SERVER_NAME));
  }
}
