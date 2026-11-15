// AFD-283: merging a flow file the way git asks a merge driver to, and the merge left for a person
// to finish. The driver writes the merged flow over "ours"; when the two sides changed the same
// place, it writes the flow with "ours" for each such place, keeps the three versions beside the
// repository's git folder (never in the work tree), and tells git the file is not merged. The
// designer reads that state, lets the person choose, and writes the file again.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlow } from '../core/flow/document';
import { type FlowMerge, type MergeSide, mergeFlows } from '../core/flow/merge';
import { writeMergedFlow } from '../core/flow/mergeText';
import type { FlowDocument } from '../core/flow/types';
import { validateFlow } from '../core/flow/validate';

/** A merge waiting for choices: the three versions, the file, and what was chosen so far. */
export interface MergeState {
  /** The file's path in the repository, as git names it. */
  file: string;
  base: string;
  ours: string;
  theirs: string;
  choices: Record<string, MergeSide>;
  at: string;
}

export const MERGE_FOLDER = 'afd-merge';

/** Where the merge of `file` waits, in the repository's git folder. */
export function mergeStatePath(gitDir: string, file: string): string {
  return join(gitDir, MERGE_FOLDER, `${encodeURIComponent(file.replaceAll('\\', '/'))}.json`);
}

export function readMergeState(gitDir: string, file: string): MergeState | undefined {
  const path = mergeStatePath(gitDir, file);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as MergeState;
  } catch {
    return undefined;
  }
}

export function writeMergeState(gitDir: string, state: MergeState): void {
  const path = mergeStatePath(gitDir, state.file);
  mkdirSync(join(gitDir, MERGE_FOLDER), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 1)}\n`);
}

export function removeMergeState(gitDir: string, file: string): void {
  rmSync(mergeStatePath(gitDir, file), { force: true });
}

export type Merged =
  /** Not three flows this can read: the caller merges the text instead. */
  | { kind: 'not-flows'; why: string }
  | {
      kind: 'merged';
      text: string;
      merge: FlowMerge;
      /** Errors in the merged flow that neither side had: a person looks before it is taken. */
      broken: string[];
    };

const errorsOf = (doc: FlowDocument) =>
  new Set(
    validateFlow(doc)
      .findings.filter((f) => f.severity === 'error')
      .map((f) => f.message),
  );

/** Merges three versions of a flow file's text, with `choices` made so far. */
export function mergeFlowTexts(
  base: string,
  ours: string,
  theirs: string,
  choices: Record<string, MergeSide> = {},
): Merged {
  const docs = [base, ours, theirs].map((t) => parseFlow(t));
  const names = ['the common version', 'ours', 'theirs'];
  for (const [i, d] of docs.entries())
    if (!d.doc) return { kind: 'not-flows', why: `${names[i]} is not a flow this can read` };
  const [b, o, t] = docs.map((d) => d.doc as FlowDocument) as [
    FlowDocument,
    FlowDocument,
    FlowDocument,
  ];
  const merge = mergeFlows(b, o, t, choices);
  let text: string;
  try {
    text = writeMergedFlow(ours, merge.doc);
  } catch (e) {
    return {
      kind: 'not-flows',
      why: `the merged flow could not be written: ${(e as Error).message}`,
    };
  }
  const had = new Set([...errorsOf(o), ...errorsOf(t)]);
  const broken = [...errorsOf(merge.doc)].filter((m) => !had.has(m));
  return { kind: 'merged', text, merge, broken };
}

// --- setting a repository up (Set Up Flow Merging in Repository)

export const MERGE_ATTRIBUTES = ['*.flow.yaml merge=ansible-flow', '*.flow.yml merge=ansible-flow'];
export const MERGE_DRIVER = 'node .afd/afd-merge.js %O %A %B %P';

/** `.gitattributes` with the flow lines it lacks, or undefined when it has them all. */
export function withMergeAttributes(text: string): string | undefined {
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' ')));
  const missing = MERGE_ATTRIBUTES.filter((l) => !have.has(l));
  if (!missing.length) return undefined;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const head = text === '' || text.endsWith('\n') ? text : `${text}${eol}`;
  return `${head}# Flows merge by their steps, not their lines (Ansible Flow Designer)${eol}${missing.join(eol)}${eol}`;
}
