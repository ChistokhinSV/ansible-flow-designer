// JSON-lines session with the probe (ADR-0005): spawn, ready line, request ids, timeouts, restart on
// the next call after a crash, a stderr ring buffer for error reports, and path mapping back to the
// repository when the probe runs in a container.
import { type ChildProcess, spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { CONTAINER, type ProcessSpec } from '../../core/run/command';

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

const READY_TIMEOUT = 180_000; // first start may pull the image
const STDERR_LINES = 200;

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class ProbeClient {
  private proc?: ChildProcess;
  private ready?: Promise<ProbeReady>;
  private next = 1;
  private readonly waiters = new Map<number, Waiter>();
  private readonly stderr: string[] = [];

  constructor(
    private readonly spec: ProcessSpec,
    /** Repository root on this machine; probe paths under /work map back to it. */
    private readonly root: string,
    private readonly inContainer: boolean,
  ) {}

  /** Last stderr lines (Ansible warnings, tracebacks) for error reports. */
  stderrTail(lines = 20): string {
    return this.stderr.slice(-lines).join('\n');
  }

  start(): Promise<ProbeReady> {
    if (this.ready) return this.ready;
    const proc = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: { ...process.env, ...this.spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    this.ready = new Promise<ProbeReady>((resolve, reject) => {
      let first = true;
      const timer = setTimeout(() => {
        reject(new Error(`The Ansible probe did not start in time\n${this.stderrTail()}`));
        this.dispose();
      }, READY_TIMEOUT);
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
            if (msg.kind === 'ready') resolve(msg as unknown as ProbeReady);
            else reject(new Error(String(msg.message ?? 'The Ansible probe failed to start')));
            return;
          }
          const waiter = this.waiters.get(Number(msg.id));
          if (!waiter) return;
          this.waiters.delete(Number(msg.id));
          clearTimeout(waiter.timer);
          const error = msg.error as { message?: string; type?: string } | undefined;
          if (error)
            waiter.reject(new ProbeError(error.message ?? 'probe error', error.type ?? 'Error'));
          else waiter.resolve(msg.result);
        });
      readline
        .createInterface({ input: proc.stderr as NodeJS.ReadableStream })
        .on('line', (line) => this.keep(line));
      const end = (why: string) => {
        clearTimeout(timer);
        const err = new Error(`${why}\n${this.stderrTail()}`);
        reject(err);
        this.reset(err, proc);
      };
      proc.on('error', (e) => end(`Could not start ${this.spec.command}: ${e.message}`));
      proc.on('exit', (code) => end(`The Ansible probe exited (code ${code})`));
    });
    return this.ready;
  }

  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 60_000,
  ): Promise<T> {
    await this.start();
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(
          new Error(`The Ansible probe did not answer "${method}" within ${timeoutMs / 1000} s`),
        );
        this.dispose();
      }, timeoutMs);
      this.waiters.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc?.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** A probe path (in the container) as a path on this machine. */
  toHost(path: string): string {
    if (!this.inContainer || !path.startsWith(`${CONTAINER.root}/`)) return path;
    const rel = path.slice(CONTAINER.root.length + 1);
    const sep = this.root.includes('\\') ? '\\' : '/';
    return `${this.root.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`;
  }

  dispose(): void {
    const proc = this.proc;
    if (!proc) return;
    // Closing stdin ends the serve loop, so the container exits and removes itself.
    proc.stdin?.end();
    setTimeout(() => proc.exitCode === null && proc.kill(), 3000).unref();
    this.reset(new Error('The Ansible probe was stopped'), proc);
  }

  private keep(line: string): void {
    this.stderr.push(line);
    if (this.stderr.length > STDERR_LINES) this.stderr.splice(0, this.stderr.length - STDERR_LINES);
  }

  private reset(err: Error, proc: ChildProcess): void {
    if (this.proc !== proc) return;
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters.clear();
    this.proc = undefined;
    this.ready = undefined;
  }
}
