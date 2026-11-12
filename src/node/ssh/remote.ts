// AFD-247: what a run on an SSH host needs around the run itself: its inputs put there, its
// events followed as they are written, the folder removed after, the catalog's dumps fetched, and
// a look at what the host has.
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Environment } from '../../core/run/environment';
import {
  checkCommand,
  fetchDirCommand,
  followCommand,
  type HostFacts,
  openDirCommand,
  parseHostFacts,
  readFileCommand,
  remotePaths,
  removeCommand,
  writeFileCommand,
} from '../../core/run/ssh';
import { pipe, run, sshWhy, tarExe } from './exec';
import { syncFolder } from './sync';

export type SshEnv = Extract<Environment, { kind: 'ssh' }>;

/** The repository and the probe on the host, as they are here now. */
export async function syncWorkspace(
  env: SshEnv,
  paths: { root: string; probe: string },
  /** Folders of the repository copied whatever .gitignore says. */
  include: readonly string[] = [],
): Promise<string | undefined> {
  for (const [from, into] of [
    [paths.probe, 'probe'],
    [paths.root, 'repo'],
  ] as const) {
    const r = await syncFolder(env, from, into, into === 'repo' ? include : []);
    if (!r.ok) return r.error;
  }
  return undefined;
}

/** Puts a file of the run folder on the host (its inputs, a generated config). */
export async function putRunFile(
  env: SshEnv,
  runDir: string,
  name: string,
  text: string,
): Promise<string | undefined> {
  const there = remotePaths(env, runDir).run;
  // A container's own user writes the events beside it.
  const r = await run(writeFileCommand(env, `${there}/${name}`, !!env.container), { input: text });
  return r.code === 0 ? undefined : `Could not write ${name} on ${env.host}: ${sshWhy(r.stderr)}`;
}

/**
 * Follows a file of the run folder on the host into the same file here, so what reads the local
 * one (the live summary on the canvas) sees the run as it goes. `stop` ends the following and
 * then writes the whole file once more: nothing the last moments wrote is lost.
 */
export function followRunFile(
  env: SshEnv,
  runDir: string,
  name: string,
  local: string,
): { stop(): Promise<void> } {
  const there = `${remotePaths(env, runDir).run}/${name}`;
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, '');
  const c = followCommand(env, there);
  let proc: ChildProcess | undefined;
  try {
    proc = spawn(c.command, c.args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    proc.stdout?.on('data', (d: Buffer) => {
      try {
        appendFileSync(local, d);
      } catch {
        // The run folder went away (pruned): the final read below has nowhere to write either.
      }
    });
    proc.on('error', () => undefined);
  } catch {
    proc = undefined;
  }
  return {
    async stop() {
      proc?.kill();
      const whole = await run(readFileCommand(env, there), { binary: true, timeoutMs: 60_000 });
      if (whole.code === 0 && whole.out.length > 0) {
        try {
          writeFileSync(local, whole.out);
        } catch {
          // As above.
        }
      }
    },
  };
}

/**
 * AFD-247: a scenario's folder (its build of the flow, inventory and vars) on the host, as the
 * run folder `runDir`. `events`: a folder in it for an image's own user to write the events to.
 */
export async function putRunFolder(
  env: SshEnv,
  runDir: string,
  events?: string,
): Promise<string | undefined> {
  const there = remotePaths(env, runDir).run as string;
  const r = await syncFolder(env, runDir, there.slice(env.dir.length + 1));
  if (!r.ok) return r.error;
  if (!events) return undefined;
  const made = await run(openDirCommand(env, `${remotePaths(env, runDir).run}/${events}`));
  return made.code === 0
    ? undefined
    : `Could not prepare the run on ${env.host}: ${sshWhy(made.stderr)}`;
}

/** A file of the run folder on the host, read whole into the same file here. */
export async function fetchRunFile(
  env: SshEnv,
  runDir: string,
  name: string,
  local: string,
): Promise<void> {
  const whole = await run(readFileCommand(env, `${remotePaths(env, runDir).run}/${name}`), {
    binary: true,
    timeoutMs: 60_000,
  });
  if (whole.code !== 0) return;
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, whole.out);
}

/** Removes the run's folder on the host (its inputs are not kept there). */
export async function removeRunDir(env: SshEnv, runDir: string): Promise<void> {
  const there = remotePaths(env, runDir).run;
  if (there) await run(removeCommand(env, there), { timeoutMs: 30_000 });
}

/** Brings the catalog dumps the probe wrote on the host into the cache here. */
export async function fetchCache(env: SshEnv, localCache: string): Promise<string | undefined> {
  mkdirSync(localCache, { recursive: true });
  const r = await pipe(
    fetchDirCommand(env, remotePaths(env).cache),
    { command: tarExe(), args: ['-xf', '-', '-C', localCache] },
    { timeoutMs: 600_000 },
  );
  return r.from === 0 && r.to === 0
    ? undefined
    : `Could not fetch the catalog from ${env.host}: ${sshWhy(r.stderr)}`;
}

/** What the host has; an error when it cannot be reached. */
export async function hostFacts(host: string): Promise<{ facts?: HostFacts; error?: string }> {
  const r = await run(checkCommand(host), { timeoutMs: 30_000 });
  if (r.code !== 0) return { error: `Could not connect to ${host}: ${sshWhy(r.stderr)}` };
  return { facts: parseHostFacts(r.stdout) };
}

/** Copies one file to the host, readable by the account alone (a vault password file). */
export async function copyFile(
  env: Pick<SshEnv, 'host' | 'dir'>,
  content: Buffer,
  remotePath: string,
): Promise<string | undefined> {
  const r = await run(writeFileCommand(env, remotePath), { input: content });
  return r.code === 0 ? undefined : `Could not copy the file to ${env.host}: ${sshWhy(r.stderr)}`;
}
