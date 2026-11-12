// Runs a flow's scenarios (AFD-58) for the designer and the CI command line alike: per scenario, the
// SCENARIO build of the flow (every step as its stub), a local-connection inventory and the extra
// vars go into a folder of their own; ansible-playbook runs in the environment as any run does
// (runProcess), and its routing events say where each host ended.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { engineFor } from '../../core/engine/engines';
import type { GenerateResult } from '../../core/engine/types';
import type { FlowDocument } from '../../core/flow/types';
import { insidePaths, type ProcessSpec, runProcess } from '../../core/run/command';
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
import { missWhy } from '../../core/scenario/view';
import { stopStarted } from '../run/stop';
import { fetchRunFile, putRunFolder, removeRunDir, syncWorkspace } from '../ssh/remote';

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

/** The folder an EE image writes the events into, inside a scenario's folder (AFD-159). */
const EVENTS = 'events';

/** AFD-159: a name that is not text (a number, nothing) still names a folder. */
const slug = (name: unknown) =>
  String(name ?? '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 40) || 'scenario';

/** Runs one process to its end, feeding its output to `log`; resolves with the exit code. */
function exec(
  spec: ProcessSpec,
  log: (line: string) => void,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve) => {
    // AFD-131: on Linux and macOS the run gets a process group of its own, so a stop ends
    // ansible-playbook too, not only the shell that started it.
    const group = process.platform !== 'win32';
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: group,
    });
    // Killing the client leaves a container or a WSL process running; spec.stop ends those.
    const stop = () => {
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill();
      } catch {
        child.kill();
      }
      void stopStarted(spec);
    };
    const timer = setTimeout(stop, timeoutMs);
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

/**
 * A scenario's folder: the scenario build of the flow, its extra vars and inventory (AFD-114: the
 * simulator's parity suite stages many into one container). Undefined when the flow does not
 * generate.
 */
export function stageScenario(
  doc: FlowDocument,
  s: Scenario,
  dir: string,
  source: string,
): GenerateResult | undefined {
  const generated = engineFor(doc).generate(doc, { source, simulate: true, stubAll: true });
  if (!generated.ok || generated.files.length === 0) return undefined;
  for (const f of generated.files) writeFileSync(join(dir, f.name), f.text);
  writeFileSync(join(dir, 'vars.json'), JSON.stringify(scenarioVars(s), null, 2));
  writeFileSync(join(dir, 'inventory.ini'), scenarioInventory(doc, s));
  // AFD-126: ANSIBLE_CONFIG points here, so no ansible.cfg of the repository or the user applies.
  writeFileSync(join(dir, 'ansible.cfg'), '');
  return generated;
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
  // AFD-159: Ansible loads plugins, group_vars and host_vars from beside the playbook and the
  // inventory, so no other user may write here (0777 let one swap them in on a shared CI host).
  // An EE image runs as a user of its own, which only reads here and writes the events into
  // EVENTS, open to all and sticky: nothing in it is loaded.
  const shared = o.env.kind === 'container';
  // AFD-247: an SSH host runs a copy of this folder; in an image there, the events folder too.
  const ssh = o.env.kind === 'ssh' ? o.env : undefined;
  const eventsDir = shared || ssh?.container ? EVENTS : undefined;
  chmodSync(dir, shared ? 0o755 : 0o700);
  if (shared) {
    mkdirSync(join(dir, EVENTS));
    chmodSync(join(dir, EVENTS), 0o1777);
  }
  try {
    const generated = stageScenario(o.doc, s, dir, basename(o.flowFile));
    if (!generated)
      return judge(o.doc, s, undefined, 'The flow does not generate: fix its errors first');
    if (ssh) {
      const failed =
        (await syncWorkspace(ssh, { root: o.root, probe: o.probeDir })) ??
        (await putRunFolder(ssh, dir, eventsDir));
      if (failed) return judge(o.doc, s, undefined, failed);
    }
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
        // The scenario build runs no binding: the repository's ansible.cfg has nothing to say,
        // and the empty one written above keeps it from loading from the working directory.
        hasConfig: false,
        emptyConfig: true,
        eventsDir,
      },
      `afd-scenario-${Date.now().toString(36)}-${index}`,
    );
    const rc = await exec(spec, log, o.timeoutMs ?? 300_000, o.signal);
    const events = join(dir, eventsDir ?? '', 'events.jsonl');
    if (ssh) {
      await fetchRunFile(ssh, dir, `${eventsDir ? `${eventsDir}/` : ''}events.jsonl`, events);
      await removeRunDir(ssh, dir);
    }
    const text = existsSync(events) ? readFileSync(events, 'utf8') : '';
    if (o.signal?.aborted) return judge(o.doc, s, undefined, 'Cancelled');
    // 2: hosts failed in the outcome play, as a scenario with failures expects.
    if (!text.trim() || rc === null || ![0, 2, 4].includes(rc))
      return {
        ...judge(
          o.doc,
          s,
          text.trim() ? summarizeRun(text, generated.routes) : undefined,
          `ansible-playbook ended with ${rc ?? 'an error'}${text.trim() ? '' : ' before any routing event'}`,
        ),
        engine: 'ansible',
      };
    return { ...judge(o.doc, s, summarizeRun(text, generated.routes)), engine: 'ansible' };
  } catch (e) {
    // AFD-159: a scenario that cannot be staged fails alone; the others still run.
    return judge(o.doc, s, undefined, (e as Error).message);
  } finally {
    if (!o.keep) rmSync(dir, { recursive: true, force: true });
  }
}

