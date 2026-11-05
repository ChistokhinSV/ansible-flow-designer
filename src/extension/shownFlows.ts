// What the designer last showed of each flow (AFD-92, wave 9 group H), so an edit made while the
// flow was closed is marked when it opens again (round 2: S12). Per workspace, in its storage:
// `shown/<hash>.yaml` holds the text, `shown/index.json` which file it was and when. Nothing is
// kept without a workspace folder. Only the designer's own moments write here (its last panel
// closing, a save while it is open, Clear), never an agent's edit to a flow nobody has open.
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { shownToDrop } from '../core/view/outsideChanges';

interface Entry {
  uri: string;
  at: string;
}

const keyOf = (uri: vscode.Uri) =>
  createHash('sha1').update(uri.toString()).digest('hex').slice(0, 20);

export class ShownFlows {
  private index?: Promise<Record<string, Entry>>;
  /** Writes one at a time, so the index never loses an entry to a race. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: vscode.Uri | undefined) {}

  private get dir(): vscode.Uri | undefined {
    return this.root ? vscode.Uri.joinPath(this.root, 'shown') : undefined;
  }

  private load(): Promise<Record<string, Entry>> {
    this.index ??= (async () => {
      const dir = this.dir;
      if (!dir) return {};
      try {
        const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'index.json'));
        return JSON.parse(new TextDecoder().decode(raw)) as Record<string, Entry>;
      } catch {
        return {};
      }
    })();
    return this.index;
  }

  private write<T>(job: (dir: vscode.Uri, index: Record<string, Entry>) => Promise<T>) {
    const dir = this.dir;
    if (!dir) return Promise.resolve(undefined);
    const next = this.queue.then(async () => {
      const index = await this.load();
      await vscode.workspace.fs.createDirectory(dir);
      const out = await job(dir, index);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(dir, 'index.json'),
        new TextEncoder().encode(JSON.stringify(index)),
      );
      return out;
    });
    // A failed write (a full disk, a removed folder) costs a mark later, never the session.
    this.queue = next.catch(() => undefined);
    return next.catch(() => undefined);
  }

  /** The flow as the designer shows it now. */
  remember(uri: vscode.Uri, text: string): Promise<void> {
    return this.write(async (dir, index) => {
      const key = keyOf(uri);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(dir, `${key}.yaml`),
        new TextEncoder().encode(text),
      );
      index[key] = { uri: uri.toString(), at: new Date().toISOString() };
    }).then(() => undefined);
  }

  /** What the designer last showed of this flow, and when. */
  async recall(uri: vscode.Uri): Promise<{ text: string; at: string } | undefined> {
    const dir = this.dir;
    if (!dir) return undefined;
    await this.queue;
    const key = keyOf(uri);
    const entry = (await this.load())[key];
    if (!entry || entry.uri !== uri.toString()) return undefined;
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, `${key}.yaml`));
      return { text: new TextDecoder().decode(raw), at: entry.at };
    } catch {
      return undefined;
    }
  }

  /** Drops flows not shown for 90 days, then all past the 300 most recent. */
  prune(now = Date.now()): Promise<void> {
    return this.write(async (dir, index) => {
      for (const key of shownToDrop(index, now)) {
        delete index[key];
        await Promise.resolve(
          vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, `${key}.yaml`)),
        ).catch(() => undefined);
      }
    }).then(() => undefined);
  }

  /** Test API: forget every flow. */
  forget(): Promise<void> {
    return this.write(async (dir, index) => {
      for (const key of Object.keys(index)) {
        delete index[key];
        await Promise.resolve(
          vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, `${key}.yaml`)),
        ).catch(() => undefined);
      }
    }).then(() => undefined);
  }
}
