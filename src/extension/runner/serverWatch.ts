// AFD-284: a flow open in the designer, in a clone of an Ansible Flow Server project, follows the
// server's branch. When the branch moves past the local HEAD and changes this flow, the designer
// says who changed it and how much, with Show changes (pull, then the Changes lens against the
// version shown before) and Update (pull). Pull is fast-forward only, and refused while the flow
// has changes here that are not committed: nothing is overwritten.
import { execFile } from 'node:child_process';
import { dirname, relative } from 'node:path';
import * as vscode from 'vscode';
import { parseFlow } from '../../core/flow/document';
import type { FlowDocument } from '../../core/flow/types';
import { type ServerChange, serverChangeOf } from '../../core/view/serverChange';
import { RunnerError } from '../../node/runner/client';
import { logChannel } from '../log';
import { projectOf, runnerClient, runnerConfigured } from './runnerRun';

/** What the watcher needs of a designer session. */
export interface WatchedFlow {
  readonly uri: vscode.Uri;
  text(): string;
  isDirty(): boolean;
  save(): Promise<boolean>;
  setServerChange(change: ServerChange | null): void;
  /** Opens the Changes lens against a version of the file (a commit that changed it). */
  compareWith(ref: string): Promise<void>;
}

function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((done, fail) =>
    execFile('git', args, { cwd, timeout, windowsHide: true }, (error, stdout, stderr) =>
      error ? fail(new Error((stderr || error.message).trim())) : done(stdout.trim()),
    ),
  );
}

interface Place {
  root: string;
  /** The file's path in the repository, forward slashes. */
  file: string;
}

async function placeOf(uri: vscode.Uri): Promise<Place | undefined> {
  if (uri.scheme !== 'file') return undefined;
  try {
    const root = await git(dirname(uri.fsPath), ['rev-parse', '--show-toplevel']);
    return { root, file: relative(root, uri.fsPath).replaceAll('\\', '/') };
  } catch {
    return undefined;
  }
}

interface Stream {
  stop(): void;
  flows: Set<WatchedFlow>;
  project: string;
  commit?: string;
}

export class ServerWatch implements vscode.Disposable {
  /** By server address and project. */
  private readonly streams = new Map<string, Stream>();
  private readonly projectOfFlow = new Map<WatchedFlow, string>();
  /** The commit each flow's notice was dismissed for: it stays away until the branch moves on. */
  private readonly dismissed = new Map<WatchedFlow, string>();
  private readonly shown = new Map<WatchedFlow, ServerChange>();
  /** Flows open before a server, token or project was there: tried again when a token is set. */
  private readonly waiting = new Set<WatchedFlow>();

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Starts following the server for a flow open in the designer (nothing without a server). */
  async follow(flow: WatchedFlow): Promise<void> {
    if (this.projectOfFlow.has(flow)) return;
    this.waiting.add(flow);
    if (!runnerConfigured(flow.uri)) return;
    const folder = vscode.workspace.getWorkspaceFolder(flow.uri)?.uri;
    if (!folder) return;
    const client = await runnerClient(flow.uri, this.secrets);
    if ('error' in client) return;
    let project: Awaited<ReturnType<typeof projectOf>>;
    try {
      project = await projectOf(client, folder);
    } catch {
      return;
    }
    if (!project || this.projectOfFlow.has(flow)) return;
    this.waiting.delete(flow);
    const key = `${client.base}|${project.id}`;
    this.projectOfFlow.set(flow, key);
    let stream = this.streams.get(key);
    if (!stream) {
      const created: Stream = { stop: () => undefined, flows: new Set(), project: project.id };
      created.stop = client.follow(project.id, (e) => {
        const to = e.type === 'moved' ? e.to : e.commit;
        if (!to) return;
        created.commit = to;
        for (const f of created.flows) void this.check(f, created, to);
      });
      this.streams.set(key, created);
      stream = created;
    }
    stream.flows.add(flow);
    if (stream.commit) void this.check(flow, stream, stream.commit);
  }