export async function runScenarios(o: ScenarioRunOptions): Promise<ScenarioResult[]> {
  const log = o.log ?? (() => undefined);
  const results: ScenarioResult[] = [];
  for (const [i, s] of o.file.scenarios.entries()) {
    // AFD-159: checkScenarios reports an entry that is no map; a run without the check skips it.
    if (!s || typeof s !== 'object') continue;
    if (o.only && !o.only.includes(s.name)) continue;
    if (o.signal?.aborted) break;
    log(`# Scenario: ${s.name}`);
    results.push(await runOne(o, s, i, log));
  }
  return results;
}

/**
 * A one-line verdict per scenario, and the hosts that ended elsewhere. With the flow at hand, the
 * ends by their titles with the keys a scenario file uses in brackets (AFD-94). AFD-105: in the
 * panel's wording, with why when the scenario planted the host's outcome.
 */
export function describeResults(results: readonly ScenarioResult[], doc?: FlowDocument): string[] {
  const out: string[] = [];
  for (const r of results) {
    if (skipped(r)) {
      out.push(`SKIP ${r.name}: the simulator does not model this; verify it with a run`);
      for (const u of r.needsAnsible ?? []) out.push(`  ${u.message}`);
      continue;
    }
    const how = r.engine === 'simulated' ? ' (simulated)' : '';
    out.push(`${r.passed ? 'PASS' : 'FAIL'} ${r.name}${how}${r.error ? `: ${r.error}` : ''}`);
    for (const h of r.hosts)
      if (h.expected !== h.actual) out.push(`  ${missWhy(doc, h, r.forced, true)}`);
  }
  return out;
}

/**
 * AFD-114: a simulated scenario that has what the simulator does not model is not judged on the
 * command line: its verdict is a best effort, so CI skips it rather than pass or fail on a guess.
 */
export const skipped = (r: ScenarioResult) =>
  r.engine === 'simulated' && (r.needsAnsible?.length ?? 0) > 0;

/** Scenarios that failed, leaving out the skipped. */
export const failedCount = (results: readonly ScenarioResult[]) =>
  results.filter((r) => !r.passed && !skipped(r)).length;

/** JUnit XML for CI dashboards: one test case per scenario. */
/**
 * Text for XML: escaped, and without the control characters XML 1.0 forbids even as references
 * (AFD-158: Ansible output can carry terminal colour codes).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
const XML_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;
const esc = (t: string) =>
  t
    .replaceAll(XML_FORBIDDEN, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** One flow's scenarios as a JUnit `<testsuite>`. */
export function junitSuite(
  flow: string,
  results: readonly ScenarioResult[],
  doc?: FlowDocument,
): string {
  const failures = failedCount(results);
  const skips = results.filter(skipped).length;
  const cases = results.map((r) => {
    if (skipped(r))
      return `    <testcase classname="${esc(flow)}" name="${esc(r.name)}"><skipped message="${esc(`Verify with a run: ${(r.needsAnsible ?? []).map((u) => u.message).join('; ')}`)}"/></testcase>`;
    if (r.passed) return `    <testcase classname="${esc(flow)}" name="${esc(r.name)}"/>`;
    const text = describeResults([r], doc).join('\n');
    return `    <testcase classname="${esc(flow)}" name="${esc(r.name)}"><failure message="${esc(r.error ?? 'hosts ended elsewhere')}">${esc(text)}</failure></testcase>`;
  });
  return [
    `  <testsuite name="${esc(flow)}" tests="${results.length}" failures="${failures}"${skips ? ` skipped="${skips}"` : ''}>`,
    ...cases,
    '  </testsuite>',
  ].join('\n');
}

/**
 * A JUnit file of several flows' suites under one root (AFD-158: one document per flow, joined,
 * was not XML once there were two flows).
 */
export function junitDocument(suites: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites>',
    ...suites,
    '</testsuites>',
    '',
  ].join('\n');
}

/** One flow's scenarios as a whole JUnit file. */
export function junitXml(
  flow: string,
  results: readonly ScenarioResult[],
  doc?: FlowDocument,
): string {
  return junitDocument([junitSuite(flow, results, doc)]);
}
