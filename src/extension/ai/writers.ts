// What Set Up AI Assistants writes for terminal agents (AFD-19), without VS Code so it can be
// tested against a temporary home folder. Skill copies carry a manifest so updates, hand edits and
// removal are told apart; MCP registrations go where each agent reads them: Claude Code through its
// CLI, Codex as a marked block in ~/.codex/config.toml, Gemini as one key in ~/.gemini/settings.json.
// Every config file gets a one-time *.afd-backup before its first change.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  applyEdits,
  type FormattingOptions,
  findNodeAtLocation,
  modify,
  parseTree,
} from 'jsonc-parser';

export type Agent = 'claude' | 'codex' | 'gemini';
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

/** Folders an agent reads the skill from, per scope (Gemini also reads .agents/skills). */
export function skillDirs(agent: Agent, scope: Scope, env: Env): string[] {
  const base = scope === 'repo' ? env.repo : env.home;
  if (!base) return [];
  const folder = {
    claude: ['.claude'],
    codex: ['.agents'],
    gemini: scope === 'repo' ? ['.agents'] : ['.gemini'],
  }[agent];
  return folder.map((f) => join(base, f, 'skills', SKILL_NAME));
}

export interface SkillState {
  dir: string;
  /** Not ours: the folder exists without our manifest. */
  foreign: boolean;
  version?: string;
  /** Files of ours the user changed since they were written. */
  edited: string[];
}

export async function skillState(dir: string): Promise<SkillState | undefined> {
  if (!(await exists(dir))) return undefined;
  const raw = await readText(join(dir, MANIFEST));
  if (!raw) return { dir, foreign: true, edited: [] };
  const manifest = JSON.parse(raw) as Manifest;
  const edited: string[] = [];
  for (const [name, h] of Object.entries(manifest.files)) {
    const text = await readText(join(dir, name));
    if (text !== undefined && hash(text) !== h) edited.push(name);
  }
  return { dir, foreign: false, version: manifest.version, edited };
}

export async function planSkill(dir: string, skill: SkillFiles): Promise<Item['action']> {
  const state = await skillState(dir);
  if (!state) return 'create';
  if (state.foreign) return 'skip';
  for (const [name, text] of Object.entries(skill.files))
    if ((await readText(join(dir, name))) !== text) return 'update';
  return state.version === skill.version ? 'unchanged' : 'update';
}

export async function writeSkill(dir: string, skill: SkillFiles): Promise<void> {
  const before = await skillState(dir);
  if (before?.foreign) throw new Error(`${dir} exists and is not ours`);
  // Files of an older version that the new one no longer has.
  const old = before
    ? (JSON.parse((await readText(join(dir, MANIFEST))) ?? '{}') as Manifest)
    : undefined;
  for (const name of Object.keys(old?.files ?? {}))
    if (!(name in skill.files)) await fs.rm(join(dir, name), { force: true });
  for (const [name, text] of Object.entries(skill.files)) {
    await fs.mkdir(dirname(join(dir, name)), { recursive: true });
    await fs.writeFile(join(dir, name), text, 'utf8');
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
  const manifest = JSON.parse((await readText(join(dir, MANIFEST))) ?? '{}') as Manifest;
  for (const name of [...Object.keys(manifest.files ?? {}), MANIFEST])
    await fs.rm(join(dir, name), { force: true });
  const prune = async (d: string): Promise<void> => {
    if (relative(dir, d).startsWith('..')) return;
    try {
      if ((await fs.readdir(d)).length === 0) {
        await fs.rmdir(d);
        if (d !== dir) await prune(dirname(d));
      }
    } catch {}
  };
  for (const name of Object.keys(manifest.files ?? {})) await prune(dirname(join(dir, name)));
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

// ---- MCP: Gemini (~/.gemini/settings.json) ----------------------------------------------------

export const geminiSettings = (env: Env) => join(env.home, '.gemini', 'settings.json');
const PATH = ['mcpServers', SERVER_NAME];

function geminiEntry(launch: Launch) {
  return {
    command: launch.command,
    args: launch.args,
    ...(launch.env ? { env: launch.env } : {}),
    description: 'Ansible Flow Designer: read and edit *.flow.yaml flows by key',
  };
}

function formatting(text: string): FormattingOptions {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  return {
    insertSpaces: !indent.includes('\t'),
    tabSize: indent.includes('\t') ? 1 : indent.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

function current(text: string): unknown {
  const tree = parseTree(text);
  const node = tree && findNodeAtLocation(tree, PATH);
  return node ? JSON.parse(text.slice(node.offset, node.offset + node.length)) : undefined;
}

export async function planGemini(env: Env, launch: Launch): Promise<Item> {
  const target = geminiSettings(env);
  const text = (await readText(target)) ?? '';
  const now = text.trim() ? current(text) : undefined;
  const item = { agent: 'gemini' as const, what: 'mcp' as const, target };
  if (now === undefined) return { ...item, action: 'create' };
  return {
    ...item,
    action: JSON.stringify(now) === JSON.stringify(geminiEntry(launch)) ? 'unchanged' : 'update',
  };
}

export async function writeGemini(env: Env, launch: Launch): Promise<void> {
  const target = geminiSettings(env);
  const text = (await readText(target)) ?? '';
  const base = text.trim() ? text : '{}\n';
  const next = applyEdits(
    base,
    modify(base, PATH, geminiEntry(launch), { formattingOptions: formatting(base) }),
  );
  if (next === text) return;
  await fs.mkdir(dirname(target), { recursive: true });
  await backup(target);
  await fs.writeFile(target, next, 'utf8');
}

export async function removeGemini(env: Env): Promise<boolean> {
  const target = geminiSettings(env);
  const text = await readText(target);
  if (!text || current(text) === undefined) return false;
  await fs.writeFile(
    target,
    applyEdits(text, modify(text, PATH, undefined, { formattingOptions: formatting(text) })),
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
          : planGemini(env, launch)),
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
    else await writeGemini(env, launch);
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
          : await removeGemini(env);
    if (gone)
      removed.push({
        agent,
        what: 'mcp',
        target:
          agent === 'claude'
            ? 'claude mcp'
            : agent === 'codex'
              ? codexConfig(env)
              : geminiSettings(env),
        action: 'remove',
      });
  }
  return removed;
}
