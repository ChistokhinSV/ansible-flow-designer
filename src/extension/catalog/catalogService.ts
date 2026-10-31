// The catalog per repository folder and environment (M5, ADR-0011): the probe dumps plugin docs
// into global storage (only collection versions it has not dumped before), a worker builds the
// SQLite index for that exact set, and search, docs, roles and playbooks are answered from here.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { isPlaybook, type RepoFile, scanContext } from '../../core/catalog/context';
import type {
  CollectionFile,
  Manifest,
  PluginType,
  SearchContext,
  SearchHit,
} from '../../core/catalog/types';
import type { CatalogDoc, CatalogStatus, PlaybookInfo, RoleInfo } from '../../core/protocol';
import type { ProbeManager } from '../env/environment';
import type { ProbeClient } from '../env/probeClient';
import { CatalogIndex, INDEX_SCHEMA } from './catalogIndex';
import type { BuildJob, BuildResult } from './catalogWorker';

/** A first dump of a big EE takes about half a minute; slow disks and Podman machines more. */
const DUMP_TIMEOUT = 15 * 60_000;
const CONTEXT_TTL = 30_000;
/** Indexes kept on disk for other environments; the oldest go first. */
const KEEP_INDEXES = 6;
const EXCLUDE =
  '{**/node_modules/**,**/.git/**,**/.venv/**,**/venv/**,**/.tox/**,**/collections/ansible_collections/**}';
const MAX_FILES = 3000;

interface Entry {
  status: CatalogStatus;
  index?: CatalogIndex;
  /** Opened from the last scan without asking the probe; the next search checks the EE. */
  stale?: boolean;
  loading?: Promise<CatalogIndex>;
  context?: { at: number; value: Required<Omit<SearchContext, 'types'>> };
}

export interface CatalogDeps {
  storage: vscode.Uri;
  probes: ProbeManager;
  extensionUri: vscode.Uri;
  /** Remembers each folder's last index, so validation can use it without starting the probe. */
  state?: vscode.Memento;
}

const stateKey = (folder: vscode.WorkspaceFolder) => `afd.catalog.index:${folder.uri.toString()}`;

export function cacheDir(storage: vscode.Uri): string {
  return join(storage.fsPath, 'catalog');
}

/** Index file name for an exact set of collection versions (and our index format). */
export function indexName(manifest: Manifest): string {
  const key = JSON.stringify([
    INDEX_SCHEMA,
    manifest.core,
    manifest.collections.map((c) => `${c.name}@${c.version}`).sort(),
  ]);
  return `index-${createHash('sha256').update(key).digest('hex').slice(0, 16)}.db`;
}

