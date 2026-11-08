// What Set Up AI Assistants writes for agents outside Copilot (AFD-19, AFD-20), without VS Code so
// it can be tested against a temporary home folder. Skill copies carry a manifest so updates, hand
// edits and removal are told apart; MCP registrations go where each agent reads them: Claude Code
// through its CLI, Codex as a marked block in ~/.codex/config.toml, the others as one key in their
// JSON(C) config. Every config file gets a one-time *.afd-backup before its first change.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import {
  applyEdits,
  type FormattingOptions,
  findNodeAtLocation,
  modify,
  type ParseError,
  parse as parseJsonc,
  parseTree,
} from 'jsonc-parser';
import { TOOL_SPECS } from '../../core/ai/specs';

export const AGENTS = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'zcode',
  'copilot',
  'cursor',
  // AFD-173: the agents built into VS Code forks, by the files they read (AFD-172 probes).
  'kiro',
  'antigravity',
  'devin',
] as const;
export type Agent = (typeof AGENTS)[number];
export type Scope = 'repo' | 'user';

export const SERVER_NAME = 'ansible-flow';
export const SKILL_NAME = 'ansible-flow';
const MANIFEST = '.afd-skill.json';
const BEGIN = `# >>> ${SERVER_NAME} (managed by Ansible Flow Designer; Remove AI Assistant Setup deletes it)`;
const END = `# <<< ${SERVER_NAME}`;

/** How agents start the MCP server. */
export interface Launch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface Item {
  agent: Agent;
  what: 'skill' | 'mcp';
  /** File or folder, or the command for Claude's registration. */
  target: string;
  action: 'create' | 'update' | 'unchanged' | 'skip' | 'remove';
  /** Why an item is skipped, or what the user must do. */
  note?: string;
}

export interface Env {
  home: string;
  /** Where Devin keeps its MCP file depends on it (default: this process's platform). */
  platform?: NodeJS.Platform;
  /** XDG_CONFIG_HOME, which Devin honours outside Windows. */
  xdgConfig?: string;
  /** The repository (workspace folder) for repo-scope skill copies. */
  repo?: string;
  /** Runs the claude CLI; undefined when it is not installed. */
  claude?: (args: string[]) => Promise<{ code: number; out: string }>;
}

export interface SkillFiles {
  version: string;
  /** Relative path (posix) -> text. */
  files: Record<string, string>;
}

