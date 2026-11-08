// AFD-125: what a hostile repository, flow, playbook or clipboard must not be able to do. Each case
// is a finding of the 0.74.1 code review, kept as a regression test.
//
// AFD-166: the hostile-input suite is this file (the High findings, AFD-126..139) and three more:
// - modelReview.test.ts: self-referencing aliases (AFD-147), Jinja delimiters in titles (AFD-145),
//   keys that take over references (AFD-143);
// - ../webview/hostReview.test.ts: designer messages that fail or race (AFD-152, AFD-156);
// - lowReview.test.ts: NEL, LS, PS and C1 in flow files and exports (AFD-158), scenario inventory
//   injection and alias bombs in flow files (AFD-159), names Ansible refuses (AFD-160), AWX
//   transport (AFD-161), catalog files (AFD-163), webview messages and MCP paths (AFD-165).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { TOOL_SPECS } from '../../../src/core/ai/specs';
import { isLocalRoleName, roleStub } from '../../../src/core/drift/stub';
import { optionA } from '../../../src/core/engine/optionA';
import { commentLine, oneLine } from '../../../src/core/engine/yamlWriter';
import {
  createIdFactory,
  flowFileId,
  flowFileKey,
  isFileId,
  isFileKey,
} from '../../../src/core/flow/ids';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument } from '../../../src/core/flow/types';
import { parseAnsible } from '../../../src/core/import/read';
import { probeProcess, runProcess } from '../../../src/core/run/command';
import { redactLine, secretValues } from '../../../src/core/run/redact';
import { scenariosFileName } from '../../../src/core/scenario/scenarios';
import { FsFlowIO } from '../../../src/mcp/fsIO';
import { removeSkill, skillState, writeSkill } from '../../../src/node/ai/writers';
import { checkedManifest } from '../../../src/node/catalog/dumpFiles';
import {
  environmentSettings,
  userSettingsCandidates,
  workspaceEnvironmentAllowed,
} from '../../../src/node/env/userSettings';
import { stopStarted } from '../../../src/node/run/stop';
import { sharedFile, sharedSource } from '../../../src/node/sharedRefs';
import { readExample } from './helpers';

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'afd-hostile-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const write = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

describe('AFD-126: the MCP server does not run the environment a repository asks for', () => {
  it('looks for the user settings of VS Code and its forks, or the one named', () => {
    const win = userSettingsCandidates({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      home: 'C:\\Users\\u',
    });
    expect(win[0]).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'Code', 'User', 'settings.json'));
    expect(win.some((p) => p.includes('VSCodium'))).toBe(true);
    const mac = userSettingsCandidates({ platform: 'darwin', env: {}, home: '/Users/u' });
    expect(mac[0]).toBe(
      join('/Users/u', 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
    );
    const linux = userSettingsCandidates({ platform: 'linux', env: {}, home: '/home/u' });
    expect(linux[0]).toBe(join('/home/u', '.config', 'Code', 'User', 'settings.json'));
    expect(
      userSettingsCandidates({
        platform: 'linux',
        env: { AFD_USER_SETTINGS: '/x/settings.json' },
        home: '/home/u',
      }),
    ).toEqual(['/x/settings.json']);
  });

  it("ignores the workspace's environment keys unless the server is started with the opt-in", async () => {
    const home = temp();
    const root = temp();
    write(
      join(home, '.config', 'Code', 'User', 'settings.json'),
      '{ // the user\'s own\n "afd.environment.image": "afd-ee:2.19", "editor.fontSize": 14 }',
    );
    write(
      join(root, '.vscode', 'settings.json'),
      JSON.stringify({
        'afd.environment.image': 'evil/ee',
        'afd.environment.containerOptions': ['--privileged', '-v', '/:/host'],
        'ansible.executionEnvironment.volumeMounts': [{ src: '/', dest: '/host' }],
      }),
    );
    const host = { platform: 'linux' as const, env: {}, home };
    const plain = await environmentSettings(root, host);
    expect(plain.json).toEqual({ 'afd.environment.image': 'afd-ee:2.19' });
    expect(plain.ignoredWorkspace).toBe(true);
    expect(plain.sources).toHaveLength(1);

    const optedIn = await environmentSettings(root, {
      ...host,
      env: { AFD_MCP_WORKSPACE_ENVIRONMENT: '1' },
    });
    expect(optedIn.json['afd.environment.image']).toBe('evil/ee');
    expect(optedIn.ignoredWorkspace).toBe(false);
    expect(workspaceEnvironmentAllowed({ AFD_MCP_WORKSPACE_ENVIRONMENT: 'no' })).toBe(false);
  });

  it('runs scenarios with an empty ansible.cfg, so the repository config never loads', () => {
    const local = runProcess(
      { kind: 'local', python: 'python3', source: 'afd', label: 'local' },
      { root: '/repo', probe: '/ext/probe' },
      {
        playbook: '/w/1-x/x.yml',
        check: false,
        runDir: '/w/1-x',
        vault: false,
        hasConfig: false,
        emptyConfig: true,
      },
      'n',
    );
    expect(local.env.ANSIBLE_CONFIG).toBe('/w/1-x/ansible.cfg');
    const container = runProcess(
      {
        kind: 'container',
        engine: 'docker',
        image: 'afd-ee:2.19',
        options: [],
        mounts: [],
        source: 'afd',
        label: 'x',
      },
      { root: '/repo', probe: '/ext/probe' },
      {
        playbook: '/afd-run/x.yml',
        check: false,
        runDir: '/w/1-x',
        vault: false,
        hasConfig: true,
        emptyConfig: true,
      },
      'n',
    );
    expect(container.args).toContain('ANSIBLE_CONFIG=/afd-run/ansible.cfg');
    expect(container.args).not.toContain('ANSIBLE_CONFIG=/work/ansible.cfg');
  });

  it('says that verify runs programs (MCP openWorldHint)', () => {
    const spec = TOOL_SPECS.find((s) => s.name === 'flow_scenarios');
    expect(spec?.openWorld).toBe(true);
    expect(spec?.description).toMatch(/runs ansible-playbook/);
  });
});

