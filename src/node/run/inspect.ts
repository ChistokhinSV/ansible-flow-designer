// ADR-0040 §2 (AFD-370): the driver's side of a paused debug run's requests. A request is
// request-<n>.json in the run folder, written whole; the run answers with answer-<n>.json on its
// 100 ms tick. Answers never go through events.jsonl: its tail is too slow.
// - Local, WSL and container runs share the run folder with this machine: the answer file is
//   polled every 25 ms, only while a request waits (fs.watch is unreliable on bind mounts and /mnt).
// - SSH runs keep one ssh channel open (a relay in sh on the host), and fall back to one ssh per
//   request when it dies.
import { type ChildProcess, spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { askCommand, relayCommand } from '../../core/run/ssh';
import { answerFile, type InspectAnswer, requestFile } from '../../core/run/step';
import { run } from '../ssh/exec';
import type { SshEnv } from '../ssh/remote';
import { writeWhole } from './stepChannel';

/** How often an answer file is looked for while a request waits. */
export const POLL_MS = 25;
/** How long a request waits for its answer (the run answers within its 100 ms tick, or its 2 s
 * render limit, unless it is busy). */
export const ANSWER_MS = 30_000;

export interface Inspector {
  /** Sends request `n` (its body) and resolves with the answer; never rejects. */
  ask(n: number, body: Record<string, unknown>): Promise<InspectAnswer>;
  /** Closes a kept-open channel (the run ended). */
  close(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noAnswer: InspectAnswer = { error: 'The run did not answer' };

/** A run whose folder is here (local, WSL, container). */
export function localInspector(runDir: string, waitMs = ANSWER_MS): Inspector {
  return {
    async ask(n, body) {
      const answer = join(runDir, answerFile(n));
      try {
        await writeWhole(join(runDir, requestFile(n)), JSON.stringify(body));
      } catch (e) {
        return { error: `Could not write the request: ${e instanceof Error ? e.message : e}` };
      }
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        try {
          const text = await readFile(answer, 'utf8');
          await unlink(answer).catch(() => undefined);
          return JSON.parse(text) as InspectAnswer;
        } catch {
          await sleep(POLL_MS);
        }
      }
      await unlink(join(runDir, requestFile(n))).catch(() => undefined);
      return noAnswer;
    },
    close() {},
  };
}

function parse(text: string): InspectAnswer {
  try {
    const a = JSON.parse(text) as unknown;
    return a && typeof a === 'object' ? (a as InspectAnswer) : noAnswer;
  } catch {
    return noAnswer;
  }
}

/** A run on an SSH host: the kept-open relay, or one ssh per request once it died. */
export function sshInspector(env: SshEnv, runDir: string): Inspector {
  let relay: ChildProcess | undefined;
  let dead = false;
  const waiting = new Map<number, (a: InspectAnswer | undefined) => void>();
  const fail = () => {
    dead = true;
    relay = undefined;
    // Each waiting request is asked again the fallback way.
    for (const [, resolve] of waiting) resolve(undefined);
    waiting.clear();
  };
  const open = (): ChildProcess | undefined => {
    if (dead) return undefined;
    if (relay) return relay;
    const c = relayCommand(env, runDir);
    try {
      const proc = spawn(c.command, c.args, {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      proc.on('error', fail);
      proc.on('close', fail);
      proc.stdin?.on('error', fail);
      createInterface({ input: proc.stdout as NodeJS.ReadableStream }).on('line', (line) => {
        const space = line.indexOf(' ');
        const n = Number(line.slice(0, space));
        const resolve = waiting.get(n);
        if (!resolve) return;
        waiting.delete(n);
        resolve(parse(line.slice(space + 1)));
      });
      relay = proc;
      return proc;
    } catch {
      dead = true;
      return undefined;
    }
  };
  const once = async (n: number, text: string): Promise<InspectAnswer> => {
    const r = await run(askCommand(env, runDir, n), { input: text, timeoutMs: ANSWER_MS + 15_000 });
    return r.code === 0 ? parse(r.stdout) : noAnswer;
  };
  return {
    async ask(n, body) {
      const text = JSON.stringify(body);
      const proc = open();
      if (proc?.stdin) {
        const answer = await new Promise<InspectAnswer | undefined>((resolve) => {
          waiting.set(n, resolve);
          proc.stdin?.write(`${n}\n${text}\n`);
        });
        if (answer) return answer;
      }
      return once(n, text);
    },
    close() {
      dead = true;
      relay?.stdin?.end();
      relay?.kill();
      relay = undefined;
    },
  };
}