interface Manifest {
  version: string;
  files: Record<string, string>;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

async function readText(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function backup(path: string): Promise<void> {
  const copy = `${path}.afd-backup`;
  if ((await exists(path)) && !(await exists(copy))) await fs.copyFile(path, copy);
}

// ---- skills ---------------------------------------------------------------------------------

/**
 * The folder (under the repository or home) each agent reads skills from. Agents that also read
 * another agent's folder share its copy: OpenCode and ZCode read .agents/skills, Cursor reads
 * Claude's, Gemini reads .agents/skills in a repository.
 */
const SKILL_HOME: Record<Agent, Record<Scope, string>> = {
  claude: { repo: '.claude', user: '.claude' },
  codex: { repo: '.agents', user: '.agents' },
  gemini: { repo: '.agents', user: '.gemini' },
  opencode: { repo: '.agents', user: '.agents' },
  zcode: { repo: '.agents', user: '.agents' },
  copilot: { repo: '.github', user: '.copilot' },
  cursor: { repo: '.claude', user: '.claude' },
  kiro: { repo: '.kiro', user: '.kiro' },
  // Antigravity's customization roots: .agents in a repository, ~/.gemini/config for the user.
  antigravity: { repo: '.agents', user: '.gemini/config' },
  // Devin reads ~/.codeium/windsurf/skills and ~/.agents/skills, not ~/.devin/skills.
  devin: { repo: '.agents', user: '.codeium/windsurf' },
};

/** Folders an agent reads the skill from, per scope. */
export function skillDirs(agent: Agent, scope: Scope, env: Env): string[] {
  const base = scope === 'repo' ? env.repo : env.home;
  if (!base) return [];
  return [join(base, SKILL_HOME[agent][scope], 'skills', SKILL_NAME)];
}

export interface SkillState {
  dir: string;
  /** Not ours: the folder exists without our manifest. */
  foreign: boolean;
  version?: string;
  /** Files of ours the user changed since they were written. */
  edited: string[];
}

/**
 * The manifest of a skill folder we wrote, or undefined when it is not ours. AFD-127: a repository
 * can plant one (repo-scope copies live in the repository), so only file names that stay inside
 * the folder are kept; a manifest that does not read makes the folder foreign, never deleted.
 */
async function readManifest(dir: string): Promise<Manifest | undefined> {
  const raw = await readText(join(dir, MANIFEST));
  if (raw === undefined) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object') return undefined;
  const { version, files } = data as { version?: unknown; files?: unknown };
  if (!files || typeof files !== 'object' || Array.isArray(files)) return undefined;
  const kept: Record<string, string> = {};
  for (const [name, h] of Object.entries(files))
    if (typeof h === 'string' && SKILL_FILE.test(name) && name !== MANIFEST) kept[name] = h;
  return { version: typeof version === 'string' ? version : '', files: kept };
}

/** A relative posix name of plain segments: no `.`/`..`, no drive, no backslash (AFD-127). */
const SKILL_FILE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[\w.-]+(?:\/[\w.-]+)*$/;

const insideDir = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The real path of `path`, or of its nearest ancestor that exists. */
async function nearestReal(path: string): Promise<string> {
  for (let p = path; ; p = dirname(p)) {
    try {
      return await fs.realpath(p);
    } catch {
      if (dirname(p) === p) return p;
    }
  }
}

/**
 * Where a skill file goes, or undefined when it would not land inside the folder: its name is not
 * a plain relative name, or a link on the way leads out (AFD-127).
 */
async function skillPath(dir: string, name: string): Promise<string | undefined> {
  if (!SKILL_FILE.test(name)) return undefined;
  const path = join(dir, ...name.split('/'));
  const [root, parent] = await Promise.all([nearestReal(dir), nearestReal(dirname(path))]);
  return insideDir(root, parent) ? path : undefined;
}

export async function skillState(dir: string): Promise<SkillState | undefined> {
  if (!(await exists(dir))) return undefined;
  // A link in place of the folder is not ours: removal would act on what it points to.
  const link = await fs.lstat(dir).then(
    (s) => s.isSymbolicLink(),
    () => false,
  );
  const manifest = link ? undefined : await readManifest(dir);
  if (!manifest) return { dir, foreign: true, edited: [] };
  const edited: string[] = [];
  for (const [name, h] of Object.entries(manifest.files)) {
    const path = await skillPath(dir, name);
    const text = path && (await readText(path));
    if (text !== undefined && hash(text) !== h) edited.push(name);
  }
  return { dir, foreign: false, version: manifest.version, edited };
}

/** a > b for versions like 0.75.0 (non-numeric parts count as 0). */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export async function planSkill(dir: string, skill: SkillFiles): Promise<Item['action']> {
  const state = await skillState(dir);
  if (!state) return 'create';
  if (state.foreign) return 'skip';
  // AFD-173: an editor with a newer Ansible Flow Designer wrote it (VS Code and a fork on one
  // machine): the older one leaves it, so the two do not overwrite each other at every start.
  if (state.version && newerVersion(state.version, skill.version)) return 'unchanged';
  for (const [name, text] of Object.entries(skill.files)) {
    const path = await skillPath(dir, name);
    if (!path || (await readText(path)) !== text) return 'update';
  }
  return state.version === skill.version ? 'unchanged' : 'update';
}

export async function writeSkill(dir: string, skill: SkillFiles): Promise<void> {
  const before = await skillState(dir);
  if (before?.foreign) throw new Error(`${dir} exists and is not ours`);
  // Files of an older version that the new one no longer has.
  const old = before ? await readManifest(dir) : undefined;
  for (const name of Object.keys(old?.files ?? {})) {
    if (name in skill.files) continue;
    const path = await skillPath(dir, name);
    if (path) await fs.rm(path, { force: true });
  }
  for (const [name, text] of Object.entries(skill.files)) {
    const path = await skillPath(dir, name);
    if (!path) throw new Error(`${name} would be written outside ${dir}`);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, text, 'utf8');
  }
  const manifest: Manifest = {
    version: skill.version,
    files: Object.fromEntries(Object.entries(skill.files).map(([n, t]) => [n, hash(t)])),
  };
  await fs.writeFile(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** Removes our files (and the folder when nothing else is left in it); foreign folders stay. */
export async function removeSkill(dir: string): Promise<boolean> {
  const state = await skillState(dir);
  if (!state || state.foreign) return false;
  const manifest = await readManifest(dir);
  const names = Object.keys(manifest?.files ?? {});
  for (const name of names) {
    const path = await skillPath(dir, name);
    if (path) await fs.rm(path, { force: true });
  }
  await fs.rm(join(dir, MANIFEST), { force: true });
  const prune = async (d: string): Promise<void> => {
    if (!insideDir(dir, d)) return;
    try {
      if ((await fs.readdir(d)).length === 0) {
        await fs.rmdir(d);
        if (d !== dir) await prune(dirname(d));
      }
    } catch {}
  };
  for (const name of names) await prune(dirname(join(dir, ...name.split('/'))));
  await prune(dir);
  return true;
}

// ---- MCP: Codex (~/.codex/config.toml) --------------------------------------------------------

export const codexConfig = (env: Env) => join(env.home, '.codex', 'config.toml');

/** TOML basic strings take JSON's escapes for the characters paths and names use. */
const tomlString = (s: string) => JSON.stringify(s);

export function codexBlock(launch: Launch): string {
  const lines = [
    BEGIN,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(', ')}]`,
  ];
  if (launch.env && Object.keys(launch.env).length)
    lines.push(
      `env = { ${Object.entries(launch.env)
        .map(([k, v]) => `${k} = ${tomlString(v)}`)
        .join(', ')} }`,
    );
  lines.push(END);
  return lines.join('\n');
}

function splitBlock(text: string): { before: string; block?: string; after: string } {
  const start = text.indexOf(BEGIN);
  const end = start < 0 ? -1 : text.indexOf(END, start);
  if (start < 0 || end < 0) return { before: text, after: '' };
  return {
    before: text.slice(0, start),
    block: text.slice(start, end + END.length),
    after: text.slice(end + END.length),
  };
}

/** A table of the same name written by the user (outside our block). */
const handWritten = (text: string) =>
  new RegExp(`^\\s*\\[mcp_servers\\.(${SERVER_NAME}|"${SERVER_NAME}")\\]`, 'm').test(
    splitBlock(text).before + splitBlock(text).after,
  );

export async function planCodex(env: Env, launch: Launch): Promise<Item> {
  const target = codexConfig(env);
  const text = (await readText(target)) ?? '';
  const item = { agent: 'codex' as const, what: 'mcp' as const, target };
  if (handWritten(text))
    return {
      ...item,
      action: 'skip',
      note: `[mcp_servers.${SERVER_NAME}] is written by hand there; left as it is`,
    };
  const { block } = splitBlock(text);
  if (block === undefined) return { ...item, action: 'create' };
  return { ...item, action: block === codexBlock(launch) ? 'unchanged' : 'update' };
}

export async function writeCodex(env: Env, launch: Launch): Promise<void> {
  const target = codexConfig(env);
  const text = (await readText(target)) ?? '';
  if (handWritten(text)) return;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = codexBlock(launch).replaceAll('\n', eol);
  const parts = splitBlock(text);
  const next =
    parts.block === undefined
      ? `${text}${text && !text.endsWith('\n') ? eol : ''}${text ? eol : ''}${block}${eol}`
      : `${parts.before}${block}${parts.after}`;
  if (next === text) return;
  await fs.mkdir(dirname(target), { recursive: true });
  await backup(target);
  await fs.writeFile(target, next, 'utf8');
}

export async function removeCodex(env: Env): Promise<boolean> {
  const target = codexConfig(env);
  const text = await readText(target);
  if (text === undefined) return false;
  const parts = splitBlock(text);
  if (parts.block === undefined) return false;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const after = parts.after.startsWith(eol) ? parts.after.slice(eol.length) : parts.after;
  await fs.writeFile(
    target,
    `${parts.before.replace(/(\r?\n)+$/, eol)}${after}`.replace(/^\r?\n$/, ''),
    'utf8',
  );
  return true;
}

// ---- MCP: one key in a JSON(C) config (Gemini, OpenCode, ZCode, Copilot CLI, Cursor) ------------

type JsonAgent = Exclude<Agent, 'claude' | 'codex'>;

const stdio = (l: Launch) => ({
  command: l.command,
  args: l.args,
  ...(l.env ? { env: l.env } : {}),
});

/** OpenCode reads opencode.jsonc or opencode.json in ~/.config/opencode; ours goes in the one there. */
async function opencodeConfig(env: Env): Promise<string> {
  const dir = join(env.home, '.config', 'opencode');
  const jsonc = join(dir, 'opencode.jsonc');
  return (await exists(jsonc)) ? jsonc : join(dir, 'opencode.json');
}

interface JsonSpec {
  file: (env: Env) => Promise<string>;
  path: string[];
  entry: (l: Launch) => Record<string, unknown>;
  /**
   * AFD-173: the keys of an existing entry that are ours. Others stay as the user or the agent set
   * them: Kiro's disabled, autoApprove and disabledTools, Cursor's and Devin's tool toggles.
   */
  managed: string[];
}

const STDIO_KEYS = ['command', 'args', 'env'];

/** The flow tools that only read (flow_list, flow_describe, …). */
const READ_ONLY_TOOLS = TOOL_SPECS.filter((s) => s.readOnly).map((s) => s.name);

/** Cursor's variable for the open folder, resolved by Cursor when it starts the server. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a Cursor config variable, not a template
export const CURSOR_WORKSPACE = '${workspaceFolder}';

const JSON_MCP: Record<JsonAgent, JsonSpec> = {
  gemini: {
    file: async (env) => join(env.home, '.gemini', 'settings.json'),
    path: ['mcpServers', SERVER_NAME],
    entry: (l) => ({
      ...stdio(l),
      description: 'Ansible Flow Designer: read and edit *.flow.yaml flows by key',
    }),
    managed: [...STDIO_KEYS, 'description'],
  },
  opencode: {
    file: opencodeConfig,
    path: ['mcp', SERVER_NAME],
    entry: (l) => ({
      type: 'local',
      command: [l.command, ...l.args],
      ...(l.env ? { environment: l.env } : {}),
      enabled: true,
    }),
    managed: ['type', 'command', 'environment'],
  },
  // ZCode reads ~/.agents/mcp.json (besides ~/.zcode/config.json): a file other agents share.
  zcode: {
    file: async (env) => join(env.home, '.agents', 'mcp.json'),
    path: ['mcpServers', SERVER_NAME],
    entry: stdio,
    managed: STDIO_KEYS,
  },
  copilot: {
    file: async (env) => join(env.home, '.copilot', 'mcp-config.json'),
    path: ['mcpServers', SERVER_NAME],
    entry: (l) => ({ type: 'local', ...stdio(l), tools: ['*'] }),
    managed: ['type', ...STDIO_KEYS],
  },
  cursor: {
    file: async (env) => join(env.home, '.cursor', 'mcp.json'),
    path: ['mcpServers', SERVER_NAME],
    // AFD-173: Cursor starts global servers in the home folder and sends no roots; the workspace
    // comes as a variable (the server leaves it out when Cursor does not resolve it).
    entry: (l) => ({
      ...stdio(l),
      env: { ...(l.env ?? {}), AFD_MCP_ROOTS: CURSOR_WORKSPACE },
    }),
    managed: STDIO_KEYS,
  },
  kiro: {
    file: async (env) => join(env.home, '.kiro', 'settings', 'mcp.json'),
    path: ['mcpServers', SERVER_NAME],
    // AFD-174: Kiro asks before every call; the tools that only read are approved when the entry
    // is first written. Not managed: what the user approves or takes back later stays.
    entry: (l) => ({ ...stdio(l), autoApprove: READ_ONLY_TOOLS }),
    managed: STDIO_KEYS,
  },
  // Antigravity IDE's global customization root; its own plugin folders do not load MCP servers.
  antigravity: {
    file: async (env) => join(env.home, '.gemini', 'config', 'mcp_config.json'),
    path: ['mcpServers', SERVER_NAME],
    entry: stdio,
    managed: STDIO_KEYS,
  },
  devin: {
    file: async (env) => devinMcpFile(env),
    path: ['mcpServers', SERVER_NAME],
    entry: stdio,
    managed: STDIO_KEYS,
  },
};

/**
 * Devin Desktop's MCP file, as its own code builds it: %USERPROFILE%\AppData\Roaming\devin on
 * Windows, else $XDG_CONFIG_HOME/devin or ~/.config/devin. (It reads Windsurf's
 * ~/.codeium/windsurf/mcp_config.json too, and Claude Code's and Cursor's entries.)
 */
export function devinMcpFile(env: Env): string {
  const platform = env.platform ?? process.platform;
  return platform === 'win32'
    ? join(env.home, 'AppData', 'Roaming', 'devin', 'mcp_config.json')
    : join(env.xdgConfig || join(env.home, '.config'), 'devin', 'mcp_config.json');
}

/** The config file an agent's registration goes in (Claude's is managed by its CLI). */
export async function mcpTarget(agent: Agent, env: Env, launch?: Launch): Promise<string> {
  if (agent === 'claude') return launch ? claudeCommandLine(launch) : 'claude mcp';
  if (agent === 'codex') return codexConfig(env);
  return JSON_MCP[agent].file(env);
}

function formatting(text: string): FormattingOptions {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  return {
    insertSpaces: !indent.includes('\t'),
    tabSize: indent.includes('\t') ? 1 : indent.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

function current(text: string, path: string[]): unknown {
  const tree = parseTree(text);
  const node = tree && findNodeAtLocation(tree, path);
  return node ? parseJsonc(text.slice(node.offset, node.offset + node.length)) : undefined;
}

/** A config that does not parse is left alone: an edit could make it worse. */
function broken(text: string): boolean {
  const errors: ParseError[] = [];
  parseJsonc(text, errors, { allowTrailingComma: true });
  return errors.length > 0;
}

export async function planJson(agent: JsonAgent, env: Env, launch: Launch): Promise<Item> {
  const spec = JSON_MCP[agent];
  const target = await spec.file(env);
  const text = (await readText(target)) ?? '';
  const item = { agent, what: 'mcp' as const, target };
  if (text.trim() && broken(text))
    return { ...item, action: 'skip', note: 'it does not parse as JSON; left as it is' };
  const now = text.trim() ? current(text, spec.path) : undefined;
  if (now === undefined) return { ...item, action: 'create' };
  const want = spec.entry(launch);
  const have = (now && typeof now === 'object' ? now : {}) as Record<string, unknown>;
  const same = spec.managed.every((k) => JSON.stringify(have[k]) === JSON.stringify(want[k]));
  return { ...item, action: same ? 'unchanged' : 'update' };
}

export async function writeJson(agent: JsonAgent, env: Env, launch: Launch): Promise<void> {
  const spec = JSON_MCP[agent];
  const target = await spec.file(env);
  const text = (await readText(target)) ?? '';
  if (text.trim() && broken(text)) return;
  const base = text.trim() ? text : '{}\n';
  const want = spec.entry(launch);
  const now = current(base, spec.path);
  let next = base;
  if (now === undefined || !now || typeof now !== 'object' || Array.isArray(now))
    next = applyEdits(next, modify(next, spec.path, want, { formattingOptions: formatting(next) }));
  else
    for (const key of spec.managed)
      next = applyEdits(
        next,
        modify(next, [...spec.path, key], want[key], { formattingOptions: formatting(next) }),
      );
  if (next === text) return;
  await fs.mkdir(dirname(target), { recursive: true });
  await backup(target);
  await fs.writeFile(target, next, 'utf8');
}

export async function removeJson(agent: JsonAgent, env: Env): Promise<boolean> {
  const spec = JSON_MCP[agent];
  const target = await spec.file(env);
  const text = await readText(target);
  if (!text || broken(text) || current(text, spec.path) === undefined) return false;
  await fs.writeFile(
    target,
    applyEdits(text, modify(text, spec.path, undefined, { formattingOptions: formatting(text) })),
    'utf8',
  );
  return true;
}

// ---- MCP: Claude Code (its CLI) ---------------------------------------------------------------

export function claudeAddArgs(launch: Launch): string[] {
  const env = Object.entries(launch.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return ['mcp', 'add', '-s', 'user', SERVER_NAME, ...env, '--', launch.command, ...launch.args];
}

/** The command a user runs when the claude CLI cannot be run from here. */
export function claudeCommandLine(launch: Launch): string {
  const q = (a: string) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a);
  return ['claude', ...claudeAddArgs(launch)].map(q).join(' ');
}

export async function planClaude(env: Env, launch: Launch): Promise<Item> {
  const item = {
    agent: 'claude' as const,
    what: 'mcp' as const,
    target: claudeCommandLine(launch),
  };
  if (!env.claude)
    return {
      ...item,
      action: 'skip',
      note: 'claude is not on PATH: run this command once it is installed',
    };
  const got = await env.claude(['mcp', 'get', SERVER_NAME]);
  if (got.code !== 0) return { ...item, action: 'create' };
  const same = got.out.includes(launch.command) && launch.args.every((a) => got.out.includes(a));
  return { ...item, action: same ? 'unchanged' : 'update' };
}

export async function writeClaude(env: Env, launch: Launch): Promise<void> {
  if (!env.claude) return;
  if ((await env.claude(['mcp', 'get', SERVER_NAME])).code === 0)
    await env.claude(['mcp', 'remove', SERVER_NAME, '-s', 'user']);
  const r = await env.claude(claudeAddArgs(launch));
  if (r.code !== 0) throw new Error(`claude mcp add failed: ${r.out.trim()}`);
}

export async function removeClaude(env: Env): Promise<boolean> {
  if (!env.claude || (await env.claude(['mcp', 'get', SERVER_NAME])).code !== 0) return false;
  return (await env.claude(['mcp', 'remove', SERVER_NAME, '-s', 'user'])).code === 0;
}

/** Runs the claude CLI found at this path (a .cmd shim needs the shell, with quoted arguments). */
export function claudeRunner(path: string): Env['claude'] {
  const shim = /\.(cmd|bat)$/i.test(path);
  return (args) =>
    new Promise((done) => {
      const quoted = shim ? args.map((a) => `"${a.replaceAll('"', '""')}"`) : args;
      execFile(
        shim ? `"${path}"` : path,
        quoted,
        { timeout: 30_000, windowsHide: true, shell: shim },
        (err, stdout, stderr) =>
          done({
            code: err ? ((err as { code?: number }).code ?? 1) : 0,
            out: `${stdout}${stderr}`,
          }),
      );
    });
}

