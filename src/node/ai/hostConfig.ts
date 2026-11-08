// What each editor's agent is configured with on this machine (AFD-172): MCP servers by name, the
// skills in its folders and its plugin bundles. Read-only, names only: a server entry's command,
// arguments and environment (tokens) are never read out.
import { promises as fs } from 'node:fs';
import { type ParseError, parse } from 'jsonc-parser';
import { HOSTS, type HostEnv, type HostId } from './hosts';
import { SERVER_NAME, SKILL_NAME } from './writers';

export interface McpFileState {
  path: string;
  exists: boolean;
  /** Server names in it (mcpServers or servers). */
  servers: string[];
  /** Not JSON (with comments) the agent could read. */
  broken?: boolean;
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
  return {
    path,
    exists: true,
    servers: table && typeof table === 'object' ? Object.keys(table).sort() : [],
  };
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

/** Markdown lines for one editor's configuration; ours is marked. */
export function configLines(c: HostConfig): string[] {
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
      }`,
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
