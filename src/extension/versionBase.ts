// What flow.version moves against (ADR-0006): HEAD's text of the flow, read ahead of the save
// participant's short budget (AFD-164), or the last saved text outside Git. A flow in a repository
// that HEAD does not hold yet (new, or a copy) keeps its version until it is committed (AFD-377:
// every save of a new flow bumped it, v1 to v10 in one session).
import type * as vscode from 'vscode';
import { headText } from './gitHead';

/** HEAD's text of each open flow, as last read: null when the repository does not hold it. */
const heads = new Map<string, string | null | undefined>();

export function prefetchHead(uri: vscode.Uri): Promise<string | null | undefined> {
  return headText(uri)
    .then((text) => {
      heads.set(uri.toString(), text);
      return text;
    })
    .catch(() => heads.get(uri.toString()));
}

/** HEAD's text, read now if Git answers within `ms`, else the copy read before. */
export async function headWithin(uri: vscode.Uri, ms: number): Promise<string | null | undefined> {
  const known = heads.get(uri.toString());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string | null | undefined>((resolve) => {
    timer = setTimeout(() => resolve(known), ms);
  });
  try {
    return await Promise.race([prefetchHead(uri), late]);
  } finally {
    clearTimeout(timer);
  }
}

export function forgetHead(uri: vscode.Uri): void {
  heads.delete(uri.toString());
}

/**
 * The text the version moves against: HEAD's, the last saved one outside Git, or undefined when
 * no bump is due (a flow Git does not hold yet).
 */
export function baseOf(head: string | null | undefined, lastSaved: string | undefined) {
  return head === null ? undefined : (head ?? lastSaved);
}

/** As last read, for a designer edit that carries its bump (AFD-377); refreshed for the next. */
export function knownBase(uri: vscode.Uri, lastSaved: string | undefined): string | undefined {
  const head = heads.get(uri.toString());
  void prefetchHead(uri);
  return baseOf(head, lastSaved);
}