export class CatalogService implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly changed = new vscode.EventEmitter<{ folder: string; status: CatalogStatus }>();
  readonly onStatus = this.changed.event;

  constructor(private readonly deps: CatalogDeps) {}

  private entry(folder: vscode.WorkspaceFolder): Entry {
    const key = folder.uri.toString();
    let e = this.entries.get(key);
    if (!e) {
      e = { status: { state: 'idle' } };
      this.entries.set(key, e);
    }
    return e;
  }

  private set(folder: vscode.WorkspaceFolder, status: CatalogStatus): void {
    const e = this.entry(folder);
    e.status = {
      ...status,
      platforms: e.context?.value.platforms,
      used: e.context?.value.collections.slice(0, 8),
    };
    this.changed.fire({ folder: folder.uri.toString(), status: e.status });
  }

  status(folder: vscode.WorkspaceFolder): CatalogStatus {
    return this.entry(folder).status;
  }

  /** The folder's index, loading it once (dump, build or open) with a progress notification. */
  ready(folder: vscode.WorkspaceFolder, rebuild = false): Promise<CatalogIndex> {
    const e = this.entry(folder);
    if (e.index && !rebuild && !e.stale) return Promise.resolve(e.index);
    if (e.loading) return e.loading;
    const loading = Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Ansible catalog' },
        (progress) => this.load(folder, rebuild, (message) => progress.report({ message })),
      ),
    ).then(
      (index) => {
        e.loading = undefined;
        return index;
      },
      (err: unknown) => {
        e.loading = undefined;
        this.set(folder, {
          state: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      },
    );
    e.loading = loading;
    return loading;
  }

  private async load(
    folder: vscode.WorkspaceFolder,
    rebuild: boolean,
    report: (message: string) => void,
  ): Promise<CatalogIndex> {
    const e = this.entry(folder);
    // Dumps run on a probe of their own, stopped when done (AFD-32).
    const probe = this.deps.probes.forFolder(folder.uri, 'catalog');
    if ('error' in probe) throw new Error(probe.error);
    if (!probe.cache) throw new Error('No catalog cache folder');
    try {
      return await this.loadWith(folder, probe, rebuild, report, e);
    } finally {
      this.deps.probes.release(folder.uri, 'catalog');
    }
  }

  private async loadWith(
    folder: vscode.WorkspaceFolder,
    probe: { client: ProbeClient; label: string; cache?: string },
    rebuild: boolean,
    report: (message: string) => void,
    e: Entry,
  ): Promise<CatalogIndex> {
    await this.context(folder);
    const step = (message: string) => {
      report(message);
      this.set(folder, { state: 'loading', message, environment: probe.label });
    };
    step('Reading plugin docs from the environment…');
    const call = () =>
      probe.client.call<Manifest>('catalog', { cache: probe.cache, jobs: 8 }, DUMP_TIMEOUT);
    let manifest = await call();
    const cache = cacheDir(this.deps.storage);
    if (rebuild) {
      e.index?.close();
      e.index = undefined;
      // Rebuild means the dumps too: a dump from a broken collection install is not kept.
      for (const c of manifest.collections) rmSync(join(cache, c.file), { force: true });
      rmSync(join(cache, indexName(manifest)), { force: true });
      step('Reading plugin docs again…');
      manifest = await call();
    }
    const failed = manifest.collections.filter((c) => c.error).map((c) => c.name);
    const path = join(cache, indexName(manifest));
    let index = existsSync(path) ? CatalogIndex.open(path) : undefined;
    if (!index) {
      step(`Indexing ${manifest.collections.length} collections…`);
      const files = manifest.collections.filter((c) => !c.error).map((c) => join(cache, c.file));
      const built = await this.build({ files, out: path });
      if (!built.ok) throw new Error(built.error);
      index = CatalogIndex.open(path);
      if (!index) throw new Error('The catalog index could not be opened');
      this.prune(cache, path);
    }
    e.index?.close();
    e.index = index;
    e.stale = false;
    void this.deps.state?.update(stateKey(folder), { path, environment: probe.label });
    this.set(folder, {
      state: 'ready',
      environment: probe.label,
      core: manifest.core,
      failed,
      ...index.stats(),
    });
    return index;
  }

  private build(job: BuildJob): Promise<BuildResult> {
    const script = vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'catalogWorker.js').fsPath;
    return new Promise((resolve) => {
      const worker = new Worker(script, { workerData: job });
      worker.once('message', (r: BuildResult) => resolve(r));
      worker.once('error', (err) => resolve({ ok: false, error: err.message }));
      worker.once(
        'exit',
        (code) => code !== 0 && resolve({ ok: false, error: `Indexing stopped (code ${code})` }),
      );
    });
  }

  /** Keeps the newest few indexes (other environments, older collection sets). */
  private prune(cache: string, keep: string): void {
    const old = readdirSync(cache)
      .filter((f) => /^index-[0-9a-f]+\.db$/.test(f) && join(cache, f) !== keep)
      .map((f) => ({ f, t: statSync(join(cache, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(KEEP_INDEXES - 1);
    for (const { f } of old) rmSync(join(cache, f), { force: true });
  }

  /** Test mode: an index from collection files on disk, without a probe. */
  useFiles(folder: vscode.WorkspaceFolder, files: CollectionFile[]): void {
    const e = this.entry(folder);
    e.index?.close();
    e.index = CatalogIndex.build(':memory:', files);
    this.set(folder, { state: 'ready', environment: 'test fixture', ...e.index.stats() });
  }

  /** Collections in use and inventory platforms, rescanned at most every 30 s. */
  async context(folder: vscode.WorkspaceFolder): Promise<Required<Omit<SearchContext, 'types'>>> {
    const e = this.entry(folder);
    if (e.context && Date.now() - e.context.at < CONTEXT_TTL) return e.context.value;
    const value = scanContext(await this.repoFiles(folder, '**/*.{yml,yaml,ini,cfg}'));
    e.context = { at: Date.now(), value };
    return value;
  }

  private async repoFiles(folder: vscode.WorkspaceFolder, glob: string): Promise<RepoFile[]> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, glob),
      EXCLUDE,
      MAX_FILES,
    );
    const out: RepoFile[] = [];
    for (const uri of uris) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > 512_000) continue;
        out.push({
          path: vscode.workspace.asRelativePath(uri, false),
          text: new TextDecoder().decode(bytes),
        });
      } catch {
        // Unreadable files say nothing about context.
      }
    }
    return out;
  }

  async search(
    folder: vscode.WorkspaceFolder,
    query: string,
    types?: PluginType[],
  ): Promise<SearchHit[]> {
    const index = await this.ready(folder);
    return index.search(query, { ...(await this.context(folder)), types }, 20);
  }

  async doc(
    folder: vscode.WorkspaceFolder,
    fqcn: string,
    type: PluginType = 'module',
  ): Promise<CatalogDoc | null> {
    const index = await this.ready(folder);
    const resolved = index.resolve(fqcn, [], type);
    const plugin = index.plugin(resolved.fqcn ?? fqcn, type);
    return plugin
      ? { ...plugin, collection_version: index.collectionVersion(plugin.collection) }
      : null;
  }

  /**
   * The folder's index for validation: the loaded one, else the last scan's from disk. Never
   * starts the probe, so opening a flow does not start a container.
   */
  cached(folder: vscode.WorkspaceFolder): { index: CatalogIndex; environment: string } | undefined {
    const e = this.entry(folder);
    if (!e.index) {
      const last = this.deps.state?.get<{ path: string; environment: string }>(stateKey(folder));
      const index = last && existsSync(last.path) ? CatalogIndex.open(last.path) : undefined;
      if (!index) return undefined;
      e.index = index;
      e.stale = true;
      // Quietly: the caller is building a snapshot already.
      e.status = { state: 'ready', environment: last?.environment, ...index.stats() };
    }
    return { index: e.index, environment: e.status.environment ?? 'the environment' };
  }

  /**
   * The environment settings changed (AFD-32): every loaded index belongs to the old environment,
   * so the next search asks the new one again. Validation keeps using the last index meanwhile.
   */
  environmentChanged(): void {
    for (const e of this.entries.values()) if (e.index) e.stale = true;
  }

  async roles(folder: vscode.WorkspaceFolder): Promise<RoleInfo[]> {
    const probe = this.deps.probes.forFolder(folder.uri);
    if ('error' in probe) throw new Error(probe.error);
    return probe.client.call<RoleInfo[]>('roles', {}, 120_000);
  }

  async playbooks(folder: vscode.WorkspaceFolder): Promise<PlaybookInfo[]> {
    return (await this.repoFiles(folder, '**/*.{yml,yaml}'))
      .filter(isPlaybook)
      .map((f) => ({ path: f.path, plays: playsOf(f.text) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  dispose(): void {
    for (const e of this.entries.values()) e.index?.close();
    this.entries.clear();
    this.changed.dispose();
  }
}

function playsOf(text: string): PlaybookInfo['plays'] {
  try {
    const data = parse(text) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .map((p) => ({
        name: typeof p.name === 'string' ? p.name : undefined,
        hosts:
          typeof p.hosts === 'string'
            ? p.hosts
            : Array.isArray(p.hosts)
              ? p.hosts.join(',')
              : undefined,
      }));
  } catch {
    return [];
  }
}

export function ensureCacheDir(storage: vscode.Uri): string {
  const dir = cacheDir(storage);
  mkdirSync(dir, { recursive: true });
  return dir;
}
