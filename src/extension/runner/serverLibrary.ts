// AFD-295: the library of the Ansible Flow Server set for a folder (afd.runner.url): the subflows
// its library projects offer, listed once a minute at most per server, for Insert Shared Subflow…
// and for checking the flow's library copies; and one subflow as it is now, to copy.
import type * as vscode from 'vscode';
import type { LibrarySubflow } from '../../core/flow/library';
import type { FlowNode } from '../../core/flow/types';
import { RunnerError } from '../../node/runner/client';
import { runnerClient, runnerConfigured, runnerUrl } from './runnerRun';

const FRESH_MS = 60_000;

interface Listing {
  at: number;
  subflows?: LibrarySubflow[];
  error?: string;
  pending?: Promise<boolean>;
}

export class ServerLibrary {
  private readonly listings = new Map<string, Listing>();

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** What was listed last for the folder's server, without asking it; undefined when nothing. */
  cached(scope: vscode.Uri): LibrarySubflow[] | undefined {
    const url = runnerUrl(scope);
    return url ? this.listings.get(url)?.subflows : undefined;
  }

  /** Whether the listing is older than a minute (or there is none). */
  stale(scope: vscode.Uri): boolean {
    const url = runnerUrl(scope);
    if (!url) return false;
    const l = this.listings.get(url);
    return !l || Date.now() - l.at > FRESH_MS;
  }

  /** Lists the library again (once at a time per server); true when what it offers changed. */
  refresh(scope: vscode.Uri): Promise<boolean> {
    const url = runnerUrl(scope);
    if (!url || !runnerConfigured(scope)) return Promise.resolve(false);
    const before = this.listings.get(url);
    if (before?.pending) return before.pending;
    const pending = (async () => {
      const client = await runnerClient(scope, this.secrets);
      let next: Listing;
      if ('error' in client) next = { at: Date.now(), error: client.error };
      else
        try {
          next = { at: Date.now(), subflows: (await client.library()).subflows };
        } catch (e) {
          // A server without a library (older) or out of reach: nothing is said about copies.
          next = { at: Date.now(), error: e instanceof RunnerError ? e.message : String(e) };
        }
      this.listings.set(url, next);
      return JSON.stringify(next.subflows) !== JSON.stringify(before?.subflows);
    })();
    this.listings.set(url, { at: before?.at ?? 0, ...before, pending });
    return pending;
  }

  /** The library's subflows now, or why there are none. */
  async list(scope: vscode.Uri): Promise<{ subflows?: LibrarySubflow[]; error?: string }> {
    if (!runnerConfigured(scope)) return {};
    await this.refresh(scope);
    const l = this.listings.get(runnerUrl(scope) ?? '');
    return {
      ...(l?.subflows ? { subflows: l.subflows } : {}),
      ...(l?.error ? { error: l.error } : {}),
    };
  }

  /** One subflow as the library has it now. */
  async subflow(
    scope: vscode.Uri,
    from: string,
  ): Promise<{ node?: FlowNode; version?: number; commit?: string; error?: string }> {
    const client = await runnerClient(scope, this.secrets);
    if ('error' in client) return { error: client.error };
    try {
      const got = await client.librarySubflow(from);
      return { node: got.node, version: got.version, commit: got.commit };
    } catch (e) {
      return { error: e instanceof RunnerError ? e.message : String(e) };
    }
  }
}
