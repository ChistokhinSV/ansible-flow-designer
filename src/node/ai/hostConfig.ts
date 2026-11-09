// What each editor's agent is configured with on this machine (AFD-172): MCP servers by name, the
// skills in its folders and its plugin bundles. Read-only, names only: a server entry's command,
// arguments and environment (tokens) are never read out, except where ours starts (AFD-195).
import { promises as fs } from 'node:fs';
import { type ParseError, parse } from 'jsonc-parser';
import { agentLabel } from './agents';
import { HOSTS, type HostEnv, type HostId } from './hosts';
import {
  AGENTS,
  type Env,
  entryServer,
  type Registration,
  registration,
  SERVER_NAME,
  SKILL_NAME,
  storageId,
} from './writers';

/** AFD-195: the mcp.js our entry starts, and whether it is there. */
export interface ServerFile {
  path: string;
  exists: boolean;
}

const fileExists = (path: string) =>
  fs.stat(path).then(
    () => true,
    () => false,
  );

async function serverFile(server: string | undefined): Promise<ServerFile | undefined> {
  return server ? { path: server, exists: await fileExists(server) } : undefined;
}

export interface McpFileState {
  path: string;
  exists: boolean;
  /** Server names in it (mcpServers or servers). */
  servers: string[];
  /** Not JSON (with comments) the agent could read. */
  broken?: boolean;
  /** What our entry starts, when it starts an mcp.js. */
  ours?: ServerFile;
}

export interface FolderState {
  path: string;
  exists: boolean;
  /** Entries in it: skill or plugin folder names. */
  entries: string[];
}

export interface HostConfig {
  host: HostId;
  mcp: McpFileState[];
  skills: FolderState[];
  plugins?: FolderState;
}

async function mcpFile(path: string): Promise<McpFileState> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch {
    return { path, exists: false, servers: [] };
  }
  if (!text.trim()) return { path, exists: true, servers: [] };
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown> | null;
  if (errors.length > 0 || !data || typeof data !== 'object')
    return { path, exists: true, servers: [], broken: true };
  const table = (data.mcpServers ?? data.servers) as Record<string, unknown> | undefined;
  const ours = await serverFile(entryServer(table?.[SERVER_NAME]).server);
  return {
    path,
    exists: true,
    servers: table && typeof table === 'object' ? Object.keys(table).sort() : [],
    ...(ours ? { ours } : {}),
  };
}

/** How a registered server file reads in the report. */
function serverText(s: ServerFile, server?: string): string {
  const id = storageId(s.path);
  const other = id && server && storageId(server) && id !== storageId(server);
  return `starts \`${s.path}\`: ${s.exists ? (other ? `there, but another extension ID's copy (${id})` : 'there') : '**missing**'}`;
}

async function folder(path: string): Promise<FolderState> {
  try {
    const entries = await fs.readdir(path, { withFileTypes: true });
    return {
      path,
      exists: true,
      entries: entries
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name)
        .sort(),
    };
  } catch {
    return { path, exists: false, entries: [] };
  }
}

/** Each fork's MCP files, skill folders and plugin folder as they are now. */
export async function hostConfigs(
  env: HostEnv,
  hosts: HostId[] = ['cursor', 'antigravity', 'windsurf', 'kiro'],
): Promise<HostConfig[]> {
  return Promise.all(
    hosts.map(async (id) => {
      const info = HOSTS[id];
      const plugins = info.plugins?.(env);
      return {
        host: id,
        mcp: await Promise.all(info.mcp(env).map(mcpFile)),
        skills: await Promise.all(info.skills(env).map(folder)),
        ...(plugins ? { plugins: await folder(plugins) } : {}),
      };
    }),
  );
}

/**
 * Markdown lines for one editor's configuration; ours is marked, with the server file it starts.
 * `server`: this extension's installed copy, to tell another extension ID's copy.
 */
export function configLines(c: HostConfig, server?: string): string[] {
  const mark = (name: string) =>
    name === SERVER_NAME || name === SKILL_NAME ? `**${name}**` : name;
  const lines = [`### ${HOSTS[c.host].label} (${HOSTS[c.host].agent})`, ''];
  for (const f of c.mcp)
    lines.push(
      `- MCP \`${f.path}\`: ${
        !f.exists
          ? 'none'
          : f.broken
            ? 'not valid JSON'
            : f.servers.length
              ? f.servers.map(mark).join(', ')
              : 'no servers'
      }${f.ours ? `; ${SERVER_NAME} ${serverText(f.ours, server)}` : ''}`,
    );
  for (const s of c.skills)
    lines.push(
      `- Skills \`${s.path}\`: ${!s.exists ? 'none' : s.entries.map(mark).join(', ') || 'empty'}`,
    );
  if (c.plugins)
    lines.push(
      `- Plugins \`${c.plugins.path}\`: ${!c.plugins.exists ? 'none' : c.plugins.entries.join(', ') || 'empty'}`,
    );
  lines.push(`- Note: ${HOSTS[c.host].note}`, '');
  return lines;
}

/** AFD-195: each agent's ansible-flow entry as Set Up AI Assistants wrote it, and what it starts. */
export async function agentRegistrations(
  env: Env,
): Promise<{ registration: Registration | undefined; file?: ServerFile; agent: string }[]> {
  return Promise.all(
    AGENTS.map(async (agent) => {
      const r = await registration(agent, env);
      const file = await serverFile(r?.server);
      return { agent: agentLabel(agent), registration: r, ...(file ? { file } : {}) };
    }),
  );
}

/** Markdown lines for agentRegistrations; `server` is this extension's installed copy. */
export function registrationLines(
  found: Awaited<ReturnType<typeof agentRegistrations>>,
  server: string,
): string[] {
  return found.map(({ agent, registration: r, file }) => {
    if (!r) return `- ${agent}: not registered`;
    const where = `- ${agent} \`${r.file}\``;
    if (r.hand) return `${where}: written by hand; Set Up leaves it as it is`;
    if (!file) return `${where}: starts \`${r.command ?? '?'}\`, not an mcp.js`;
    return `${where}: ${serverText(file, server)}`;
  });
}
