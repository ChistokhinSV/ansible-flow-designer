// AFD-19: Set Up AI Assistants against a temporary home and repository. Writes are idempotent,
// keep what the user wrote (comments, other servers, hand-written tables, their own folders), back
// config files up once, and Remove takes back only what setup wrote.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findAgents, mcpJson, otherAgentGuide } from '../../../../src/extension/ai/agents';
import {
  applySetup,
  type Env,
  type Launch,
  planSetup,
  removeSetup,
  type SkillFiles,
} from '../../../../src/extension/ai/writers';

const LAUNCH: Launch = {
  command: 'C:\\Program Files\\VS Code\\Code.exe',
  args: ['C:\\Users\\someone\\AppData\\Roaming\\Code\\User\\globalStorage\\afd\\mcp\\mcp.js'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};
const SKILL: SkillFiles = {
  version: '0.15.0',
  files: { 'SKILL.md': '---\nname: ansible-flow\n---\nRules\n', 'references/ops.md': '# Ops\n' },
};

let home: string;
let repo: string;
let calls: string[][];
let registered: string | undefined;

function env(): Env {
  return {
    home,
    repo,
    claude: async (args) => {
      calls.push(args);
      if (args[1] === 'get')
        return registered ? { code: 0, out: registered } : { code: 1, out: 'No MCP server' };
      if (args[1] === 'remove') {
        registered = undefined;
        return { code: 0, out: '' };
      }
      registered = args.join(' ');
      return { code: 0, out: 'Added' };
    },
  };
}

const read = (...p: string[]) => readFileSync(join(...p), 'utf8');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'afd-home-'));
  repo = mkdtempSync(join(tmpdir(), 'afd-repo-'));
  calls = [];
  registered = undefined;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// Temp homes, many files and a fake CLI: in a loaded full-suite run a test took over 5 s (91 ms alone).