describe('AFD-127: a planted skill manifest deletes nothing outside the skill folder', () => {
  const plant = (dir: string, files: Record<string, string>) =>
    write(join(dir, '.afd-skill.json'), JSON.stringify({ version: '0', files }));

  it('ignores names that leave the folder, and a manifest that does not read', async () => {
    const base = temp();
    const victim = join(base, 'victim.txt');
    write(victim, 'keep me');
    const dir = join(base, 'repo', '.claude', 'skills', 'ansible-flow');
    write(join(dir, 'SKILL.md'), '# ours');
    plant(dir, {
      'SKILL.md': 'x',
      '../../../../victim.txt': 'x',
      [victim]: 'x',
      'references/../../../../../victim.txt': 'x',
      'C:\\Windows\\x': 'x',
    });
    expect(await removeSkill(dir)).toBe(true);
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(false);

    write(join(dir, 'SKILL.md'), '# ours');
    write(join(dir, '.afd-skill.json'), '{"files": ');
    expect((await skillState(dir))?.foreign).toBe(true);
    expect(await removeSkill(dir)).toBe(false);
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
  });

  it('does not follow a link inside the folder, or a link in place of it', async () => {
    const base = temp();
    const outside = join(base, 'home', '.ssh');
    write(join(outside, 'id_ed25519'), 'secret');
    const dir = join(base, 'repo', '.claude', 'skills', 'ansible-flow');
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, 'references'), 'junction');
    plant(dir, { 'references/id_ed25519': 'x' });
    await removeSkill(dir);
    expect(existsSync(join(outside, 'id_ed25519'))).toBe(true);
    plant(dir, {});
    await expect(
      writeSkill(dir, { version: '1', files: { 'references/id_ed25519': 'overwritten' } }),
    ).rejects.toThrow(/outside/);

    const linked = join(base, 'repo', '.agents', 'skills', 'ansible-flow');
    mkdirSync(join(linked, '..'), { recursive: true });
    plant(outside, { id_ed25519: 'x' });
    symlinkSync(outside, linked, 'junction');
    expect((await skillState(linked))?.foreign).toBe(true);
    expect(await removeSkill(linked)).toBe(false);
    expect(existsSync(join(outside, 'id_ed25519'))).toBe(true);
  });
});

