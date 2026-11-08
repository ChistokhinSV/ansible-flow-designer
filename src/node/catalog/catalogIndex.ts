// The module catalog index (M5, ADR-0011): SQLite FTS5 through node:sqlite in the extension host
// (verified on VS Code 1.140 and 1.144, desktop and Remote server). Built from the probe's
// per-collection files; one database per environment manifest.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  badgesOf,
  type Candidate,
  metaOf,
  nameCandidates,
  type PluginMeta,
  planQuery,
  rerank,
  stem,
} from '../../core/catalog/rank';
import type {
  CatalogPlugin,
  CollectionFile,
  PluginType,
  Resolution,
  RoutingEntry,
  SearchContext,
  SearchHit,
} from '../../core/catalog/types';

export const INDEX_SCHEMA = 8;
/** bm25 column weights: plugin name, short description, option names, long text, collection. */
const WEIGHTS = [10, 6, 3, 1, 2];
const CANDIDATES = 200;
/** Words in more than this share of the docs say nothing about the query (07 §2). */
const COMMON = 0.5;
/**
 * Words in more than this share are matched in names, summaries and option names only: bm25 runs
 * over every matching doc, and "value" in every option description is the whole catalog (p95 gate).
 */
const BROAD = 0.12;
const TOKENIZE = "tokenize='porter unicode61'";

type Row = {
  id: number;
  fqcn: string;
  type: PluginType;
  collection: string;
  name: string;
  short: string;
  deprecated: number;
  meta: string;
  /** Bit i: query word i is in the name, summary or option names. */
  in_strong: number;
  /** Bit i: query word i is in the description or the option descriptions. */
  in_text: number;
  rank: number | null;
};

const COLUMNS = 'p.id, p.fqcn, p.type, p.collection, p.name, p.short, p.deprecated, p.meta';

type Sqlite = typeof import('node:sqlite');
let sqlite: Sqlite | null | undefined;

/**
 * node:sqlite, loaded on first use (AFD-171). It needs Node 22.13 (VS Code 1.101); editors built
 * on an older Electron (Kiro 0.1, older forks) run the extension without the module catalog
 * instead of failing to load it. getBuiltinModule, not require: the same code runs bundled and
 * under Vitest; Node before 20.16 has no getBuiltinModule and no SQLite either.
 */
function loadSqlite(): Sqlite | null {
  if (sqlite === undefined) {
    const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    try {
      sqlite = (get?.call(process, 'node:sqlite') as Sqlite | undefined) ?? null;
    } catch {
      sqlite = null;
    }
  }
  return sqlite;
}

export function sqliteAvailable(): boolean {
  return loadSqlite() !== null;
}

/** Why the catalog is off in this editor, for the status line and errors. */
export function sqliteMissing(): string {
  return `The module catalog needs an editor running Node.js 22.13 or later (VS Code 1.101+); this one runs Node.js ${process.versions.node}`;
}

function database(path: string, options?: { readOnly?: boolean }): DatabaseSync {
  const s = loadSqlite();
  if (!s) throw new Error(sqliteMissing());
  // An explicit undefined options argument is refused ("must be an object").
  return options ? new s.DatabaseSync(path, options) : new s.DatabaseSync(path);
}

/** `(instr(col, ?) > 0) << 0 | …` per query word: coverage computed in SQLite, not by shipping text. */
function hits(column: string, words: number): string {
  return (
    Array.from({ length: words }, (_, i) => `((instr(p.${column}, ?) > 0) << ${i})`).join(' | ') ||
    '0'
  );
}

function words(text: string): string {
  return text.replaceAll(/[._-]+/g, ' ');
}

export class CatalogIndex {
  private readonly total: number;
  private readonly df: StatementSync;
  private readonly named: StatementSync;
  private readonly docOf: StatementSync;
  private readonly routeOf: StatementSync;
  private readonly textOf: StatementSync;
  private readonly searches = new Map<string, StatementSync>();
  /** A scratch FTS table whose vocabulary gives the Porter stems the index uses. */
  private readonly stemmer = database(':memory:');
  private readonly stemSql: { clear: StatementSync; add: StatementSync; read: StatementSync };