  /** A token was set (or the settings changed): the flows that could not follow try again. */
  retry(): void {
    for (const flow of [...this.waiting]) void this.follow(flow).catch(() => undefined);
  }

  /** The flow's designer closed. */
  forget(flow: WatchedFlow): void {
    this.waiting.delete(flow);
    const key = this.projectOfFlow.get(flow);
    this.projectOfFlow.delete(flow);
    this.dismissed.delete(flow);
    this.shown.delete(flow);
    const stream = key ? this.streams.get(key) : undefined;
    if (!stream || !key) return;
    stream.flows.delete(flow);
    if (!stream.flows.size) {
      stream.stop();
      this.streams.delete(key);
    }
  }

  /** What the server's branch did to this flow since the local HEAD. */
  private async check(flow: WatchedFlow, stream: Stream, to: string): Promise<void> {
    const show = (change: ServerChange | null) => {
      if (change && this.dismissed.get(flow) === change.commit) change = null;
      if (change) this.shown.set(flow, change);
      else this.shown.delete(flow);
      flow.setServerChange(change);
    };
    const place = await placeOf(flow.uri);
    if (!place) return;
    let head: string;
    try {
      head = await git(place.root, ['rev-parse', 'HEAD']);
    } catch {
      return;
    }
    if (head === to) return show(null);
    const client = await runnerClient(flow.uri, this.secrets);
    if ('error' in client) return;
    try {
      const changes = await client.changes(stream.project, head, to);
      let here: FlowDocument | undefined;
      let there: FlowDocument | undefined;
      if (changes.flows.some((c) => c.file === place.file && c.change !== 'removed')) {
        here = parseFlow(flow.text()).doc;
        there = (await client.flowAt(stream.project, place.file, to)).snapshot.doc as
          | FlowDocument
          | undefined;
      }
      show(serverChangeOf(to, changes.flows, place.file, here, there) ?? null);
    } catch (e) {
      // A local commit the server does not have (work not pushed yet): nothing to compare there.
      if (e instanceof RunnerError && e.code === 'unknown_commit') return show(null);
      logChannel().warn(`Server changes for ${place.file}: ${(e as Error).message}`);
    }
  }

  dismiss(flow: WatchedFlow): void {
    const change = this.shown.get(flow);
    if (change) this.dismissed.set(flow, change.commit);
    this.shown.delete(flow);
    flow.setServerChange(null);
  }

  /** Update (and Show changes): pulls the server's commits, fast-forward only. */
  async update(flow: WatchedFlow, compare: boolean): Promise<void> {
    const place = await placeOf(flow.uri);
    if (!place) return;
    if (flow.isDirty()) {
      void vscode.window.showWarningMessage(
        'Save your changes to this flow first, then Update (or commit them: git merges flows by their steps when Set Up Flow Merging is done).',
      );
      return;
    }
    try {
      if (await git(place.root, ['status', '--porcelain', '--', place.file])) {
        void vscode.window.showWarningMessage(
          'This flow has changes that are not committed: commit or stash them, then Update.',
        );
        return;
      }
      const before = await git(place.root, ['log', '-1', '--format=%H', 'HEAD', '--', place.file]);
      await git(place.root, ['pull', '--ff-only'], 120_000);
      this.dismissed.delete(flow);
      this.shown.delete(flow);
      flow.setServerChange(null);
      // VS Code reloads a saved document from disk on its own; the lens then compares.
      if (compare && before) await flow.compareWith(before);
    } catch (e) {
      const why = (e as Error).message;
      void vscode.window.showErrorMessage(
        /fast-forward|diverg/i.test(why)
          ? 'Your branch and the server’s have both moved: pull and merge them (Set Up Flow Merging merges flows by their steps).'
          : `git pull failed: ${why.split('\n')[0]}`,
      );
    }
  }

  dispose(): void {
    for (const s of this.streams.values()) s.stop();
    this.streams.clear();
  }
}
