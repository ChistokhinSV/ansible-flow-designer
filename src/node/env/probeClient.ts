// JSON-lines session with the probe (ADR-0005): spawn, ready line, request ids, timeouts, restart on
// the next call after a crash, a stderr ring buffer for error reports, and path mapping back to the
// repository when the probe runs in a container.
//
// The probe answers one request at a time, so calls queue here and go out one by one (AFD-32): a
// call's timeout counts from when it is sent, never while it waits behind another one, and a call
// that times out restarts the probe for the calls behind it instead of failing them too.
import { type ChildProcess, spawn } from 'node:child_process';
import * as readline from 'node:readline';
import type { ProcessSpec } from '../../core/run/command';
import { stopStarted } from '../run/stop';
import { TIMEOUTS } from '../timeouts';

export interface ProbeReady {
  kind: 'ready';
  probe: string;
  ansible_core: string;
  python: string;
  root: string;
}

export class ProbeError extends Error {
  constructor(
    message: string,
    readonly type: string,
  ) {
    super(message);
  }
}

const STDERR_LINES = 200;
/** A call cancelled by its caller (AFD-39). */
export const CANCELLED_CALL = 'Cancelled';

/** The oldest ansible-core the probe and the generated code support (ADR-0005). */
export const MIN_CORE = [2, 19] as const;

/** Whether an ansible-core version ("2.19.4", "2.20.0rc1") is at least MIN_CORE. */
export function coreSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((p) => Number.parseInt(p, 10) || 0);
  return major > MIN_CORE[0] || (major === MIN_CORE[0] && minor >= MIN_CORE[1]);
}

interface Pending {
  id: number;
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer?: NodeJS.Timeout;
}

export class ProbeClient {
  private proc?: ChildProcess;
  private ready?: Promise<ProbeReady>;
  private next = 1;
  private readonly queue: Pending[] = [];
  private inflight?: Pending;
  private readonly stderr: string[] = [];

  constructor(
    private readonly spec: ProcessSpec,
    /** Repository root on this machine; probe paths under `inside` map back to it. */
    private readonly root: string,
    /**
     * The root as the probe sees it (`/work` in a container, `/mnt/c/…` in WSL); none locally.
     * `ready` (AFD-247): the probe says it when it starts (an SSH host knows its own home folder).
     */
    private inside: string | undefined,
    /** Where the probe's stderr and its lifecycle go (the Ansible Flow log). */
    private readonly log: (line: string) => void = () => {},
    /**
     * AFD-247: done before the probe starts and before each call; a rejection fails that call. An
     * SSH host has a copy of the repository, which this keeps current.
     */
    private readonly before?: () => Promise<void>,
  ) {}

  /** Last stderr lines (Ansible warnings, tracebacks) for error reports. */
  stderrTail(lines = 20): string {
    return this.stderr.slice(-lines).join('\n');
  }

  start(): Promise<ProbeReady> {
    if (this.ready) return this.ready;
    const ready = (this.before ? this.before() : Promise.resolve()).then(() => this.spawnProbe());
    this.ready = ready;
    // The step before failed (no connection): the next call tries again.
    ready.catch(() => {
      if (this.ready === ready && !this.proc) this.ready = undefined;
    });
    return ready;
  }

