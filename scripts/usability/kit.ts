// Usability session kit (AFD-78). Prepares a session folder (a VS Code profile and extensions folder
// of its own, the VSIX, the fictional workspace as a Git repository), starts VS Code there and serves
// the task runner on 127.0.0.1. The runner saves progress here as it goes, asks for the coding agent's
// edit in T11 (round 3: the colleague's change in T16) and, at the end, gets the verifier's
// results. Nothing leaves the machine. Variants A and B run rounds 1-2, C runs round 3 (studies.ts).
//
//   kit <round> <a|b|c> <vsix> [--image afd-ee:2.19] [--port 5199] [--no-launch]  new session
//   kit serve <session>                                                           reopen a session
//   kit verify <session>                                                          check it again
//   kit solve <session>                                                           self-test: the file-checked tasks
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { basename, join, resolve } from 'node:path';
import runnerHtml from './runner.html';
import { studyOf } from './studies';
import type { SessionDirs } from './study';
import { SUS, susScore } from './tasks';
import type { Check } from './verify';

const EXTENSION = 'afd-dev.ansible-flow-designer';
const SESSIONS = 'C:\\DOWNLOADS_TEMP\\afd-usability';
const pad = (n: number) => String(n).padStart(2, '0');

function log(msg: string) {
  const d = new Date();
  console.log(
    `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}] ${msg}`,
  );
}

interface Session {
  id: string;
  round: string;
  variant: string;
  vsix: string;
  version: string;
  image: string;
  port: number;
  token: string;
  created: string;
  /** The file the kit changed outside the designer, once it has (T11, round 3 T16). */
  outsideEdit?: string;
  outsideMessage?: string;
  outsideFacts?: Record<string, unknown>;
}

const paths = (dir: string) => ({
  session: join(dir, 'session.json'),
  progress: join(dir, 'progress.json'),
  results: join(dir, 'results.json'),
  summary: join(dir, 'summary.md'),
  workspace: join(dir, 'workspace'),
  profile: join(dir, 'profile'),
  extensions: join(dir, 'extensions'),
  storage: join(dir, 'profile', 'User', 'globalStorage', EXTENSION),
});

const dirsOf = (dir: string): SessionDirs => {
  const p = paths(dir);
  return { workspace: p.workspace, profile: p.profile, storage: p.storage };
};

function writeJson(file: string, data: unknown) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

const readJson = <T>(file: string): T | undefined =>
  existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;

function git(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
}

/** The VS Code CLI: code.cmd on Windows needs a shell, so the kit quotes the line itself. */
function code(args: string[], wait: boolean) {
  const line = [
    'code',
    ...args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)),
  ].join(' ');
  if (wait) {
    const r = spawnSync(line, { shell: true, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`code ${args[0]}: ${r.stderr || r.stdout}`);
    return;
  }
  spawn(line, { shell: true, detached: true, stdio: 'ignore' }).unref();
}

function vsixVersion(vsix: string): string {
  return /-(\d+\.\d+\.\d+)\.vsix$/.exec(basename(vsix))?.[1] ?? 'unknown';
}

