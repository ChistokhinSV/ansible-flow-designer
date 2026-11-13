// Starts the process of a run, a scenario or a check (AFD-271: one copy for the scenario runner
// and for hosts that run flows without a terminal).
import { spawn } from 'node:child_process';
import type { ProcessSpec } from '../../core/run/command';

/** A process that was started: how it ended, and how to end it. */
export interface Execution {
  /** The exit code; undefined when the process could not start or ended without one. */
  exit: Promise<number | undefined>;
  /** Ends the process. What it started beyond itself (a container) is ended with `stopStarted`. */
  terminate(): void;
}

/**
 * Runs `spec` with `env` on top of this process's environment, feeding its output to `log` line
 * by line. AFD-247: a spec with `input` names the variables whose values go to the process's
 * input, one base64 line each, instead of its arguments (what afd-ssh-run does for a terminal).
 */
export function startProcess(
  spec: ProcessSpec,
  env: Record<string, string>,
  log: (line: string) => void,
): Execution {
  // AFD-131: on Linux and macOS the run gets a process group of its own, so a stop ends
  // ansible-playbook too, not only the shell that started it.
  const group = process.platform !== 'win32';
  const feed = spec.input?.length ? spec.input : undefined;
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...env },
    stdio: [feed ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: group,
  });
  if (feed && child.stdin) {
    child.stdin.on('error', () => undefined);
    for (const name of feed)
      child.stdin.write(`${Buffer.from(env[name] ?? '', 'utf8').toString('base64')}\n`);
    child.stdin.end();
  }
  const lines = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) log(line);
  };
  child.stdout?.on('data', lines);
  child.stderr?.on('data', lines);
  const exit = new Promise<number | undefined>((resolve) => {
    child.on('error', (e) => {
      log(e.message);
      resolve(undefined);
    });
    child.on('close', (code) => resolve(code ?? undefined));
  });
  return {
    exit,
    terminate() {
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill();
      } catch {
        child.kill();
      }
    },
  };
}
