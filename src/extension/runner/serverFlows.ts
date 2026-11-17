// AFD-303: for each folder connected to Ansible Flow Server, which of its flows are the project's.
// Read from the server (the project's flows at its commit, and the text of each one the folder also
// has) and from git (what was changed here since that commit). Read again when the flows, the
// connection or the window's focus change, and on Refresh; one reading at a time.
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  type ServerFlowState,
  type ServerFlows,
  sameText,
  serverFlows,
} from '../../core/view/serverFlows';
import { RunnerClient } from '../../node/runner/client';
import { changedSince } from '../../node/runner/projectGit';
import { config, folderProject, tokenKey } from './connect';

export interface FolderServerFlows {
  project: string;
  flows: ServerFlows;
  /** The server has commits this folder's repository does not: pull to get them. */
  behind: boolean;
  /** The folder is a git repository (else every flow that differs counts as changed here). */
  repo: boolean;
}

/** At most this many flows are compared by text in one reading. */
const COMPARE_LIMIT = 300;
/** Requests to the server at the same time while comparing. */
const AT_ONCE = 4;
/** Readings asked for within this long are one. */
const SETTLE_MS = 800;

/** Runs the jobs, at most `n` at a time. */
async function pooled<T>(items: readonly T[], n: number, job: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await job(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export class ServerFlowsState implements vscode.Disposable {
  private readonly by = new Map<string, FolderServerFlows>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private running: Promise<void> | undefined;
  private again = false;
  private settle: NodeJS.Timeout | undefined;
  /** The server's text of a flow at a commit never changes: kept per project, for its commit. */
  private readonly texts = new Map<string, { commit: string; text: Map<string, string> }>();

  constructor(
    private readonly secrets: vscode.SecretStorage,
    /** The flows of a workspace folder, relative to it with `/`. */
    private readonly localFlows: (folder: vscode.WorkspaceFolder) => Promise<string[]>,
  ) {}

  dispose(): void {
    clearTimeout(this.settle);
    this.emitter.dispose();
  }

  /** Reads again a moment after the last ask (file saves and focus come in bursts). */
  soon(): void {
    clearTimeout(this.settle);
    this.settle = setTimeout(() => void this.refresh(), SETTLE_MS);
  }

  folder(folder: vscode.WorkspaceFolder): FolderServerFlows | undefined {
    return this.by.get(folder.uri.toString());
  }

  stateOf(uri: vscode.Uri): ServerFlowState | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;
    const rel = uri.path.slice(folder.uri.path.replace(/\/+$/, '').length + 1);
    return this.folder(folder)?.flows.states.get(rel);
  }

  /** Reads again (a reading asked for while one runs follows it). */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.read();
      } while (this.again);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async read(): Promise<void> {
    const seen = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const key = folder.uri.toString();
      seen.add(key);
      const read = await this.readFolder(folder).catch(() => undefined);
      if (read) this.by.set(key, read);
      else this.by.delete(key);
    }
    for (const key of [...this.by.keys()]) if (!seen.has(key)) this.by.delete(key);
    this.emitter.fire();
  }

  private async readFolder(folder: vscode.WorkspaceFolder): Promise<FolderServerFlows | undefined> {
    const { url, verifyTls, allowHttp } = config(folder.uri);
    const token = url ? await this.secrets.get(tokenKey(url)) : undefined;
    // AFD-318: the project the folder's git remote is, as runs and pulls use it.
    const project = url ? await folderProject(folder.uri) : '';
    if (!url || !token || !project) return undefined;
    const client = new RunnerClient(url, token, { verifyTls, allowHttp });
    const [ws, key] = project.split('/');
    if (!ws || !key) return undefined;
    const p = (await client.projects(ws)).find((x) => x.key === key);
    if (!p) return undefined;
    const listed = await client.flows(p.id);
    const commit = listed.commit;
    const server = listed.flows.map((f) => f.file);
    const local = await this.localFlows(folder);
    const differs = new Set<string>();
    const both = local.filter((path) => server.includes(path)).slice(0, COMPARE_LIMIT);
    if (commit) {
      let kept = this.texts.get(p.id);
      if (kept?.commit !== commit) {
        kept = { commit, text: new Map() };
        this.texts.set(p.id, kept);
      }
      const cache = kept.text;
      await pooled(both, AT_ONCE, async (path) => {
        let there = cache.get(path);
        if (there === undefined) {
          there = await client.fileText(p.id, path, commit);
          cache.set(path, there);
        }
        const here = await readFile(vscode.Uri.joinPath(folder.uri, path).fsPath, 'utf8');
        if (!sameText(there, here)) differs.add(path);
      });
    }
    const git = await changedSince(folder.uri.fsPath, commit).catch(() => undefined);
    return {
      project,
      flows: serverFlows(local, server, differs, git ? git.changed : differs),
      behind: git?.behind ?? false,
      repo: !!git,
    };
  }
}
