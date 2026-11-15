// AFD-284: what the designer says when the flow it shows changed on Ansible Flow Server's branch
// beyond the local HEAD: who changed it and how much, or that it is gone there. Pure: the
// extension gives the server's answer and the two versions.
import { diffFlows } from '../flow/semanticDiff';
import type { FlowDocument } from '../flow/types';

/** The notice over the canvas; null clears it. */
export interface ServerChange {
  /** The server's commit the notice is about (Update brings it here). */
  commit: string;
  /** "Mia Ortega changed this flow on the server: 1 step." */
  text: string;
  removed?: boolean;
}

export interface ChangedFlow {
  file: string;
  change: 'added' | 'changed' | 'removed';
  authors: string[];
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Who, in words: one or two names, else the first two and how many more. */
export function namesText(authors: readonly string[]): string {
  if (!authors.length) return 'Someone';
  return authors.length <= 2
    ? authors.join(' and ')
    : `${authors.slice(0, 2).join(', ')} and ${authors.length - 2} more`;
}

/** "3 steps and 1 wire": how much the server's version differs from the one here. */
export function howMuch(here: FlowDocument, there: FlowDocument): string {
  const d = diffFlows(here, there);
  const parts = [
    d.nodes.length ? plural(d.nodes.length, 'step') : '',
    d.wires.length ? plural(d.wires.length, 'wire') : '',
    d.annotations.length ? plural(d.annotations.length, 'note') : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' and ') : "the flow's settings";
}

/**
 * The notice for `file` given the server's changes since the local HEAD, or undefined when the
 * server's branch did not change this flow.
 */
export function serverChangeOf(
  commit: string,
  changed: readonly ChangedFlow[],
  file: string,
  here?: FlowDocument,
  there?: FlowDocument,
): ServerChange | undefined {
  const mine = changed.find((c) => c.file === file);
  if (!mine) return undefined;
  const who = namesText(mine.authors);
  if (mine.change === 'removed')
    return { commit, removed: true, text: `${who} removed this flow on the server.` };
  const amount = here && there ? `: ${howMuch(here, there)}` : '';
  return { commit, text: `${who} changed this flow on the server${amount}.` };
}
