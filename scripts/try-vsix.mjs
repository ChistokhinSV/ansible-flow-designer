// Replaces the installed Ansible Flow Designer in the editors on this machine with the build to
// test (RELEASING.md, docs/testing/release-test-plan.md):
//
//   node scripts/try-vsix.mjs 1.0.1-rc.2   the candidate's VSIX from its GitHub pre-release
//   node scripts/try-vsix.mjs local        a VSIX built from this checkout (just package)
//   node scripts/try-vsix.mjs out/x.vsix   a VSIX file
//   node scripts/try-vsix.mjs release      back to the released version (Marketplace / Open VSX)
//
// Options: --editors code,antigravity (default: every one found). Each editor gets the VSIX with
// --force (also the same or an older version), and the script says which version each now has.
// Open windows keep the old one until Developer: Reload Window.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ID = 'chistokhinsv.ansible-flow-designer';
const REPO = 'ChistokhinSV/ansible-flow-designer';
const local = process.env.LOCALAPPDATA ?? '';

/** The editors built on VS Code this machine has, by their command-line tool. */
const EDITORS = [
  {
    key: 'code',
    name: 'VS Code',
    cli: [join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'), 'code'],
    env: {},
  },
  {
    key: 'antigravity',
    name: 'Antigravity IDE',
    cli: [join(local, 'Programs', 'Antigravity IDE', 'bin', 'antigravity-ide.cmd')],
    // Its own HTTPS calls abort with these set (they come from some shells' Node settings).
    env: { NODE_EXTRA_CA_CERTS: undefined, NODE_USE_SYSTEM_CA: undefined },
  },
];

function fail(message) {
  console.error(`try-vsix: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const at = args.indexOf('--editors');
const only = at >= 0 ? args.splice(at, 2)[1]?.split(',') : undefined;
const what = args[0];
if (!what)
  fail('say what to install: a candidate version (1.0.1-rc.2), local, a .vsix file, or release');

function run(cli, argv, env) {
  const merged = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  // The .cmd launchers need a shell on Windows, which splits on spaces: each part is quoted. The
  // arguments are ours (a path, the extension id, flags), never a quote in them.
  const shell = cli.endsWith('.cmd');
  const q = (s) => (shell ? `"${s}"` : s);
  const r = spawnSync(q(cli), argv.map(q), {
    env: merged,
    encoding: 'utf8',
    shell,
    timeout: 180_000,
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function cliOf(editor) {
  for (const c of editor.cli) {
    if (c.includes('\\') || c.includes('/')) {
      if (existsSync(c)) return c;
    } else if (run(c, ['--version'], {}).ok) return c;
  }
  return undefined;
}

/** The VSIX to install, or the extension id for the released version. */
function source() {
  if (what === 'release') return ID;
  if (what === 'local') {
    console.log('Building the VSIX from this checkout (just package)…');
    execFileSync('just', ['package'], { stdio: 'inherit' });
    const version = JSON.parse(
      execFileSync('node', ['-p', 'JSON.stringify(require("./package.json").version)'], {
        encoding: 'utf8',
      }),
    );
    const file = resolve('out', `ansible-flow-designer-${version}.vsix`);
    if (!existsSync(file)) fail(`just package did not write ${file}`);
    return file;
  }
  if (what.endsWith('.vsix')) {
    if (!existsSync(what)) fail(`no such file: ${what}`);
    return resolve(what);
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(what)) fail(`not a version: ${what}`);
  const dir = resolve('out', 'candidates', what);
  mkdirSync(dir, { recursive: true });
  console.log(`Downloading the VSIX of v${what} from ${REPO}…`);
  execFileSync(
    'gh',
    [
      'release',
      'download',
      `v${what}`,
      '--repo',
      REPO,
      '--pattern',
      '*.vsix',
      '--dir',
      dir,
      '--clobber',
    ],
    { stdio: 'inherit' },
  );
  const vsix = readdirSync(dir).find((f) => f.endsWith('.vsix'));
  if (!vsix) fail(`the release v${what} has no VSIX`);
  return join(dir, vsix);
}

const from = source();
let installed = 0;
for (const editor of EDITORS) {
  if (only && !only.includes(editor.key)) continue;
  const cli = cliOf(editor);
  if (!cli) {
    console.log(`${editor.name}: not found, skipped`);
    continue;
  }
  const done = run(cli, ['--install-extension', from, '--force'], editor.env);
  if (!done.ok) {
    console.log(`${editor.name}: the install failed:\n${done.out}`);
    continue;
  }
  const list = run(cli, ['--list-extensions', '--show-versions'], editor.env).out;
  const now = list.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${ID}@`));
  console.log(`${editor.name}: ${now ? now.split('@')[1] : 'installed (version not listed)'}`);
  installed++;
}
if (installed === 0) fail('no editor took it');
console.log('Reload the open windows (Developer: Reload Window) to use it.');