describe('AFD-128: a shared subflow source is a .flow.yaml inside the workspace folder', () => {
  it('refuses absolute, UNC, drive and device paths before touching the disk', () => {
    const flow = join('/ws', 'flows', 'a', 'a.flow.yaml');
    for (const path of [
      String.raw`\\attacker\share\x.flow.yaml`,
      '//attacker/share/x.flow.yaml',
      String.raw`C:\x.flow.yaml`,
      'c:x.flow.yaml',
      '/etc/x.flow.yaml',
      String.raw`\\.\pipe\x.flow.yaml`,
    ])
      expect(sharedFile(flow, path, '/ws').error).toBe('not a path relative to this flow');
    expect(sharedFile(flow, '/dev/zero', '/ws').error).toBe('not a .flow.yaml file');
    expect(sharedFile(flow, '../../../outside/x.flow.yaml', '/ws').error).toBe(
      'outside the workspace folder',
    );
  });

  it('reads a sibling flow, but not one through a link that leads out, a folder or a huge file', () => {
    const base = temp();
    const ws = join(base, 'ws');
    const flow = join(ws, 'flows', 'a', 'a.flow.yaml');
    write(join(ws, 'flows', 'b', 'b.flow.yaml'), 'flow: {key: b, version: 2}\nnodes: []\n');
    expect(sharedFile(flow, '../b/b.flow.yaml', ws).file).toBeDefined();
    expect(sharedSource(flow, '../b/b.flow.yaml#x', ws).error).toBe(
      '../b/b.flow.yaml has no subflow x',
    );

    write(join(base, 'elsewhere', 'c.flow.yaml'), 'flow: {key: c}\n');
    symlinkSync(join(base, 'elsewhere'), join(ws, 'flows', 'linked'), 'junction');
    expect(sharedFile(flow, '../linked/c.flow.yaml', ws).error).toBe(
      'outside the workspace folder',
    );

    mkdirSync(join(ws, 'flows', 'dir.flow.yaml'));
    expect(sharedSource(flow, '../dir.flow.yaml#x', ws).error).toBe('../dir.flow.yaml: not a file');
    write(join(ws, 'flows', 'big', 'big.flow.yaml'), `# ${'x'.repeat(2 * 1024 * 1024)}\n`);
    expect(sharedSource(flow, '../big/big.flow.yaml#x', ws).error).toBe(
      '../big/big.flow.yaml: larger than 2 MB',
    );
  });
});

describe('AFD-130: text from a flow cannot add YAML to the generated playbooks', () => {
  // Built from code points: PyYAML ends a line (and so a comment) at each of these.
  const NEL = String.fromCharCode(0x85);
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const evil = (sep: string) => `Backup${sep}- hosts: localhost${sep}  tasks: [{command: id}]`;
  const breaksOrControls = (text: string) =>
    [...text].filter((c) => {
      const code = c.charCodeAt(0);
      return (code < 0x20 && c !== '\n') || (code >= 0x7f && code <= 0x9f) || c === LS || c === PS;
    });
  const injectedPlays = (text: string) =>
    text
      .split('\n')
      .filter((l) => /^\s*-\s+hosts:\s+localhost/.test(l) || /^\s*-\s+hosts:\s+all/.test(l));

  const generate = (edit: (doc: FlowDocument) => void) => {
    const doc = parseYaml(readExample('edge-baseline.flow.yaml')) as FlowDocument;
    edit(doc);
    const result = optionA.generate(doc, { source: 'edge-baseline.flow.yaml' });
    expect(result.files.length).toBeGreaterThan(0);
    return result.files.map((f) => f.text).join('\n');
  };
  const node = (doc: FlowDocument, key: string) => {
    const n = doc.nodes.find((x) => x.key === key);
    if (!n) throw new Error(key);
    return n;
  };

  it.each([
    ['NEL', NEL],
    ['LS', LS],
    ['PS', PS],
    ['LF', '\n'],
    ['CR', '\r'],
  ])('a title with %s stays on its line', (_name, sep) => {
    const text = generate((doc) => {
      node(doc, 'backup-config').title = evil(sep);
      node(doc, 'precheck').intent = evil(sep);
    });
    expect(breaksOrControls(text)).toEqual([]);
    expect(injectedPlays(text)).toEqual([]);
  });

  it('a playbook ref, an inventory target and a parameter named $comment stay data', () => {
    const text = generate((doc) => {
      const step = node(doc, 'backup-config');
      step.impl = { kind: 'playbook', ref: `x.yml${NEL}- hosts: all${NEL}#` };
      step.settings = { ...step.settings, inventory_target: `web${NEL}- hosts: all` };
      node(doc, 'validate').impl = {
        kind: 'module',
        ref: 'ansible.builtin.debug',
        params: { msg: [{ $comment: 'x\n- hosts: all' }], $flow: 'x' },
      };
    });
    expect(breaksOrControls(text)).toEqual([]);
    expect(injectedPlays(text)).toEqual([]);
  });

  it('the drift stubs keep titles and names on their comment line', () => {
    const doc = parseYaml(readExample('edge-baseline.flow.yaml')) as FlowDocument;
    const step = node(doc, 'backup-config');
    step.title = evil(NEL);
    const files = roleStub(step, { key: 'edge-baseline', name: `Edge\n- hosts: all` }, 'backup');
    for (const f of files) {
      expect(breaksOrControls(f.text)).toEqual([]);
      expect(injectedPlays(f.text)).toEqual([]);
    }
  });

  it('oneLine and commentLine leave nothing that ends a line', () => {
    expect(oneLine(`a${NEL}b${LS}c${PS}d\r\ne\u0000f`)).toBe('a b c d e f');
    expect(commentLine(`  indented${NEL}x`)).toBe('#   indented x');
  });
});