async function prepare(round: string, variant: string, vsix: string, opts: Map<string, string>) {
  const study = studyOf(variant);
  if (!existsSync(vsix)) throw new Error(`no VSIX at ${vsix} (just package builds one)`);
  const image = opts.get('--image') ?? 'afd-ee:2.19';
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0)
    throw new Error(
      `Docker image ${image} not found: start Docker Desktop, or build it with just ee-build 2.19`,
    );
  const d = new Date();
  const id = `r${round}-${variant}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dir = join(SESSIONS, id);
  if (existsSync(dir)) throw new Error(`${dir} exists; wait a minute or remove it`);
  const p = paths(dir);
  for (const x of [p.workspace, join(p.profile, 'User'), p.extensions])
    mkdirSync(x, { recursive: true });

  log(`Session ${id}: workspace (variant ${variant.toUpperCase()})`);
  git(p.workspace, ['init', '-q', '-b', 'main']);
  // A fictional author: decisions and audit entries name this user, never the participant.
  git(p.workspace, ['config', 'user.name', 'P1 (usability session)']);
  git(p.workspace, ['config', 'user.email', 'p1@usability.example']);
  for (const line of await study.build(p.workspace)) log(`  ${line}`);
  git(p.workspace, ['add', '-A']);
  git(p.workspace, [
    '-c',
    'user.name=NetOps Lab',
    '-c',
    'user.email=netops@lab.example',
    'commit',
    '-q',
    '-m',
    'Lab automation flows',
  ]);

  writeJson(join(p.profile, 'User', 'settings.json'), {
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'workbench.enableExperiments': false,
    'git.openRepositoryInParentFolders': 'never',
    // Runs need Ansible: the lab image, as Set Up Ansible Environment would set it.
    'afd.environment.image': image,
  });
  log(`Installing ${basename(vsix)} into the session's own extensions folder`);
  code(
    [
      '--user-data-dir',
      p.profile,
      '--extensions-dir',
      p.extensions,
      '--install-extension',
      resolve(vsix),
    ],
    true,
  );
  const session: Session = {
    id,
    round,
    variant,
    vsix: basename(vsix),
    version: vsixVersion(vsix),
    image,
    port: Number(opts.get('--port') ?? 5199),
    token: randomBytes(16).toString('hex'),
    created: d.toISOString(),
  };
  writeJson(p.session, session);
  return dir;
}

function launch(dir: string, s: Session) {
  const p = paths(dir);
  log('Starting VS Code with the session profile');
  code(
    ['--user-data-dir', p.profile, '--extensions-dir', p.extensions, '--new-window', p.workspace],
    false,
  );
  const url = `http://127.0.0.1:${s.port}/`;
  log(`Opening the task runner at ${url}`);
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

interface Progress {
  answers?: Record<string, string>;
  tasks?: Record<string, { ms?: number; outcome?: string; success?: string; seq?: number }>;
  sus?: (number | undefined)[];
  finishedAt?: string;
}

function check(dir: string): { checks: Check[]; summary: string } {
  const s = readJson<Session>(paths(dir).session);
  if (!s) throw new Error(`${dir} is not a session folder`);
  const p = paths(dir);
  const progress = readJson<Progress>(p.progress) ?? {};
  const study = studyOf(s.variant);
  const checks = study.verify(dirsOf(dir), progress.answers ?? {});
  const cards = study.cards;
  const sus = susScore(progress.sus ?? []);
  const rows = cards.map((c) => {
    const t = progress.tasks?.[c.id];
    const k = checks.find((x) => x.task === c.id);
    const min = t?.ms !== undefined ? (t.ms / 60000).toFixed(1) : '–';
    return `| ${c.id} | ${c.title} | ${k?.verdict ?? '–'} | ${t?.success ?? '–'} | ${min} | ${t?.seq ?? '–'} | ${k?.detail ?? ''} |`;
  });
  const summary = [
    `# Session ${s.id}`,
    '',
    `Build ${s.version} (${s.vsix}), variant ${s.variant.toUpperCase()}, image ${s.image}. SUS: ${sus ?? 'not answered'}.`,
    '',
    '| Task | Title | Check | Self-rated | Minutes | Ease (1-7) | Check detail |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
  writeFileSync(p.summary, summary);
  writeJson(p.results, { session: { ...s, token: undefined }, progress, checks, sus });
  keepLocal(dir, s.id);
  return { checks, summary };
}

/**
 * The raw notes and answers, copied into the checkout's `usability-sessions/` (ignored by Git) for
 * the analysis: the repository gets them only paraphrased (protocol, Privacy). `just` runs the kit
 * from the checkout. session.json stays behind: it holds the runner's token.
 */
function keepLocal(dir: string, id: string) {
  const to = resolve('usability-sessions', id);
  mkdirSync(to, { recursive: true });
  const p = paths(dir);
  for (const f of [p.progress, p.results, p.summary])
    if (existsSync(f)) copyFileSync(f, join(to, basename(f)));
}

const body = (req: IncomingMessage) =>
  new Promise<string>((ok, fail) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) fail(new Error('too large'));
      else parts.push(c);
    });
    req.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
    req.on('error', fail);
  });

