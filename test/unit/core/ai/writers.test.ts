// AFD-19: Set Up AI Assistants against a temporary home and repository. Writes are idempotent,
// keep what the user wrote (comments, other servers, hand-written tables, their own folders), back
// config files up once, and Remove takes back only what setup wrote.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('AI assistant setup', () => {
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

  it('without the claude CLI the registration is shown as a command to run', async () => {
    const items = await planSetup(['claude'], 'user', { home }, LAUNCH, SKILL);
    expect(items[1]).toMatchObject({ action: 'skip' });
    expect(items[1]?.target).toBe(
      'claude mcp add -s user ansible-flow -e ELECTRON_RUN_AS_NODE=1 -- "C:\\Program Files\\VS Code\\Code.exe" C:\\Users\\someone\\AppData\\Roaming\\Code\\User\\globalStorage\\afd\\mcp\\mcp.js',
    );
  });
});
