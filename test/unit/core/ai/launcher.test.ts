// AFD-195: the server copy in global storage. Each file lands by rename (an agent never starts a
// half-copied mcp.js); what mcp.js loads goes first and the stamp last; nothing is copied when the
// source did not change; probe/ goes along, since flow_scenarios runs Ansible with the
// probe/ beside the running mcp.js (FsFlowIO.verifyScenarios: join(__dirname, 'probe')).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installServer } from '../../../../src/extension/ai/launcher';

let root: string;
let ext: string;
let storage: string;

const context = () =>
  ({
    extensionUri: { fsPath: ext },
    globalStorageUri: { fsPath: storage },
  }) as unknown as Parameters<typeof installServer>[0];
const dist = (...p: string[]) => join(ext, 'dist', ...p);
const copy = (...p: string[]) => join(storage, 'mcp', ...p);
const text = (path: string) => readFileSync(path, 'utf8');

/** Every file under a folder, relative, with posix separators. */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(relative(dir, join(d, e.name)).replaceAll('\\', '/'));
  };
  walk(dir);
  return out.sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'afd-install-'));
  ext = join(root, 'ext');
  storage = join(root, 'storage');
  mkdirSync(dist('probe', 'callback_plugins'), { recursive: true });
  mkdirSync(dist('probe', 'afd_probe'), { recursive: true });
  writeFileSync(dist('mcp.js'), 'require("./elk.js"); // v1\n');
  writeFileSync(dist('elk.js'), 'module.exports = 1;\n');
  writeFileSync(dist('probe', 'callback_plugins', 'afd_events.py'), '# events\n');
  writeFileSync(dist('probe', 'afd_probe', '__init__.py'), '# probe\n');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('installServer', () => {
  it('copies beside each target and renames: elk.js and probe/ before mcp.js, the stamp last', async () => {
    const events: string[] = [];
    const show = (p: unknown) => relative(copy(), String(p)).replaceAll('\\', '/');
    const copyFile = promises.copyFile.bind(promises);
    const rename = promises.rename.bind(promises);
    vi.spyOn(promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      events.push(`copy ${show(to)}`);
      return copyFile(from, to, mode);
    });
    vi.spyOn(promises, 'rename').mockImplementation(async (from, to) => {
      events.push(`rename ${show(from)} -> ${show(to)}`);
      return rename(from, to);
    });

    expect(await installServer(context())).toBe(copy('mcp.js'));

    // Nothing is ever copied straight onto a name an agent starts or Ansible loads.
    const copies = events.filter((e) => e.startsWith('copy '));
    expect(copies.length).toBe(4);
    for (const c of copies) expect(c).toMatch(/^copy (\S+\.tmp|probe\.\S+\.new\/\S+)$/);
    // In place by rename, in this order.
    const landed = events
      .filter((e) => e.startsWith('rename '))
      .map((e) => e.split(' -> ')[1])
      .filter((to) => !/\.old$/.test(to ?? ''));
    expect(landed).toEqual(['elk.js', 'probe', 'mcp.js', 'installed.json']);
    // Nothing left over; the probe is where the installed mcp.js looks for it.
    expect(files(copy())).toEqual([
      'elk.js',
      'installed.json',
      'mcp.js',
      'probe/afd_probe/__init__.py',
      'probe/callback_plugins/afd_events.py',
    ]);
    expect(text(copy('mcp.js'))).toBe(text(dist('mcp.js')));
    const stamp = JSON.parse(text(copy('installed.json'))) as Record<string, { size: number }>;
    expect(Object.keys(stamp).sort()).toEqual(['elk.js', 'mcp.js', 'probe']);
  });

  it('copies nothing when the source did not change; a changed or damaged copy is copied again', async () => {
    await installServer(context());
    // Same size, other text: only a copy would bring the source's text back.
    writeFileSync(copy('mcp.js'), 'require("./elk.js"); // v9\n');
    // Python may write bytecode next to the probe; that is not a change.
    mkdirSync(copy('probe', 'callback_plugins', '__pycache__'));
    writeFileSync(copy('probe', 'callback_plugins', '__pycache__', 'afd_events.pyc'), 'x');
    const copyFile = vi.spyOn(promises, 'copyFile');
    await installServer(context());
    expect(copyFile).not.toHaveBeenCalled();
    expect(text(copy('mcp.js'))).toContain('v9');

    // A new build: mcp.js only.
    writeFileSync(dist('mcp.js'), 'require("./elk.js"); // v2, longer\n');
    await installServer(context());
    expect(text(copy('mcp.js'))).toBe(text(dist('mcp.js')));
    expect(copyFile).toHaveBeenCalledTimes(1);

    // A probe file gone from the copy: the probe again, nothing else.
    rmSync(copy('probe', 'callback_plugins', 'afd_events.py'));
    await installServer(context());
    expect(existsSync(copy('probe', 'callback_plugins', 'afd_events.py'))).toBe(true);
    expect(copyFile).toHaveBeenCalledTimes(3);
  });

  it('adds the probe to a copy made before it went along', async () => {
    await installServer(context());
    const stamp = JSON.parse(text(copy('installed.json'))) as Record<string, unknown>;
    delete stamp.probe;
    writeFileSync(copy('installed.json'), JSON.stringify(stamp));
    rmSync(copy('probe'), { recursive: true });
    const copyFile = vi.spyOn(promises, 'copyFile');
    await installServer(context());
    expect(files(copy('probe'))).toEqual([
      'afd_probe/__init__.py',
      'callback_plugins/afd_events.py',
    ]);
    expect(copyFile.mock.calls.map((c) => String(c[1]))).not.toContainEqual(
      expect.stringMatching(/mcp\.js\./),
    );
  });

  it('copies once when asked twice at once', async () => {
    const copyFile = vi.spyOn(promises, 'copyFile');
    const [a, b] = await Promise.all([installServer(context()), installServer(context())]);
    expect(a).toBe(b);
    expect(copyFile).toHaveBeenCalledTimes(4);
  });

  it('a failed rename keeps the old copy, leaves no temporary file and no stamp for it', async () => {
    await installServer(context());
    const before = text(copy('mcp.js'));
    const stamp = text(copy('installed.json'));
    writeFileSync(dist('mcp.js'), 'require("./elk.js"); // v2, longer\n');
    const rename = promises.rename.bind(promises);
    vi.spyOn(promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('mcp.js'))
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      return rename(from, to);
    });
    await expect(installServer(context())).rejects.toThrow('cross-device link');
    expect(text(copy('mcp.js'))).toBe(before);
    expect(text(copy('installed.json'))).toBe(stamp);
    expect(files(copy()).filter((f) => /\.(tmp|new|old)\b/.test(f))).toEqual([]);
  });
});