// ---- plan, apply, remove ----------------------------------------------------------------------

export async function planSetup(
  agents: Agent[],
  scope: Scope,
  env: Env,
  launch: Launch,
  skill: SkillFiles,
): Promise<Item[]> {
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    for (const dir of skillDirs(agent, scope, env)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const action = await planSkill(dir, skill);
      const state = action === 'update' ? await skillState(dir) : undefined;
      items.push({
        agent,
        what: 'skill',
        target: dir,
        action,
        ...(action === 'skip'
          ? { note: 'a folder of that name exists and is not ours; left as it is' }
          : {}),
        ...(state?.edited.length
          ? { note: `you changed ${state.edited.join(', ')}; it will be replaced` }
          : {}),
      });
    }
    items.push(
      await (agent === 'claude'
        ? planClaude(env, launch)
        : agent === 'codex'
          ? planCodex(env, launch)
          : planJson(agent, env, launch)),
    );
  }
  return items;
}

export async function applySetup(
  items: Item[],
  env: Env,
  launch: Launch,
  skill: SkillFiles,
): Promise<void> {
  for (const item of items) {
    if (item.action !== 'create' && item.action !== 'update') continue;
    if (item.what === 'skill') await writeSkill(item.target, skill);
    else if (item.agent === 'claude') await writeClaude(env, launch);
    else if (item.agent === 'codex') await writeCodex(env, launch);
    else await writeJson(item.agent, env, launch);
  }
}

/** Removes skill copies (both scopes) and registrations of these agents; returns what went. */
export async function removeSetup(agents: Agent[], env: Env): Promise<Item[]> {
  const removed: Item[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    for (const scope of ['repo', 'user'] as const)
      for (const dir of skillDirs(agent, scope, env)) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        if (await removeSkill(dir))
          removed.push({ agent, what: 'skill', target: dir, action: 'remove' });
      }
    const gone =
      agent === 'claude'
        ? await removeClaude(env)
        : agent === 'codex'
          ? await removeCodex(env)
          : await removeJson(agent, env);
    if (gone)
      removed.push({ agent, what: 'mcp', target: await mcpTarget(agent, env), action: 'remove' });
  }
  return removed;
}
