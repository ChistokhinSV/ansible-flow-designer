// AFD-271: a run without VS Code. The shared runFlow writes the run's folder, hands the process
// to its host, follows the events and keeps a redacted result; startProcess is the process a host
// without a terminal uses.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import type { ProcessSpec } from '../../../src/core/run/command';
import type { Environment } from '../../../src/core/run/environment';
import { summarizeRun } from '../../../src/core/run/events';
import { auditFile } from '../../../src/node/run/audit';
import { type Execution, startProcess } from '../../../src/node/run/exec';
import { stamp } from '../../../src/node/run/ids';
import { listRuns, loadRun, runsDir } from '../../../src/node/run/pastRuns';
import { type RunFlowRequest, runFlow } from '../../../src/node/run/runFlow';

const fixtures = join(__dirname, '../../fixtures/engine');
const doc = parse(readFileSync(join(fixtures, 'routing-ports.flow.yaml'), 'utf8')) as FlowDocument;
const code = optionA.generate(doc, { source: 'routing-ports.flow.yaml' });
const events = readFileSync(join(fixtures, 'routing-ports.events.jsonl'), 'utf8');
const env: Environment = { kind: 'local', python: 'python3', source: 'default', label: 'local' };

let storage: string;
let root: string;
beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), 'afd-run-storage-'));
  root = mkdtempSync(join(tmpdir(), 'afd-run-root-'));
});
afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function request(extra: Partial<RunFlowRequest> = {}): RunFlowRequest {
  return {
    id: stamp(),
    startedAt: new Date().toISOString(),
    mode: 'check',
    doc,
    code,
    env,
    environment: 'local: python3',
    root,
    probeDir: join(root, 'probe'),
    playbook: 'flows/routing-ports/generated/routing-ports.yml',
    storage,
    inputs: { devices: ['h01', 'h02'], api_token: 'hunter2-secret' },
    audit: { user: 'tester', mode: 'check' },
    ...extra,
  };
}

/** A host's process: writes `lines` as the run's events, then ends with `rc`. */
function writesEvents(lines: string, rc: number | undefined = 0) {
  const seen: { spec?: ProcessSpec; env?: Record<string, string>; varsAtStart?: string } = {};
  const execute = (spec: ProcessSpec, processEnv: Record<string, string>): Execution => {
    seen.spec = spec;
    seen.env = processEnv;
    const runDir = processEnv.AFD_EVENTS?.replace(/[\\/]events\.jsonl$/, '') ?? '';
    seen.varsAtStart = readFileSync(join(runDir, 'vars.json'), 'utf8');
    writeFileSync(join(runDir, 'events.jsonl'), lines);
    return { exit: Promise.resolve(rc), terminate: () => undefined };
  };
  return { execute, seen };
}