function serve(dir: string) {
  const p = paths(dir);
  const s = readJson<Session>(p.session);
  if (!s) throw new Error(`${dir} is not a session folder`);
  const study = studyOf(s.variant);
  const page = () =>
    runnerHtml.replace('"__SESSION__"', () =>
      JSON.stringify({
        id: s.id,
        round: s.round,
        variant: s.variant,
        version: s.version,
        token: s.token,
        tasks: study.cards,
        parts: study.parts,
        intro: study.intro,
        sus: SUS,
        progress: readJson(p.progress) ?? null,
      }).replaceAll('<', '\\u003c'),
    );
  const server = createServer(async (req, res) => {
    const send = (status: number, data: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(data) : String(data));
    };
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html'))
        return send(200, page(), 'text/html; charset=utf-8');
      // Only the runner page may call the API: same origin and the session's token.
      if (req.headers.host !== `127.0.0.1:${s.port}` || req.headers['x-kit-token'] !== s.token)
        return send(403, { error: 'forbidden' });
      if (req.method !== 'POST') return send(404, { error: 'not found' });
      const data = JSON.parse((await body(req)) || '{}');
      if (req.url === '/api/progress') {
        writeJson(p.progress, data);
        return send(200, { ok: true });
      }
      if (req.url === '/api/outside-edit') {
        const now = readJson<Session>(p.session) ?? s;
        if (now.outsideEdit)
          return send(200, {
            ok: true,
            file: now.outsideEdit,
            message: now.outsideMessage,
            again: true,
          });
        const out = await study.outside(dirsOf(dir));
        writeJson(p.session, {
          ...now,
          outsideEdit: out.file,
          outsideMessage: out.message,
          outsideFacts: out.facts,
        });
        log(`Outside change: ${out.file}${out.facts ? ` ${JSON.stringify(out.facts)}` : ''}`);
        return send(200, { ok: true, file: out.file, message: out.message });
      }
      if (req.url === '/api/finish') {
        writeJson(p.progress, data);
        const { summary } = check(dir);
        log(`Session finished. Results: ${p.results}`);
        console.log(summary);
        send(200, { ok: true, summary });
        setTimeout(() => process.exit(0), 500);
        return;
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.listen(s.port, '127.0.0.1', () =>
    log(
      `Task runner on http://127.0.0.1:${s.port}/ (Ctrl+C stops it; progress is saved as you go)`,
    ),
  );
  return s;
}

/** Self-test: what a participant would leave behind for the file-checked tasks. */
async function solve(dir: string) {
  const s = readJson<Session>(paths(dir).session);
  if (!s) throw new Error(`${dir} is not a session folder`);
  log(await studyOf(s.variant).solve(paths(dir).workspace));
}

async function main() {
  const args = process.argv.slice(2);
  const opts = new Map<string, string>();
  const plain: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--no-launch') opts.set(a, '1');
    else if (a.startsWith('--')) opts.set(a, args[++i] ?? '');
    else plain.push(a);
  }
  const [cmd, x] = plain;
  if (cmd === 'serve' && x) return void serve(resolve(x));
  if (cmd === 'verify' && x) return void console.log(check(resolve(x)).summary);
  if (cmd === 'solve' && x) return solve(resolve(x));
  const [round, variant, vsix] = plain;
  if (!round || !variant || !vsix)
    throw new Error('usage: kit <round> <a|b|c> <vsix> | kit serve|verify|solve <session folder>');
  const dir = await prepare(round, variant, vsix, opts);
  const s = serve(dir);
  if (!opts.has('--no-launch')) launch(dir, s);
  log(`Session folder: ${dir}`);
  log(`Reopen later with: just usability serve ${dir}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
