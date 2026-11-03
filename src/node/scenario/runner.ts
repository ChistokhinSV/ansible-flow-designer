// Runs a flow's scenarios (AFD-58) for the designer and the CI command line alike: per scenario, the
// SCENARIO build of the flow (every step as its stub), a local-connection inventory and the extra
// vars go into a folder of their own; ansible-playbook runs in the environment as any run does
// (runProcess), and its routing events say where each host ended.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { engineFor } from '../../core/engine/engines';
import type { FlowDocument } from '../../core/flow/types';
import { insidePaths, runProcess } from '../../core/run/command';
import type { Environment } from '../../core/run/environment';
import { summarizeRun } from '../../core/run/events';
import {
  judge,
  type Scenario,
  type ScenarioFile,
  type ScenarioResult,
  scenarioInventory,
  scenarioVars,
} from '../../core/scenario/scenarios';

export interface ScenarioRunOptions {
  env: Environment;
  /** Repository root on this machine (mounted read-only in a container). */
  root: string;
  /** Folder with callback_plugins/afd_events.py. */
  probeDir: string;
  flowFile: string;
  doc: FlowDocument;
  file: ScenarioFile;
  /** Where each scenario's folder is made; removed afterwards unless `keep`. */
  workDir: string;
  only?: readonly string[];
  keep?: boolean;
  timeoutMs?: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 40) || 'scenario';

/** Runs one process to its end, feeding its output to `log`; resolves with the exit code. */
function exec(
  command: string,
  args: string[],
  options: { cwd?: string; env: Record<string, string> },
  log: (line: string) => void,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const stop = () => child.kill();
    signal?.addEventListener('abort', stop, { once: true });
    const lines = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) log(line);
    };
    child.stdout.on('data', lines);
    child.stderr.on('data', lines);
    child.on('error', (e) => {
      log(e.message);
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve(code);
    });
  });
}

async function runOne(
  o: ScenarioRunOptions,
  s: Scenario,
  index: number,
  log: (line: string) => void,
): Promise<ScenarioResult> {
  const dir = join(o.workDir, `${index + 1}-${slug(s.name)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // An EE image runs as its own user, which writes the events here (umask leaves it read-only).
  chmodSync(dir, 0o777);
  try {
    const generated = engineFor(o.doc).generate(o.doc, {
      source: basename(o.flowFile),
      simulate: true,
      stubAll: true,
    });
    if (!generated.ok || generated.files.length === 0)
      return judge(o.doc, s, undefined, 'The flow does not generate: fix its errors first');
    for (const f of generated.files) writeFileSync(join(dir, f.name), f.text);
    writeFileSync(join(dir, 'vars.json'), JSON.stringify(scenarioVars(s), null, 2));
    writeFileSync(join(dir, 'inventory.ini'), scenarioInventory(o.doc, s));
    const inside =
      o.env.kind === 'local'
        ? dir.replaceAll('\\', '/')
        : (insidePaths(o.env, { root: o.root, probe: o.probeDir, run: dir }).run ?? dir);
    const at = (name: string) => `${inside}/${name}`;
    const spec = runProcess(
      o.env,
      { root: o.root, probe: o.probeDir },
      {
        playbook: at(generated.files[0]?.name as string),
        inventory: at('inventory.ini'),
        check: false,
        runDir: dir,
        vault: false,
        // The scenario build runs no binding: the repository's ansible.cfg has nothing to say.
        hasConfig: false,
      },
      `afd-scenario-${Date.now().toString(36)}-${index}`,
    );
    const rc = await exec(
      spec.command,
      spec.args,
      { cwd: spec.cwd, env: spec.env },
      log,
      o.timeoutMs ?? 300_000,
      o.signal,
    );
    const events = join(dir, 'events.jsonl');
    const text = existsSync(events) ? readFileSync(events, 'utf8') : '';
    if (o.signal?.aborted) return judge(o.doc, s, undefined, 'Cancelled');
    // 2: hosts failed in the outcome play, as a scenario with failures expects.
    if (!text.trim() || rc === null || ![0, 2, 4].includes(rc))
      return judge(
        o.doc,
        s,
        text.trim() ? summarizeRun(text, generated.routes) : undefined,
        `ansible-playbook ended with ${rc ?? 'an error'}${text.trim() ? '' : ' before any routing event'}`,
      );
    return judge(o.doc, s, summarizeRun(text, generated.routes));
  } finally {
    if (!o.keep) rmSync(dir, { recursive: true, force: true });
  }
}

export async function runScenarios(o: ScenarioRunOptions): Promise<ScenarioResult[]> {
  const log = o.log ?? (() => undefined);
  const results: ScenarioResult[] = [];
  for (const [i, s] of o.file.scenarios.entries()) {
    if (o.only && !o.only.includes(s.name)) continue;
    if (o.signal?.aborted) break;
    log(`# Scenario: ${s.name}`);
    results.push(await runOne(o, s, i, log));
  }
  return results;
}

/** A one-line verdict per scenario, and the hosts that ended elsewhere. */
export function describeResults(results: readonly ScenarioResult[]): string[] {
  const out: string[] = [];
  for (const r of results) {
    out.push(`${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? `: ${r.error}` : ''}`);
    for (const h of r.hosts)
      if (h.expected !== h.actual)
        out.push(`  ${h.host}: expected ${h.expected}, ended at ${h.actual}`);
  }
  return out;
}

/** JUnit XML for CI dashboards: one test case per scenario. */
export function junitXml(flow: string, results: readonly ScenarioResult[]): string {
  const esc = (t: string) =>
    t
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const failures = results.filter((r) => !r.passed).length;
  const cases = results.map((r) => {
    if (r.passed) return `    <testcase classname="${esc(flow)}" name="${esc(r.name)}"/>`;
    const text = describeResults([r]).join('\n');
    return `    <testcase classname="${esc(flow)}" name="${esc(r.name)}"><failure message="${esc(r.error ?? 'hosts ended elsewhere')}">${esc(text)}</failure></testcase>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites><testsuite name="${esc(flow)}" tests="${results.length}" failures="${failures}">`,
    ...cases,
    '  </testsuite></testsuites>',
    '',
  ].join('\n');
}