  private spawnProbe(): Promise<ProbeReady> {
    const proc = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: { ...process.env, ...this.spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    this.log(`probe: starting ${this.spec.command} for ${this.root}`);
    return new Promise<ProbeReady>((resolve, reject) => {
      let first = true;
      const timer = setTimeout(() => {
        reject(new Error(`The Ansible probe did not start in time\n${this.stderrTail()}`));
        this.stopProcess(proc, new Error('The Ansible probe did not start in time'));
      }, TIMEOUTS.probeReady);
      readline
        .createInterface({ input: proc.stdout as NodeJS.ReadableStream })
        .on('line', (line) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            this.keep(line);
            return;
          }
          if (first) {
            first = false;
            clearTimeout(timer);
            if (msg.kind !== 'ready') {
              reject(new Error(String(msg.message ?? 'The Ansible probe failed to start')));
              return;
            }
            const ready = msg as unknown as ProbeReady;
            if (!coreSupported(ready.ansible_core)) {
              const why = `This environment has ansible-core ${ready.ansible_core}; Ansible Flow needs ${MIN_CORE.join('.')} or later. Choose an execution environment or Python with a newer ansible-core (afd.environment.*).`;
              this.log(`probe: ${why}`);
              reject(new Error(why));
              this.stopProcess(proc, new Error(why));
              return;
            }
            this.log(
              `probe: ready (probe ${ready.probe}, ansible-core ${ready.ansible_core}, Python ${ready.python})`,
            );
            if (this.inside === 'ready') this.inside = ready.root.replace(/\/+$/, '');
            resolve(ready);
            return;
          }
          const p = this.inflight;
          if (!p || Number(msg.id) !== p.id) return;
          clearTimeout(p.timer);
          this.inflight = undefined;
          const error = msg.error as { message?: string; type?: string } | undefined;
          if (error)
            p.reject(new ProbeError(error.message ?? 'probe error', error.type ?? 'Error'));
          else p.resolve(msg.result);
          this.pump();
        });
      readline
        .createInterface({ input: proc.stderr as NodeJS.ReadableStream })
        .on('line', (line) => this.keep(line));
      const end = (why: string) => {
        clearTimeout(timer);
        const err = new Error(`${why}\n${this.stderrTail()}`);
        reject(err);
        this.log(`probe: ${why}`);
        this.stopProcess(proc, err);
        // The calls behind the one that was running get a fresh probe.
        this.pump();
      };
      proc.on('error', (e) => end(`Could not start ${this.spec.command}: ${e.message}`));
      proc.on('exit', (code) => end(`The Ansible probe exited (code ${code})`));
    });
  }

  /**
   * Queues a call. `signal` cancels it (AFD-39): a queued call leaves the queue; a running one
   * fails and the probe restarts for the calls behind it, as after a timeout.
   */
  call<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = TIMEOUTS.probeCall,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error(CANCELLED_CALL));
      const pending: Pending = {
        id: this.next++,
        method,
        params,
        timeoutMs,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      signal?.addEventListener('abort', () => this.cancel(pending), { once: true });
      this.queue.push(pending);
      this.pump();
    });
  }

  private cancel(p: Pending): void {
    const queued = this.queue.indexOf(p);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      p.reject(new Error(CANCELLED_CALL));
      return;
    }
    if (this.inflight !== p) return;
    this.inflight = undefined;
    clearTimeout(p.timer);
    this.log(`probe: "${p.method}" was cancelled; restarting it for the next call`);
    p.reject(new Error(CANCELLED_CALL));
    if (this.proc) this.stopProcess(this.proc, new Error(CANCELLED_CALL));
    this.pump();
  }

  /** Sends the next queued call when none is running; its timeout starts now. */
  private pump(): void {
    if (this.inflight) return;
    const p = this.queue.shift();
    if (!p) return;
    this.inflight = p;
    this.start()
      .then(() => this.before?.())
      .then(
        () => {
          if (this.inflight !== p) return;
          p.timer = setTimeout(() => this.timedOut(p), p.timeoutMs);
          this.proc?.stdin?.write(
            `${JSON.stringify({ id: p.id, method: p.method, params: p.params })}\n`,
          );
        },
        (err: Error) => {
          if (this.inflight !== p) return;
          this.inflight = undefined;
          p.reject(err);
          this.pump();
        },
      );
  }

  /** A call that took too long: it fails, and the probe restarts for the calls behind it. */
  private timedOut(p: Pending): void {
    if (this.inflight !== p) return;
    this.inflight = undefined;
    const why = `The Ansible probe did not answer "${p.method}" within ${p.timeoutMs / 1000} s`;
    this.log(`probe: ${why}; restarting it for the next call`);
    p.reject(new Error(why));
    if (this.proc) this.stopProcess(this.proc, new Error(why));
    this.pump();
  }

  /** A probe path (in the container or the WSL distribution) as a path on this machine. */
  toHost(path: string): string {
    if (!this.inside || !path.startsWith(`${this.inside}/`)) return path;
    const rel = path.slice(this.inside.length + 1);
    const sep = this.root.includes('\\') ? '\\' : '/';
    return `${this.root.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`;
  }

  /** Stops the probe and fails every call, running or queued. */
  dispose(): void {
    const stopped = new Error('The Ansible probe was stopped');
    for (const p of this.queue.splice(0)) p.reject(stopped);
    if (this.proc) this.stopProcess(this.proc, stopped);
    else if (this.inflight) {
      this.inflight.reject(stopped);
      this.inflight = undefined;
    }
  }

  private keep(line: string): void {
    this.stderr.push(line);
    if (this.stderr.length > STDERR_LINES) this.stderr.splice(0, this.stderr.length - STDERR_LINES);
    this.log(`probe stderr: ${line}`);
  }

  /** Ends this process (the running call fails); queued calls stay for the next one. */
  private stopProcess(proc: ChildProcess, err: Error): void {
    if (this.proc !== proc) return;
    // Closing stdin ends the serve loop, so the container exits and removes itself.
    proc.stdin?.end();
    setTimeout(() => {
      if (proc.exitCode !== null) return;
      proc.kill();
      // AFD-131: a call that hangs keeps its container running after the client is gone.
      void stopStarted(this.spec);
    }, 3000).unref();
    const p = this.inflight;
    if (p) {
      clearTimeout(p.timer);
      this.inflight = undefined;
      p.reject(err);
    }
    this.proc = undefined;
    this.ready = undefined;
  }
}