describe('AFD-129: a YAML alias bomb in a playbook is refused, not expanded', () => {
  it('stops a billion-laughs file at the alias budget, quickly', () => {
    const lines = ['a0: &a0 [lol, lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
    for (let i = 1; i <= 9; i++) {
      const refs = Array.from({ length: 10 }, () => `*a${i - 1}`).join(', ');
      lines.push(`a${i}: &a${i} [${refs}]`);
    }
    const started = Date.now();
    const r = parseAnsible(lines.join('\n'));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/aliases expand to more than 100,000 values/);
  });

  it('still reads aliases, merge keys and a key named __proto__', () => {
    const r = parseAnsible(
      'base: &b {become: true, port: 22}\ntask: {<<: *b, port: 2222, __proto__: {x: 1}}\n',
    );
    const task = (r.value as Record<string, Record<string, unknown>>).task;
    expect(task).toMatchObject({ become: true, port: 2222 });
    expect(Object.getPrototypeOf(task)).toBe(Object.prototype);
    expect(Object.keys(task ?? {})).toContain('__proto__');
  });
});

describe('AFD-131: stopping a run, a scenario or a probe removes its container', () => {
  const container = {
    kind: 'container' as const,
    engine: 'podman' as const,
    image: 'afd-ee:2.19',
    options: [],
    mounts: [],
    source: 'afd' as const,
    label: 'x',
  };
  const paths = { root: '/repo', probe: '/ext/probe' };
  const request = { playbook: 'x.yml', check: false, runDir: '/r', vault: false, hasConfig: false };

  it('names the container in the stop command of every container process', () => {
    expect(runProcess(container, paths, request, 'afd-run-01abc').stop).toEqual({
      command: 'podman',
      args: ['rm', '-f', 'afd-run-01abc'],
    });
    expect(probeProcess(container, paths, 'afd-probe-1-1').stop?.args).toEqual([
      'rm',
      '-f',
      'afd-probe-1-1',
    ]);
    const local = { kind: 'local' as const, python: 'python3', source: 'afd' as const, label: 'l' };
    expect(runProcess(local, paths, request, 'n').stop).toBeUndefined();
  });

  it('ends a WSL run by its name, in two parts so the stopper never matches itself', () => {
    const wsl = { kind: 'wsl' as const, distro: 'Debian', label: 'wsl' };
    const spec = runProcess(wsl, paths, request, 'afd-run-01abc');
    expect(spec.args.at(-1)).toBe('afd-run-01abc');
    const stop = spec.stop?.args ?? [];
    expect(stop.slice(0, 5)).toEqual(['-d', 'Debian', '-e', 'sh', '-c']);
    expect(stop.slice(-3)).toEqual(['afd-stop', 'afd-run', '-01abc']);
    expect(stop.join(' ')).not.toContain('afd-run-01abc');
    // Not by process group: in WSL 1 separate sessions can share one (the stopper went with it).
    expect(stop[5]).toContain('pgrep -P');
    expect(stop[5]).not.toContain('-$g');
  });

  it('stopStarted never rejects, also when the engine is missing', async () => {
    await expect(
      stopStarted({
        command: 'x',
        args: [],
        env: {},
        stop: { command: 'afd-no-such-engine', args: [] },
      }),
    ).resolves.toBeUndefined();
    await expect(stopStarted({ command: 'x', args: [], env: {} })).resolves.toBeUndefined();
  });
});

describe('AFD-133: a flow key or ID from the file never names a path', () => {
  it('accepts slugs and ULIDs, and throws on anything else', () => {
    expect(flowFileKey('edge-baseline')).toBe('edge-baseline');
    expect(flowFileId('01JBX4Y5Z6A7B8C9D0E1F2G3H4')).toBe('01JBX4Y5Z6A7B8C9D0E1F2G3H4');
    for (const key of ['../../x', 'a/b', 'A', '', 'x.', 7, undefined])
      expect(() => flowFileKey(key)).toThrow(/not a lowercase slug/);
    for (const id of ['../../home/u/work', '01jbx4y5z6a7b8c9d0e1f2g3h4', 'F1', null])
      expect(() => flowFileId(id)).toThrow(/not a ULID/);
    expect(() => scenariosFileName('../../../Users/me/x')).toThrow(/not a lowercase slug/);
    expect(scenariosFileName('hello')).toBe('hello.scenarios.yaml');
    expect(isFileKey('../x')).toBe(false);
    expect(isFileId('01JBX4Y5Z6A7B8C9D0E1F2G3H4')).toBe(true);
  });
});