  private constructor(private readonly db: DatabaseSync) {
    this.total = (db.prepare('SELECT count(*) AS n FROM plugins').get() as { n: number }).n;
    this.df = db.prepare('SELECT n FROM df WHERE term = ?');
    this.named = db.prepare('SELECT 1 FROM plugins WHERE name = ? LIMIT 1');
    this.docOf = db.prepare(
      'SELECT d.doc FROM plugins p JOIN docs d ON d.id = p.id WHERE p.type = ? AND p.fqcn = ?',
    );
    this.routeOf = db.prepare('SELECT entry FROM routing WHERE type = ? AND name = ?');
    this.textOf = db.prepare('SELECT opts, text FROM plugins WHERE id = ?');
    this.stemmer.exec(`CREATE VIRTUAL TABLE t USING fts5(x, ${TOKENIZE});
      CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');`);
    this.stemSql = {
      clear: this.stemmer.prepare('DELETE FROM t'),
      add: this.stemmer.prepare('INSERT INTO t (x) VALUES (?)'),
      read: this.stemmer.prepare('SELECT term, offset FROM v'),
    };
  }

  /** Builds a fresh index at `path` (':memory:' in tests) from the probe's collection files. */
  static build(path: string, files: CollectionFile[]): CatalogIndex {
    const db = database(path);
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA page_size = 16384;
      DROP TABLE IF EXISTS plugins; DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS routing;
      DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS vocab; DROP TABLE IF EXISTS docs;
      DROP TABLE IF EXISTS df;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE plugins (
        id INTEGER PRIMARY KEY, type TEXT, fqcn TEXT, collection TEXT, name TEXT, short TEXT,
        deprecated INTEGER, opts TEXT, strong TEXT, text TEXT, meta TEXT, UNIQUE (type, fqcn));
      CREATE INDEX plugins_name ON plugins (name);
      -- Full docs apart, so searches never page through them.
      CREATE TABLE docs (id INTEGER PRIMARY KEY, doc TEXT);
      CREATE VIRTUAL TABLE fts USING fts5(name, short, opts, body, coll, content='', ${TOKENIZE});
      CREATE VIRTUAL TABLE vocab USING fts5vocab(fts, 'row');
      -- Document frequency per stemmed term; reading it from vocab walks the term's doclist.
      CREATE TABLE df (term TEXT PRIMARY KEY, n INTEGER) WITHOUT ROWID;
      INSERT INTO fts (fts, rank) VALUES ('rank', 'bm25(${WEIGHTS.join(', ')})');
      CREATE TABLE routing (type TEXT, name TEXT, entry TEXT, PRIMARY KEY (type, name));
    `);
    const addPlugin = db.prepare(
      'INSERT OR IGNORE INTO plugins (type, fqcn, collection, name, short, deprecated, opts, strong, text, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const addDoc = db.prepare('INSERT INTO docs (id, doc) VALUES (?, ?)');
    const addText = db.prepare(
      'INSERT INTO fts (rowid, name, short, opts, body, coll) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const addRoute = db.prepare(
      'INSERT OR REPLACE INTO routing (type, name, entry) VALUES (?, ?, ?)',
    );
    db.exec('BEGIN');
    for (const file of files) {
      for (const p of file.plugins) {
        const options = Object.entries(p.options ?? {});
        // What the re-rank checks query words against, without parsing the whole doc per search:
        // name, summary and option names, then the prose.
        const strong = [
          words(p.name),
          p.short_description,
          options.map(([k]) => words(k)).join(' '),
        ]
          .join(' ')
          .toLowerCase();
        const text = [
          p.description.slice(0, 1500),
          options
            .map(([, o]) => o.description)
            .join(' ')
            .slice(0, 2500),
        ]
          .join(' ')
          .toLowerCase();
        const r = addPlugin.run(
          p.type,
          p.fqcn,
          p.collection,
          p.name,
          p.short_description,
          p.deprecated ? 1 : 0,
          options.map(([k]) => k).join(' '),
          strong,
          text,
          JSON.stringify(metaOf(p)),
        );
        if (!r.changes) continue;
        addDoc.run(r.lastInsertRowid, JSON.stringify(p));
        addText.run(
          r.lastInsertRowid,
          // The local name only: "open"* must not match every openstack.* module.
          words(p.name),
          p.short_description,
          options.flatMap(([k, o]) => [words(k), ...(o.aliases ?? []).map(words)]).join(' '),
          [p.description, p.notes ?? '', ...options.map(([, o]) => o.description)]
            .join('\n')
            .slice(0, 8000),
          words(p.collection),
        );
      }
      // Builtin runtime entries are short names (ios_config); collection entries are local names.
      const prefix = file.collection === 'ansible.builtin' ? '' : `${file.collection}.`;
      for (const [type, entries] of Object.entries(file.routing ?? {})) {
        for (const [name, entry] of Object.entries(entries ?? {})) {
          addRoute.run(type, `${prefix}${name}`, JSON.stringify(entry));
          if (!prefix) addRoute.run(type, `ansible.builtin.${name}`, JSON.stringify(entry));
        }
      }
    }
    db.exec('INSERT INTO df (term, n) SELECT term, doc FROM vocab');
    const set = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    set.run('schema', String(INDEX_SCHEMA));
    set.run('collections', JSON.stringify(files.map((f) => `${f.collection}@${f.version}`)));
    db.exec('COMMIT');
    return new CatalogIndex(db);
  }

  /** Opens an index built before, or undefined when it is missing or of an older schema. */
  static open(path: string): CatalogIndex | undefined {
    try {
      const db = database(path, { readOnly: true });
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as
        | { value: string }
        | undefined;
      if (row?.value !== String(INDEX_SCHEMA)) {
        db.close();
        return undefined;
      }
      return new CatalogIndex(db);
    } catch {
      return undefined;
    }
  }

  close(): void {
    this.db.close();
    this.stemmer.close();
  }

  stats(): { plugins: number; modules: number; collections: number } {
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      plugins: count('SELECT count(*) AS n FROM plugins'),
      modules: count("SELECT count(*) AS n FROM plugins WHERE type = 'module'"),
      collections: count('SELECT count(DISTINCT collection) AS n FROM plugins'),
    };
  }

  private versions?: Map<string, string>;

  /** Every indexed collection and its version. */
  collections(): Record<string, string> {
    this.collectionVersion('');
    return Object.fromEntries(this.versions ?? []);
  }

  /** The indexed version of a collection (`ansible.builtin` is ansible-core's). */
  collectionVersion(name: string): string | undefined {
    if (!this.versions) {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'collections'").get() as
        | { value: string }
        | undefined;
      const list = row ? (JSON.parse(row.value) as string[]) : [];
      this.versions = new Map(
        list.map((c) => [c.slice(0, c.indexOf('@')), c.slice(c.indexOf('@') + 1)]),
      );
    }
    return this.versions.get(name);
  }

  plugin(fqcn: string, type: PluginType = 'module'): CatalogPlugin | undefined {
    const row = this.docOf.get(type, fqcn) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as CatalogPlugin) : undefined;
  }

  /** The index's own Porter stems of query words (create → creat, query → queri). */
  private porter(list: string[]): string[] {
    this.stemSql.clear.run();
    this.stemSql.add.run(list.join(' '));
    const out = [...list];
    for (const r of this.stemSql.read.all() as { term: string; offset: number }[])
      out[r.offset] = r.term;
    return out;
  }

  /** Parameters in text order: (match | names), stems for in_strong, stems for in_text, types. */
  private statement(kind: 'fts' | 'names', words: number, types: number): StatementSync {
    const key = `${kind}:${words}:${types}`;
    let st = this.searches.get(key);
    if (!st) {
      const typed = types
        ? `p.type IN (${Array.from({ length: types }, () => '?').join(', ')})`
        : '';
      const select = `${COLUMNS}, ${hits('strong', words)} AS in_strong, ${hits('text', words)} AS in_text`;
      st = this.db.prepare(
        kind === 'fts'
          ? // FTS5 sorts by its configured rank (weighted bm25) fastest when nothing else is joined in.
            `WITH top AS (SELECT rowid, rank FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ${CANDIDATES})
            SELECT ${select}, top.rank FROM top JOIN plugins p ON p.id = top.rowid ${typed ? `WHERE ${typed}` : ''}`
          : `WITH wanted AS (SELECT value FROM json_each(?))
            SELECT ${select}, NULL AS rank FROM plugins p
            WHERE p.name IN (SELECT value FROM wanted) ${typed ? `AND ${typed}` : ''}`,
      );
      this.searches.set(key, st);
    }
    return st;
  }

  search(query: string, ctx: SearchContext = {}, limit = 20): SearchHit[] {
    const plan = planQuery(query);
    if (plan.words.length === 0) return [];
    // Share of plugins using each word. Common words go, except plugin names ("create user").
    let share = this.porter(plan.words).map(
      (s) => ((this.df.get(s) as { n: number } | undefined)?.n ?? 0) / this.total,
    );
    const keep = plan.words.map((w, i) => (share[i] ?? 0) <= COMMON || !!this.named.get(w));
    if (plan.words.length > 1 && keep.some(Boolean)) {
      plan.words = plan.words.filter((_, i) => keep[i]);
      share = share.filter((_, i) => keep[i]);
    }
    const terms = plan.words;
    const match = terms
      .map((t, i) => {
        const column = (share[i] ?? 0) > BROAD ? '{name short opts} : ' : '';
        return t.length >= 3 ? `${column}"${t}" OR name : "${t}"*` : `${column}"${t}"`;
      })
      .join(' OR ');
    // Plugins named by the words themselves (user, json_query, ipaddr for "ip address") are
    // candidates even when bm25 can't tell them apart from thousands of others.
    plan.names = nameCandidates(terms);
    const types = ctx.types?.length ? ctx.types : [];
    const crude = terms.map(stem);
    const args = [...crude, ...crude, ...types];
    const rows = [
      ...(this.statement('fts', terms.length, types.length).all(match, ...args) as Row[]),
      ...(this.statement('names', terms.length, types.length).all(
        JSON.stringify([...plan.names.keys()]),
        ...args,
      ) as Row[]),
    ];
    const best = rows.reduce((m, r) => Math.max(m, -(r.rank ?? 0)), 0);
    const seen = new Set<string>();
    const scored = rows
      .filter((r) => {
        const key = `${r.type}:${r.fqcn}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((r) => {
        const candidate: Candidate = {
          type: r.type,
          name: r.name,
          collection: r.collection,
          inStrong: r.in_strong,
          inText: r.in_text,
          deprecated: r.deprecated === 1,
          bm25: -(r.rank ?? 0),
        };
        return { r, score: rerank(candidate, plan, ctx, best) };
      });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ r, score }) => {
      const badges = badgesOf(r, JSON.parse(r.meta) as PluginMeta, ctx);
      return {
        fqcn: r.fqcn,
        type: r.type,
        collection: r.collection,
        short_description: r.short,
        score: Math.round(score * 1000) / 1000,
        match: matchText(r, this.textOf.get(r.id) as { opts: string; text: string }, terms),
        badges,
        dimmed: badges.includes('other-platform'),
      };
    });
  }

  private route(type: string, name: string): RoutingEntry | undefined {
    const row = this.routeOf.get(type, name) as { entry: string } | undefined;
    return row ? (JSON.parse(row.entry) as RoutingEntry) : undefined;
  }

  /**
   * What Ansible runs for a module name (07 §2): the play's collections, then ansible.builtin, then
   * redirects (at most five hops); tombstones mean removed.
   */
  resolve(name: string, collections: string[] = [], type: PluginType = 'module'): Resolution {
    const candidates =
      name.split('.').length >= 3
        ? [name]
        : [...collections.map((c) => `${c}.${name}`), `ansible.builtin.${name}`];
    let fallback: Resolution | undefined;
    for (const start of candidates) {
      const hops = [start];
      let current = start;
      let deprecated: string | undefined;
      for (let i = 0; i <= 5; i++) {
        if (this.docOf.get(type, current)) return { fqcn: current, hops, deprecated, found: true };
        const r = this.route(type, current);
        if (!r) break;
        if (r.deprecation)
          deprecated =
            r.deprecation.warning_text || `deprecated (${r.deprecation.removal_version})`;
        if (r.tombstone) {
          fallback ??= {
            hops,
            removed: r.tombstone.warning_text || `removed in ${r.tombstone.removal_version}`,
            found: false,
          };
          break;
        }
        if (!r.redirect) break;
        current = r.redirect;
        hops.push(current);
      }
    }
    return fallback ?? { hops: [name], found: false };
  }
}

/** "name: vlans · option `vlan_id`": where the query words were found, for the result list. */
function matchText(
  r: Pick<Row, 'name' | 'short'>,
  more: { opts: string; text: string },
  terms: string[],
): string {
  const where: string[] = [];
  for (const t of terms) {
    const s = stem(t);
    if (r.name.toLowerCase().includes(s)) where.push(`name: ${t}`);
    else if (r.short.toLowerCase().includes(s)) where.push(`summary: ${t}`);
    else {
      const opt = more.opts.split(' ').find((k) => k.toLowerCase().includes(s));
      if (opt) where.push(`option \`${opt}\``);
      else if (more.text.includes(s)) where.push(`description: ${t}`);
    }
  }
  return [...new Set(where)].join(' · ');
}
