// AFD-340 (ADR-0038): the repository's variables for the designer, built in the extension host from
// the workspace (core/inventory/varIndex), not in the webview. Each file is read once and kept until
// it is saved, created, deleted or renamed (as the Inventory view's watcher does), and an index is
// kept per request until a file it may read changes or the inventory setting does.
import * as vscode from 'vscode';
import type { InventoryFs } from '../core/inventory/files';
import { buildVarIndex, type VarIndex, type VarIndexRequest } from '../core/inventory/varIndex';
import { workspaceFs } from './inventoryFiles';

/** Files that never hold variables a run loads: flows, generated code, git. */
const IGNORED = /(^|\/)(\.git|node_modules|generated)\/|\.flow\.ya?ml$|\.scenarios\.ya?ml$/;

export class VarIndexService implements vscode.Disposable {
  private readonly texts = new Map<string, Promise<string | undefined>>();
  private readonly shapes = new Map<string, Promise<unknown>>();
  private readonly built = new Map<string, Promise<VarIndex>>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];
  private timer?: NodeJS.Timeout;
  /** Bumped by every change that may change an index. */
  generation = 0;
  /** Fires (settled) when a file an index may read, or the inventory setting, changed. */
  readonly onDidChange = this.changed.event;

  constructor() {
    const touched = (uri: vscode.Uri, shape: boolean) => this.touched(uri, shape);
    this.subscriptions = [
      this.changed,
      vscode.workspace.onDidSaveTextDocument((d) => touched(d.uri, false)),
      vscode.workspace.onDidCreateFiles((e) => {
        for (const f of e.files) touched(f, true);
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const f of e.files) touched(f, true);
      }),
      vscode.workspace.onDidRenameFiles((e) =>
        e.files.forEach((f) => {
          touched(f.oldUri, true);
          touched(f.newUri, true);
        }),
      ),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('afd.run.inventory')) this.forget();
      }),
    ];
  }

  private touched(uri: vscode.Uri, shape: boolean): void {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    const rel = uri.path.slice(folder.uri.path.replace(/\/$/, '').length + 1);
    if (IGNORED.test(rel)) return;
    const prefix = `${folder.uri.toString()}|`;
    // A folder deleted or renamed takes its files with it.
    for (const key of this.texts.keys())
      if (key === `${prefix}${rel}` || (shape && key.startsWith(`${prefix}${rel}/`)))
        this.texts.delete(key);
    if (shape)
      for (const key of this.shapes.keys()) if (key.startsWith(prefix)) this.shapes.delete(key);
    this.forget();
  }

  private forget(): void {
    this.generation++;
    this.built.clear();
    clearTimeout(this.timer);
    // A save of several files (Save All, a git checkout) answers once.
    this.timer = setTimeout(() => this.changed.fire(), 300);
  }

  /** The workspace folder's files, each read once until it changes. */
  private files(folder: vscode.Uri): InventoryFs {
    const fs = workspaceFs(folder);
    const at = `${folder.toString()}|`;
    const cached = <T>(map: Map<string, Promise<T>>, key: string, get: () => Promise<T>) => {
      let p = map.get(key);
      if (!p) {
        p = get();
        map.set(key, p);
      }
      return p;
    };
    return {
      read: (path) => cached(this.texts, `${at}${path}`, () => fs.read(path)),
      list: (path) =>
        cached(this.shapes, `${at}list:${path}`, () => fs.list(path)) as ReturnType<
          InventoryFs['list']
        >,
      kind: (path) =>
        cached(this.shapes, `${at}kind:${path}`, () => fs.kind(path)) as ReturnType<
          InventoryFs['kind']
        >,
    };
  }

  /** The index of a request, built once per change of the files it may read. */
  index(folder: vscode.Uri, request: VarIndexRequest): Promise<VarIndex> {
    const key = `${folder.toString()}|${JSON.stringify(request)}`;
    let p = this.built.get(key);
    if (!p) {
      p = buildVarIndex(this.files(folder), request);
      this.built.set(key, p);
      p.catch(() => this.built.delete(key));
    }
    return p;
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const s of this.subscriptions) s.dispose();
  }
}