describe('AFD-134: catalog dump names from the environment stay in the cache', () => {
  it('fails the collections whose file is not <minor>/<ns>.<name>@<version>.json', () => {
    const cache = join(tmpdir(), 'afd-cache');
    const checked = checkedManifest(
      {
        core: '2.19.3',
        collections: [
          { name: 'ansible.builtin', version: '2.19.3', file: '2.19/ansible.builtin@2.19.3.json' },
          { name: 'ns.coll', version: '*', file: '2.19/ns.coll@*.json' },
          { name: 'evil.x', version: '1', file: '1.0/../../../../Users/x/Documents/a.json' },
          { name: 'evil.y', version: '1', file: '/etc/passwd' },
          { name: 'evil.z', version: '1', file: '2.19/../../x@1.json' },
        ],
      },
      cache,
    );
    expect(checked.collections.map((c) => [c.name, !c.error])).toEqual([
      ['ansible.builtin', true],
      ['ns.coll', true],
      ['evil.x', false],
      ['evil.y', false],
      ['evil.z', false],
    ]);
    expect(checked.collections.filter((c) => c.error).every((c) => c.file === '')).toBe(true);
  });
});

describe('AFD-135: Create Role makes one folder under roles/', () => {
  it('accepts plain and legacy Galaxy names, nothing that leaves roles/ or is a collection role', () => {
    for (const ok of ['backup', 'push_config', 'my-role', 'geerlingguy.docker'])
      expect(isLocalRoleName(ok)).toBe(true);
    for (const bad of ['../../x', 'a/b', 'ns.coll.role', '..', '.x', '', 'C:x', 'x\u0000'])
      expect(isLocalRoleName(bad)).toBe(false);
  });
});

describe('AFD-137: MCP writes do not follow links out of the roots', () => {
  const mcp = (root: string) => new FsFlowIO([root], createSchemaValidator(), createIdFactory());

  it('refuses a new flow under a linked folder that leads out', async () => {
    const base = temp();
    const ws = join(base, 'ws');
    const home = join(base, 'home');
    mkdirSync(ws, { recursive: true });
    mkdirSync(home, { recursive: true });
    symlinkSync(home, join(ws, 'flows'), 'junction');
    await expect(
      mcp(ws).create('flows/x/x.flow.yaml', 'flow: {key: x}\nnodes: []\n'),
    ).rejects.toThrow(/outside/);
    expect(existsSync(join(home, 'x'))).toBe(false);
  });

  it('refuses an export through a linked folder or onto a link', async () => {
    const base = temp();
    const ws = join(base, 'ws');
    const out = join(base, 'out');
    mkdirSync(ws, { recursive: true });
    mkdirSync(out, { recursive: true });
    symlinkSync(out, join(ws, 'exports'), 'junction');
    await expect(mcp(ws).writeExport('exports/a/b.svg', '<svg/>')).rejects.toThrow(/outside/);
    expect(existsSync(join(out, 'a'))).toBe(false);
    write(join(out, 'target.svg'), 'keep');
    let fileLinks = true;
    try {
      symlinkSync(join(out, 'target.svg'), join(ws, 'x.svg'), 'file');
    } catch {
      fileLinks = false; // Windows without Developer Mode: no file links to test with.
    }
    if (fileLinks) {
      await expect(mcp(ws).writeExport('x.svg', '<svg/>')).rejects.toThrow(/is a link/);
      expect(readFileSync(join(out, 'target.svg'), 'utf8')).toBe('keep');
    }
    expect(await mcp(ws).writeExport('plain/y.svg', '<svg/>')).toBe('plain/y.svg');
  });
});

describe('AFD-139: list and dict secrets are redacted by their parts', () => {
  it('finds the leaves, keeps the whole JSON, and scrubs a debug of one part', () => {
    const values = secretValues({ creds: { user: 'svc', password: 'leaf-pw-9' }, pins: [4711] });
    expect(values).toEqual(
      expect.arrayContaining(['leaf-pw-9', 'svc', '4711', '{"user":"svc","password":"leaf-pw-9"}']),
    );
    const line = JSON.stringify({ event: 'result', out: { msg: 'password is leaf-pw-9' } });
    expect(redactLine(line, values)).not.toContain('leaf-pw-9');
  });
});