describe('AI assistant setup', { timeout: 20_000 }, () => {
  it('writes skill copies and registrations once; a second run changes nothing', async () => {
    mkdirSync(join(home, '.gemini'));
    writeFileSync(
      join(home, '.gemini', 'settings.json'),
      '{\n  // my theme\n  "theme": "dark",\n  "mcpServers": {\n    "other": {"command": "x"}\n  }\n}\n',
    );
    mkdirSync(join(home, '.codex'));
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      'model = "o4"\n\n[mcp_servers.other]\ncommand = "y"\n',
    );
    const agents = ['claude', 'codex', 'gemini'] as const;
    const items = await planSetup([...agents], 'repo', env(), LAUNCH, SKILL);
    expect(items.map((i) => `${i.agent} ${i.what} ${i.action}`)).toEqual([
      'claude skill create',
      'claude mcp create',
      'codex skill create',
      'codex mcp create',
      'gemini mcp create',
    ]);
    await applySetup(items, env(), LAUNCH, SKILL);

    expect(read(repo, '.claude/skills/ansible-flow/SKILL.md')).toBe(SKILL.files['SKILL.md']);
    expect(read(repo, '.agents/skills/ansible-flow/references/ops.md')).toBe('# Ops\n');
    const toml = parseToml(read(home, '.codex/config.toml')) as {
      model: string;
      mcp_servers: Record<
        string,
        { command: string; args: string[]; env?: Record<string, string> }
      >;
    };
    expect(toml.model).toBe('o4');
    expect(toml.mcp_servers.other?.command).toBe('y');
    expect(toml.mcp_servers['ansible-flow']).toEqual({
      command: LAUNCH.command,
      args: LAUNCH.args,
      env: LAUNCH.env,
    });
    const gemini = read(home, '.gemini/settings.json');
    expect(gemini).toContain('// my theme');
    expect(gemini).toContain('"other"');
    expect(gemini).toContain('"ELECTRON_RUN_AS_NODE": "1"');
    expect(calls.at(-1)).toEqual([
      'mcp',
      'add',
      '-s',
      'user',
      'ansible-flow',
      '-e',
      'ELECTRON_RUN_AS_NODE=1',
      '--',
      LAUNCH.command,
      ...LAUNCH.args,
    ]);
    // Backups keep the files as they were before the first change.
    expect(read(home, '.codex/config.toml.afd-backup')).toBe(
      'model = "o4"\n\n[mcp_servers.other]\ncommand = "y"\n',
    );
    expect(read(home, '.gemini/settings.json.afd-backup')).toContain('// my theme');

    const again = await planSetup([...agents], 'repo', env(), LAUNCH, SKILL);
    expect(again.map((i) => i.action)).toEqual(Array(5).fill('unchanged'));
    const codex = read(home, '.codex/config.toml');
    await applySetup(again, env(), LAUNCH, SKILL);
    expect(read(home, '.codex/config.toml')).toBe(codex);
  });

  it('a new version updates; edited copies are named; foreign folders and hand-written tables stay', async () => {
    await applySetup(
      await planSetup(['claude'], 'user', env(), LAUNCH, SKILL),
      env(),
      LAUNCH,
      SKILL,
    );
    writeFileSync(join(home, '.claude/skills/ansible-flow/SKILL.md'), 'my own rules\n');
    const next = { version: '0.16.0', files: { ...SKILL.files, 'examples.md': '# Examples\n' } };
    const items = await planSetup(['claude'], 'user', env(), LAUNCH, next);
    expect(items[0]).toMatchObject({
      action: 'update',
      note: 'you changed SKILL.md; it will be replaced',
    });

    mkdirSync(join(home, '.agents/skills/ansible-flow'), { recursive: true });
    writeFileSync(join(home, '.agents/skills/ansible-flow/SKILL.md'), 'not ours\n');
    mkdirSync(join(home, '.codex'));
    writeFileSync(
      join(home, '.codex/config.toml'),
      '[mcp_servers.ansible-flow]\ncommand = "mine"\n',
    );
    const codex = await planSetup(['codex'], 'user', env(), LAUNCH, SKILL);
    expect(codex.map((i) => i.action)).toEqual(['skip', 'skip']);
    await applySetup(codex, env(), LAUNCH, SKILL);
    expect(read(home, '.agents/skills/ansible-flow/SKILL.md')).toBe('not ours\n');
    expect(read(home, '.codex/config.toml')).toBe('[mcp_servers.ansible-flow]\ncommand = "mine"\n');
  });

  it('Remove takes back only what setup wrote', async () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex/config.toml'), 'model = "o4"\n');
    mkdirSync(join(home, '.gemini'));
    writeFileSync(join(home, '.gemini/settings.json'), '{\n  // keep\n  "theme": "dark"\n}\n');
    const agents = ['claude', 'codex', 'gemini'] as const;
    await applySetup(
      await planSetup([...agents], 'user', env(), LAUNCH, SKILL),
      env(),
      LAUNCH,
      SKILL,
    );
    writeFileSync(join(home, '.claude/skills/ansible-flow/notes.md'), 'mine\n');

    const removed = await removeSetup([...agents], env());
    expect(removed.map((i) => `${i.agent} ${i.what}`).sort()).toEqual(
      [
        'claude mcp',
        'claude skill',
        'codex mcp',
        'codex skill',
        'gemini mcp',
        'gemini skill',
      ].sort(),
    );
    expect(read(home, '.claude/skills/ansible-flow/notes.md')).toBe('mine\n');
    expect(existsSync(join(home, '.claude/skills/ansible-flow/SKILL.md'))).toBe(false);
    expect(existsSync(join(home, '.agents/skills/ansible-flow'))).toBe(false);
    expect(read(home, '.codex/config.toml')).toBe('model = "o4"\n');
    const gemini = read(home, '.gemini/settings.json');
    expect(gemini).toContain('// keep');
    expect(gemini).not.toContain('ansible-flow');
    expect(registered).toBeUndefined();
    expect(await removeSetup([...agents], env())).toEqual([]);
  });

  it('AFD-20: OpenCode, ZCode, Copilot CLI and Cursor get one key each; shared skill folders are written once', async () => {
    mkdirSync(join(home, '.config/opencode'), { recursive: true });
    // A trailing comma and a comment, as OpenCode's own JSONC allows.
    writeFileSync(
      join(home, '.config/opencode/opencode.jsonc'),
      '{\n  // mine\n  "$schema": "https://opencode.ai/config.json",}',
    );
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor/mcp.json'), '{ "mcpServers": { oops');
    const agents = ['opencode', 'zcode', 'copilot', 'cursor'] as const;
    const items = await planSetup([...agents], 'user', env(), LAUNCH, SKILL);
    expect(items.map((i) => `${i.agent} ${i.what} ${i.action}`)).toEqual([
      'opencode skill create',
      'opencode mcp create',
      'zcode mcp create',
      'copilot skill create',
      'copilot mcp create',
      'cursor skill create',
      'cursor mcp skip',
    ]);
    expect(items.map((i) => i.target.slice(home.length).replaceAll('\\', '/'))).toEqual([
      '/.agents/skills/ansible-flow',
      '/.config/opencode/opencode.jsonc',
      '/.agents/mcp.json',
      '/.copilot/skills/ansible-flow',
      '/.copilot/mcp-config.json',
      '/.claude/skills/ansible-flow',
      '/.cursor/mcp.json',
    ]);
    await applySetup(items, env(), LAUNCH, SKILL);

    const opencode = read(home, '.config/opencode/opencode.jsonc');
    expect(opencode).toContain('// mine');
    expect(parseJsonc(opencode).mcp['ansible-flow']).toEqual({
      type: 'local',
      command: [LAUNCH.command, ...LAUNCH.args],
      environment: LAUNCH.env,
      enabled: true,
    });
    expect(JSON.parse(read(home, '.agents/mcp.json')).mcpServers['ansible-flow']).toEqual({
      command: LAUNCH.command,
      args: LAUNCH.args,
      env: LAUNCH.env,
    });
    expect(JSON.parse(read(home, '.copilot/mcp-config.json')).mcpServers['ansible-flow']).toEqual({
      type: 'local',
      command: LAUNCH.command,
      args: LAUNCH.args,
      env: LAUNCH.env,
      tools: ['*'],
    });
    expect(read(home, '.cursor/mcp.json')).toBe('{ "mcpServers": { oops');
    expect(read(home, '.claude/skills/ansible-flow/SKILL.md')).toBe(SKILL.files['SKILL.md']);

    const again = await planSetup([...agents], 'user', env(), LAUNCH, SKILL);
    expect(again.filter((i) => i.action !== 'unchanged').map((i) => i.agent)).toEqual(['cursor']);

    const removed = await removeSetup([...agents], env());
    expect(removed.map((i) => `${i.agent} ${i.what}`)).toEqual([
      'opencode skill',
      'opencode mcp',
      'zcode mcp',
      'copilot skill',
      'copilot mcp',
      'cursor skill',
    ]);
    const left = read(home, '.config/opencode/opencode.jsonc');
    expect(left).toContain('"$schema"');
    expect(left).not.toContain('ansible-flow');
  });

  it('AFD-20: agents are found by program, extension, config folder or app; others get a guide', async () => {
    mkdirSync(join(home, '.codex'));
    mkdirSync(join(home, '.config/opencode'), { recursive: true });
    const local = join(repo, 'AppData');
    mkdirSync(join(local, 'Programs/ZCode'), { recursive: true });
    writeFileSync(join(local, 'Programs/ZCode/ZCode.exe'), '');
    const found = await findAgents({
      home,
      localAppData: local,
      platform: 'win32',
      onPath: async (name) => (name === 'gemini' ? 'C:\\tools\\gemini.cmd' : undefined),
      extensions: ['anthropic.claude-code'],
    });
    expect(Object.fromEntries(found)).toEqual({
      claude: 'VS Code extension anthropic.claude-code',
      codex: '~/.codex',
      gemini: 'gemini on PATH',
      opencode: '~/.config/opencode',
      zcode: 'ZCode app',
    });
    const guide = otherAgentGuide(LAUNCH);
    expect(guide).toContain(mcpJson(LAUNCH));
    expect(JSON.parse(mcpJson(LAUNCH)).mcpServers['ansible-flow'].env).toEqual(LAUNCH.env);
    expect(guide).toContain('ELECTRON_RUN_AS_NODE=1 "C:\\Program Files\\VS Code\\Code.exe"');
  });

  it('without the claude CLI the registration is shown as a command to run', async () => {
    const items = await planSetup(['claude'], 'user', { home }, LAUNCH, SKILL);
    expect(items[1]).toMatchObject({ action: 'skip' });
    expect(items[1]?.target).toBe(
      'claude mcp add -s user ansible-flow -e ELECTRON_RUN_AS_NODE=1 -- "C:\\Program Files\\VS Code\\Code.exe" C:\\Users\\someone\\AppData\\Roaming\\Code\\User\\globalStorage\\afd\\mcp\\mcp.js',
    );
  });
});
