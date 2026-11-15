// AFD-283: the merge git left for an open flow. The merge driver (dist/afd-merge.js) keeps the
// three versions in the repository's git folder; here they are found for a file, a choice is
// applied to the file, and Finish takes it as merged (git add).
import { execFile } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import type { MergeSide } from '../core/flow/merge';
import { writeMergedFlow } from '../core/flow/mergeText';
import type { MergeView } from '../core/protocol';
import {
  type MergeState,
  mergeFlowTexts,
  readMergeState,
  removeMergeState,
  writeMergeState,
} from '../node/flowMerge';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) =>
    execFile('git', args, { cwd, timeout: 15_000, windowsHide: true }, (error, stdout) =>
      error ? fail(error) : done(stdout.trim()),
    ),
  );
}

export interface WaitingMerge {
  root: string;
  gitDir: string;
  file: string;
  state: MergeState;
}

/** The merge waiting for the flow at `fsPath`, if git left one. */
export async function waitingMerge(fsPath: string): Promise<WaitingMerge | undefined> {
  const cwd = dirname(fsPath);
  let lines: string[];
  try {
    lines = (await git(cwd, ['rev-parse', '--show-toplevel', '--git-dir'])).split(/\r?\n/);
  } catch {
    return undefined;
  }
  const [root, gitDir] = lines;
  if (!root || !gitDir) return undefined;
  const file = relative(root, fsPath).replaceAll('\\', '/');
  const absGitDir = resolve(cwd, gitDir);
  const state = readMergeState(absGitDir, file);
  return state ? { root, gitDir: absGitDir, file, state } : undefined;
}

/** The merge as the designer shows it, and the file's text with the choices made. */
export function mergeView(w: WaitingMerge, current: string): { view: MergeView; text?: string } {
  const { base, ours, theirs, choices } = w.state;
  const merged = mergeFlowTexts(base, ours, theirs, choices);
  if (merged.kind !== 'merged')
    return { view: { file: w.file, conflicts: [], broken: [merged.why] } };
  const view: MergeView = {
    file: w.file,
    conflicts: merged.merge.conflicts.map((c) => ({ ...c, chosen: choices[c.id] ?? 'ours' })),
    broken: merged.broken,
  };
  // Written over the file as it is now (its comments and formatting stay); the merge decides the
  // content, so a choice can be changed back.
  let text: string | undefined;
  try {
    text = writeMergedFlow(current, merged.merge.doc);
  } catch {
    text = undefined;
  }
  return { view, ...(text !== undefined ? { text } : {}) };
}

export function choose(w: WaitingMerge, id: string, side: MergeSide): void {
  w.state = { ...w.state, choices: { ...w.state.choices, [id]: side } };
  writeMergeState(w.gitDir, w.state);
}

/** The merge is done: its state goes, and git takes the file as merged. */
export async function finish(w: WaitingMerge): Promise<void> {
  removeMergeState(w.gitDir, w.file);
  await git(w.root, ['add', '--', w.file]);
}