describe('AFD-271: runFlow without VS Code', () => {
  it('reports the run as it starts and as it ends, with the summary of its events', async () => {
    const reports: RunView[] = [];
    const host = writesEvents(events);
    const req = request();
    const done = await runFlow(req, { report: (r) => reports.push(r), execute: host.execute });

    expect(reports[0]).toMatchObject({ id: req.id, state: 'running', source: 'local' });
    expect(reports.at(-1)).toBe(done);
    expect(done).toMatchObject({ state: 'done', rc: 0, environment: 'local: python3' });
    expect(done.error).toBeUndefined();
    expect(done.summary).toEqual(summarizeRun(events, code.routes));
    expect(done.flowVersion).toBe(doc.flow.version);
  });

  it('keeps secret inputs out of every file, and takes them out of the kept events', async () => {
    // A task that prints the secret: the kept events must not hold it.
    const leaky = `${events.trimEnd()}\n${JSON.stringify({
      event: 'result',
      status: 'ok',
      host: 'h01',
      task: 'Echo',
      msg: 'token is hunter2-secret',
      ts: 99,
    })}\n`;
    const host = writesEvents(leaky);
    const req = request({ vaultPassword: 'vault-pass-123' });
    await runFlow(req, { report: () => undefined, execute: host.execute });

    // The process gets the secrets in its environment only.
    expect(host.seen.env?.AFD_SECRET_VARS).toBe(JSON.stringify({ api_token: 'hunter2-secret' }));
    expect(host.seen.env?.AFD_VAULT_PASSWORD).toBe('vault-pass-123');
    expect(host.seen.varsAtStart).toContain('h01');
    expect(host.seen.varsAtStart).not.toContain('hunter2-secret');
    expect(JSON.stringify(host.seen.spec)).not.toContain('hunter2-secret');
    expect(JSON.stringify(host.seen.spec)).not.toContain('vault-pass-123');

    const runDir = join(runsDir(storage, doc.flow.id), req.id);
    // vars.json went with the run; what is kept names no secret.
    expect(existsSync(join(runDir, 'vars.json'))).toBe(false);
    for (const name of readdirSync(runDir)) {
      const text = readFileSync(join(runDir, name), 'utf8');
      expect(text, name).not.toContain('hunter2-secret');
      expect(text, name).not.toContain('vault-pass-123');
    }
    expect(readFileSync(auditFile(storage), 'utf8')).not.toContain('hunter2-secret');
  });

  it('keeps the run for later and writes the launch and the finish to the audit log', async () => {
    const req = request();
    const done = await runFlow(req, {
      report: () => undefined,
      execute: writesEvents(events).execute,
    });

    expect((await listRuns(storage, doc.flow.id)).map((r) => r.id)).toEqual([req.id]);
    expect(await loadRun(storage, doc.flow.id, req.id)).toEqual(JSON.parse(JSON.stringify(done)));

    const audit = readFileSync(auditFile(storage), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.map((a) => a.event)).toEqual(['launch', 'finish']);
    expect(audit[0]).toMatchObject({ run: req.id, user: 'tester', mode: 'check' });
    expect(audit[1]).toMatchObject({ run: req.id, rc: 0 });
  });

  it('a stop ends the process and the run ends as stopped', async () => {
    let end: (rc: number | undefined) => void = () => undefined;
    let terminated = 0;
    const stoppingSeen: boolean[] = [];
    const done = await runFlow(request(), {
      report: () => undefined,
      execute: (_spec, _env, stopping) => ({
        exit: new Promise<number | undefined>((resolve) => {
          end = resolve;
        }),
        terminate: () => {
          terminated++;
          stoppingSeen.push(stopping());
          end(undefined);
        },
      }),
      started: (stop) => {
        void stop();
        return undefined;
      },
    });
    expect(terminated).toBe(1);
    // The host is told the run is being stopped before its process is ended.
    expect(stoppingSeen).toEqual([true]);
    expect(done).toMatchObject({
      state: 'error',
      error: 'Stopped by the user',
      errorCode: 'cancelled',
    });
  });

  it('an abort signal stops the run the same way', async () => {
    const abort = new AbortController();
    let end: (rc: number | undefined) => void = () => undefined;
    const pending = runFlow(request({ signal: abort.signal }), {
      report: (r) => {
        if (r.state === 'running' && !r.summary) setTimeout(() => abort.abort(), 0);
      },
      execute: () => ({
        exit: new Promise<number | undefined>((resolve) => {
          end = resolve;
        }),
        terminate: () => end(undefined),
      }),
    });
    await expect(pending).resolves.toMatchObject({ state: 'error', errorCode: 'cancelled' });
  });

  it('a process that cannot start, or says nothing, is an error with its reason', async () => {
    const none = await runFlow(request(), {
      report: () => undefined,
      execute: () => {
        throw new Error('no terminal');
      },
    });
    expect(none).toMatchObject({ state: 'error', error: 'The run could not be started' });

    const silent = await runFlow(request({ id: `${stamp()}B` }), {
      report: () => undefined,
      execute: writesEvents('').execute,
    });
    expect(silent).toMatchObject({ state: 'done', error: 'The run produced no events' });
  });
});

describe('AFD-271: startProcess', () => {
  const node = (script: string): ProcessSpec => ({
    command: process.execPath,
    args: ['-e', script],
    env: {},
    cwd: tmpdir(),
  });

  it('feeds the output to the log line by line and resolves with the exit code', async () => {
    const lines: string[] = [];
    const run = startProcess(
      node("console.log('one'); console.error('two'); process.exit(3)"),
      {},
      (line) => lines.push(line),
    );
    await expect(run.exit).resolves.toBe(3);
    expect(lines.sort()).toEqual(['one', 'two']);
  });

  it('gives the named variables to the input, one base64 line each', async () => {
    const lines: string[] = [];
    const spec = {
      ...node("process.stdin.on('data', (d) => process.stdout.write(d))"),
      input: ['AFD_VAULT_PASSWORD', 'AFD_SECRET_VARS'],
    };
    const run = startProcess(spec, { AFD_VAULT_PASSWORD: 'pw', AFD_SECRET_VARS: '{"a":1}' }, (l) =>
      lines.push(l),
    );
    await expect(run.exit).resolves.toBe(0);
    expect(lines.map((l) => Buffer.from(l, 'base64').toString('utf8'))).toEqual(['pw', '{"a":1}']);
  });

  it('a program that does not exist resolves without a code', async () => {
    const lines: string[] = [];
    const run = startProcess(
      { command: join(tmpdir(), 'afd-no-such-program'), args: [], env: {}, cwd: tmpdir() },
      {},
      (line) => lines.push(line),
    );
    await expect(run.exit).resolves.toBeUndefined();
    expect(lines.join(' ')).toMatch(/ENOENT/);
  });

  it('terminate ends a process that would not end by itself', async () => {
    const run = startProcess(node('setInterval(() => {}, 1000)'), {}, () => undefined);
    setTimeout(() => run.terminate(), 200);
    await expect(run.exit).resolves.not.toBe(0);
  });
});
