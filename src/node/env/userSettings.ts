// Where the MCP server takes its Ansible environment from (AFD-126). The image, container options,
// mounts and interpreter decide what runs on this machine, so they come from the user's own VS Code
// settings. A workspace's .vscode/settings.json is repository content: VS Code ignores these keys
// there until the workspace is trusted, and the server has no trust prompt, so it reads them only
// when the user starts it with AFD_MCP_WORKSPACE_ENVIRONMENT=1.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getNodeValue, parseTree } from 'jsonc-parser';

/** VS Code and the forks the setup registers the server for, in the order they are tried. */
const PRODUCTS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];

/** The settings keys that choose the environment (package.json's restrictedConfigurations). */
export const ENVIRONMENT_KEYS = [
  'afd.environment.kind',
  'afd.environment.image',
  'afd.environment.containerEngine',
  'afd.environment.containerOptions',
  'afd.environment.python',
  'afd.environment.wslDistro',
  // AFD-252: without these an SSH environment had a kind and no host.
  'afd.environment.sshHost',
  'afd.environment.sshDir',
  'ansible.executionEnvironment.enabled',
  'ansible.executionEnvironment.image',
  'ansible.executionEnvironment.containerEngine',
  'ansible.executionEnvironment.containerOptions',
  'ansible.executionEnvironment.volumeMounts',
  'ansible.python.interpreterPath',
] as const;

export interface SettingsHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

const thisHost = (): SettingsHost => ({
  platform: process.platform,
  env: process.env,
  home: homedir(),
});

/** User settings.json files to try; AFD_USER_SETTINGS names one explicitly. */
export function userSettingsCandidates(host: SettingsHost): string[] {
  if (host.env.AFD_USER_SETTINGS) return [host.env.AFD_USER_SETTINGS];
  const base =
    host.platform === 'win32'
      ? (host.env.APPDATA ?? join(host.home, 'AppData', 'Roaming'))
      : host.platform === 'darwin'
        ? join(host.home, 'Library', 'Application Support')
        : (host.env.XDG_CONFIG_HOME ?? join(host.home, '.config'));
  return PRODUCTS.map((p) => join(base, p, 'User', 'settings.json'));
}

export const workspaceEnvironmentAllowed = (env: NodeJS.ProcessEnv): boolean =>
  /^(1|true|yes)$/i.test(env.AFD_MCP_WORKSPACE_ENVIRONMENT ?? '');

async function readSettings(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const tree = parseTree(await fs.readFile(path, 'utf8'));
    const value = tree ? getNodeValue(tree) : undefined;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const environmentOnly = (json: Record<string, unknown>) =>
  Object.fromEntries(ENVIRONMENT_KEYS.filter((k) => k in json).map((k) => [k, json[k]]));

export interface EnvironmentSettings {
  /** The environment keys, the workspace's over the user's when the workspace is allowed. */
  json: Record<string, unknown>;
  /** The settings files the keys came from. */
  sources: string[];
  /** The workspace sets environment keys that were not used (no opt-in). */
  ignoredWorkspace: boolean;
}

/** The environment settings for a root: the first user settings.json found, then the workspace's. */
export async function environmentSettings(
  root: string,
  host: SettingsHost = thisHost(),
): Promise<EnvironmentSettings> {
  const sources: string[] = [];
  let json: Record<string, unknown> = {};
  for (const path of userSettingsCandidates(host)) {
    const user = await readSettings(path);
    if (!user) continue;
    json = environmentOnly(user);
    sources.push(path);
    break;
  }
  const workspacePath = join(root, '.vscode', 'settings.json');
  const workspace = environmentOnly((await readSettings(workspacePath)) ?? {});
  const used = Object.keys(workspace).length > 0 && workspaceEnvironmentAllowed(host.env);
  if (used) {
    json = { ...json, ...workspace };
    sources.push(workspacePath);
  }
  return {
    json,
    sources,
    ignoredWorkspace: Object.keys(workspace).length > 0 && !used,
  };
}

/**
 * `afd.canvas.direction` for a root (AFD-192), so the MCP tools lay out unplaced nodes as the
 * canvas does: the workspace's .vscode/settings.json, else the first user settings.json found
 * (VS Code's order). Not a restricted key: it only places boxes. TB when neither sets it.
 */
export async function canvasDirection(
  root: string,
  host: SettingsHost = thisHost(),
): Promise<'TB' | 'LR'> {
  const workspace = await readSettings(join(root, '.vscode', 'settings.json'));
  let value = workspace?.['afd.canvas.direction'];
  if (value === undefined)
    for (const path of userSettingsCandidates(host)) {
      const user = await readSettings(path);
      if (!user) continue;
      value = user['afd.canvas.direction'];
      break;
    }
  return value === 'LR' ? 'LR' : 'TB';
}
