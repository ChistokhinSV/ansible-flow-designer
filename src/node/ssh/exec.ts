// AFD-247: runs the commands `core/run/ssh` writes: one `ssh` each, with input when it has some,
// its output collected, and a limit on how long it may take. Nothing here asks a question: the
// connection is in batch mode, so a host that wants a password fails with ssh's own message.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Command {
  command: string;
  args: string[];
}

export interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Windows ships bsdtar in System32. A GNU tar earlier on the PATH (Git for Windows) reads
 * `C:\x` as a remote host, so tar is always that one there.
 */
export function tarExe(): string {
  if (process.platform !== 'win32') return 'tar';
  const own = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync(own) ? own : 'tar';
}

/** ssh's last line that says something, without its banner noise: why a connection failed. */
export function sshWhy(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(Warning: Permanently added|\*\*)/.test(l));
  return lines.at(-1) ?? 'ssh gave no message';
}

/** Runs a command to its end. `input` is written to it and closed; never rejects. */
export function run(
  c: Command,
  options: { input?: string | Buffer; timeoutMs?: number; binary?: boolean } = {},
): Promise<Outcome & { out: Buffer }> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(c.command, c.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e), out: Buffer.alloc(0) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 60_000);
    proc.stdout?.on('data', (d: Buffer) => out.push(d));
    proc.stderr?.on('data', (d: Buffer) => err.push(d));
    const end = (code: number | null, extra = '') => {
      clearTimeout(timer);
      const all = Buffer.concat(out);
      resolve({
        code,
        stdout: options.binary ? '' : all.toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + extra,
        out: all,
      });
    };
    proc.on('error', (e) => end(null, `Could not start ${c.command}: ${e.message}`));
    proc.on('close', (code) => end(code));
    // A command that ends early closes its input: that is its answer, not an error here.
    proc.stdin?.on('error', () => undefined);
    proc.stdin?.end(options.input ?? '');
  });
}

/**
 * Pipes the output of one or more commands, one after the other, into another command's input;
 * resolves with the exit codes (`from`: the first that is not 0, else 0).
 */
export function pipe(
  from: (Command & { cwd?: string }) | (Command & { cwd?: string })[],
  to: Command,
  options: { timeoutMs?: number } = {},
): Promise<{ from: number | null; to: number | null; stderr: string }> {
  const sources = Array.isArray(from) ? from : [from];
  return new Promise((resolve) => {
    const err: Buffer[] = [];
    let b: ChildProcess;
    try {
      b = spawn(to.command, to.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ from: null, to: null, stderr: String(e) });
      return;
    }
    let current: ChildProcess | undefined;
    const timer = setTimeout(() => {
      current?.kill();
      b.kill();
    }, options.timeoutMs ?? 300_000);
    let codeA: number | null | undefined;
    let codeB: number | null | undefined;
    const done = () => {
      if (codeA === undefined || codeB === undefined) return;
      clearTimeout(timer);
      resolve({ from: codeA, to: codeB, stderr: Buffer.concat(err).toString('utf8') });
    };
    b.stderr?.on('data', (d: Buffer) => err.push(d));
    b.stdout?.resume();
    b.stdin?.on('error', () => undefined);
    b.on('error', (e) => {
      err.push(
        Buffer.from(`Could not start ${to.command}: ${e.message}
`),
      );
      codeB = null;
      current?.kill();
      done();
    });
    b.on('close', (code) => {
      codeB = code;
      current?.kill();
      if (codeA === undefined) codeA = null;
      done();
    });
    const next = (i: number) => {
      const source = sources[i];
      if (!source) {
        codeA = 0;
        b.stdin?.end();
        done();
        return;
      }
      let a: ChildProcess;
      try {
        a = spawn(source.command, source.args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          cwd: source.cwd,
        });
      } catch (e) {
        err.push(Buffer.from(String(e)));
        codeA = null;
        b.stdin?.end();
        done();
        return;
      }
      current = a;
      a.stderr?.on('data', (d: Buffer) => err.push(d));
      a.stdout?.pipe(b.stdin as NodeJS.WritableStream, { end: false });
      const fail = (code: number | null, why = '') => {
        if (why) err.push(Buffer.from(why));
        if (codeA === undefined) codeA = code;
        b.stdin?.end();
        done();
      };
      a.on('error', (e) =>
        fail(
          null,
          `Could not start ${source.command}: ${e.message}
`,
        ),
      );
      a.on('close', (code) => (code === 0 ? next(i + 1) : fail(code)));
    };
    next(0);
  });
}
