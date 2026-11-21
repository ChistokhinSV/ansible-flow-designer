// AFD-340 (ADR-0038, phase 2): every place in the repository that defines a variable, with its file,
// line, value and Ansible precedence rank. Read through the same small file interface as the
// inventory (`InventoryFs`), so the VS Code extension, the MCP tools and later the server build the
// same index. The index is plain JSON: the host builds it and sends it to the designer. Pure apart
// from that interface; no Jinja is rendered and nothing secret is kept, not even in part.
import { parse } from 'yaml';
import type { FlowNode } from '../flow/types';
import { holdsSecret, SECRET } from '../import/secrets';
import { fileVars, groupTree, inlineVars, type VarEntry } from './edit';
import { type InventoryFs, readInventory } from './files';
import { isStatic } from './origins';

/** Where a definition is, by the part of Ansible's precedence it takes. */
export type VarScope =
  /** `inline`: written in the inventory file; `root`: group_vars/ at the repository root (AFD-291). */
  | { kind: 'group'; group: string; inline?: true; root?: true }
  | { kind: 'host'; host: string; inline?: true; root?: true }
  /** `spec`: meta/argument_specs documents it; Ansible does not set its default. */
  | { kind: 'role'; role: string; part: 'defaults' | 'vars' | 'spec' }
  /** A play's vars_files in a playbook a step runs (`owner`, from the repository root). */
  | { kind: 'varsFile'; owner: string }
  /** include_vars in a playbook or task file a step runs; `when`: under a condition. */
  | { kind: 'includeVars'; owner: string; when?: true };

export interface VarDef {
  name: string;
  scope: VarScope;
  /** From the repository root; zero-based line. */
  file: string;
  line: number;
  /** Precedence rank (RANK); higher wins. 0: documentation only, never a value. */
  rank: number;
  /** A literal as one line of YAML (cut in the middle). Never set on a secret. */
  value?: string;
  /** A templated value, raw (never rendered). Never set on a secret. */
  template?: string;
  /** Vaulted, or a secret-looking name or value: no value at all. */
  secret?: true;
  /** An argument_specs description. */
  doc?: string;
}

export interface VarIndex {
  /** By variable name; a name's definitions in the order they were read. */
  defs: Record<string, VarDef[]>;
  /** The static inventory's groups: their parents, the hosts written under them, their priority. */
  groups: Record<string, { parents: string[]; hosts: string[]; priority?: number }>;
  /** Every host the static files name, sorted. */
  hosts: string[];
  /** Some source is dynamic (a plugin or a script): its hosts and variables are known at run time. */
  dynamic?: true;
  /** The build stopped at a limit: some files were not read. */
  cut?: 'files' | 'time';
}

/**
 * Ansible's variable precedence, restricted to what is known statically (lowest to highest). Group
 * variables follow Ansible's default `precedence` setting: the inventory file's `all`, its other
 * groups, then group_vars of `all` beside the inventory, at the root, then the other groups' beside
 * the inventory, at the root. The root's group_vars load like a playbook's (afd_repo_vars).
 */
export const RANK = {
  spec: 0,
  roleDefault: 10,
  groupInlineAll: 20,
  groupInline: 21,
  groupFileAll: 22,
  groupRootAll: 23,
  groupFile: 24,
  groupRoot: 25,
  hostInline: 30,
  hostFile: 31,
  hostRoot: 32,
  playVar: 40,
  varsFile: 45,
  roleVar: 50,
  includeVars: 60,
  setFact: 70,
  roleParam: 80,
  extraVar: 90,
} as const;

/** A rank in words, as tooltips show it. */
export function rankWord(rank: number): string {
  if (rank <= 0) return 'documentation';
  if (rank < 20) return 'role default';
  if (rank < 22) return 'inventory group var';
  if (rank < 30) return 'group_vars';
  if (rank === 30) return 'inventory host var';
  if (rank < 40) return 'host_vars';
  if (rank < 45) return 'play var';
  if (rank < 50) return 'play vars_files';
  if (rank < 60) return 'role var';
  if (rank < 70) return 'include_vars';
  if (rank < 80) return 'set_fact / register';
  if (rank < 90) return 'role param';
  return 'extra var';
}

const MAX_VALUE = 80;

function oneLine(value: unknown): string {
  let s =
    typeof value === 'string'
      ? value === ''
        ? '""'
        : value
      : (JSON.stringify(value) ?? 'null').replaceAll('":', '": ').replaceAll(',"', ', "');
  s = s.replaceAll(/\s*\n\s*/g, ' ');
  if (s.length <= MAX_VALUE) return s;
  const half = Math.floor((MAX_VALUE - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

/** A definition from what a file holds: secret ones keep no value. */
function defOf(e: VarEntry, scope: VarScope, rank: number): VarDef {
  const def: VarDef = { name: e.key, scope, file: e.file, line: e.line, rank };
  if (e.vaulted || SECRET.test(e.key) || holdsSecret(e.value)) def.secret = true;
  else if (typeof e.value === 'string' && (e.value.includes('{{') || e.value.includes('{%')))
    def.template = oneLine(e.value);
  else def.value = oneLine(e.value);
  return def;
}

/** What the designer asks of the repository for one flow. */
export interface VarIndexRequest {
  /** `afd.run.inventory`; empty: what ansible.cfg names. */
  inventory: string;
  /** Roles the flow's steps run (as bound: `name` or `ns.coll.role`). */
  roles?: readonly string[];
  /** Playbooks and task files the flow's steps run, from the repository root. */
  files?: readonly string[];
  /** Files read at most (default 400) and milliseconds spent at most (default 2000). */
  maxFiles?: number;
  budgetMs?: number;
  now?: () => number;
}

const norm = (p: string) =>
  p
    .split('\\')
    .join('/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/');

/** A path inside the repository, or undefined when it leads outside or is templated. */
function inside(path: string): string | undefined {
  if (!path || path.includes('{{') || /^([a-zA-Z]:)?[\\/]/.test(path) || path.startsWith('~'))
    return undefined;
  const out: string[] = [];
  for (const part of norm(path).split('/')) {
    if (part === '..') {
      if (!out.length) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join('/') || undefined;
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const join = (a: string, b: string) => (a ? `${a}/${b}` : b);

/** A key of ansible.cfg's `[defaults]`. */
function cfgValue(cfg: string, key: string): string | undefined {
  let on = false;
  for (const raw of cfg.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      on = header[1] === 'defaults';
      continue;
    }
    const m = on ? /^([\w]+)\s*[=:]\s*(.*)$/.exec(line) : null;
    if (m && m[1] === key) return (m[2] as string).trim();
  }
  return undefined;
}

const INCLUDE_VARS = /^(ansible\.(builtin|legacy)\.)?include_vars$/;
const isMap = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Builds the index of what a flow's runs load, within the request's limits. */
export async function buildVarIndex(fs: InventoryFs, req: VarIndexRequest): Promise<VarIndex> {
  const now = req.now ?? (() => Date.now());
  const start = now();
  const maxFiles = req.maxFiles ?? 400;
  const budget = req.budgetMs ?? 2000;
  let reads = 0;
  let cut: VarIndex['cut'];
  const over = () => {
    if (cut) return true;
    if (reads >= maxFiles) cut = 'files';
    else if (now() - start > budget) cut = 'time';
    return !!cut;
  };
  const read = async (path: string) => {
    if (over()) return undefined;
    reads++;
    return fs.read(path);
  };
  const defs: Record<string, VarDef[]> = Object.create(null);
  const add = (d: VarDef) => {
    const list = Object.hasOwn(defs, d.name) ? (defs[d.name] as VarDef[]) : [];
    list.push(d);
    defs[d.name] = list;
  };

  // The inventory: its own files' variables, then host_vars/ and group_vars/ beside it and at the
  // root (AFD-291: runs load the root's as a playbook's).
  const inv = await readInventory(fs, req.inventory);
  reads += inv.texts.length + inv.varFiles.length;
  const tree = groupTree(inv.texts);
  const groups: VarIndex['groups'] = {};
  const hosts = new Set<string>();
  for (const [name, g] of tree) {
    groups[name] = { parents: [...g.parents], hosts: [...g.hosts].sort() };
    for (const h of g.hosts) hosts.add(h);
  }
  // A host written under no group is ungrouped's.
  const grouped = new Set(
    [...tree].filter(([n]) => n !== 'all' && n !== 'ungrouped').flatMap(([, g]) => [...g.hosts]),
  );
  for (const h of tree.get('all')?.hosts ?? [])
    if (!grouped.has(h)) {
      groups.ungrouped ??= { parents: ['all'], hosts: [] };
      if (!groups.ungrouped.hosts.includes(h)) groups.ungrouped.hosts.push(h);
    }
  for (const name of Object.keys(groups))
    for (const v of inlineVars(inv.texts, { group: name }))
      add(
        defOf(
          v,
          { kind: 'group', group: name, inline: true },
          name === 'all' ? RANK.groupInlineAll : RANK.groupInline,
        ),
      );
  for (const host of [...hosts].sort())
    for (const v of inlineVars(inv.texts, { host, ranges: true }))
      add(defOf(v, { kind: 'host', host, inline: true }, RANK.hostInline));
  const base = inv.varDirs.base;
  for (const f of inv.varFiles) {
    // Beside the inventory unless the inventory is at the root: then they are the same files.
    const root = base !== '' && !f.path.startsWith(`${base}/`);
    for (const v of fileVars(f.path, f.text)) {
      const rank =
        f.of === 'host'
          ? root
            ? RANK.hostRoot
            : RANK.hostFile
          : f.name === 'all'
            ? root
              ? RANK.groupRootAll
              : RANK.groupFileAll
            : root
              ? RANK.groupRoot
              : RANK.groupFile;
      const scope: VarScope =
        f.of === 'host'
          ? { kind: 'host', host: f.name, ...(root ? { root: true as const } : {}) }
          : { kind: 'group', group: f.name, ...(root ? { root: true as const } : {}) };
      add(defOf(v, scope, rank));
    }
  }
  // ansible_group_priority, when a group writes it as a number.
  for (const d of Object.hasOwn(defs, 'ansible_group_priority')
    ? (defs.ansible_group_priority as VarDef[])
    : [])
    if (d.scope.kind === 'group' && d.value && /^\d+$/.test(d.value)) {
      const g = groups[d.scope.group];
      if (g) g.priority = Number(d.value);
    }

  // Roles the flow runs: defaults, vars and argument_specs.
  const cfg = (await read('ansible.cfg')) ?? '';
  const rolesPath = (cfgValue(cfg, 'roles_path') ?? '')
    .split(':')
    .map((p) => inside(p.trim()))
    .filter((p): p is string => !!p);
  for (const role of [...new Set(req.roles ?? [])]) {
    if (over()) break;
    const dir = await roleDir(fs, role, rolesPath);
    if (!dir) continue;
    for (const [part, rank] of [
      ['defaults', RANK.roleDefault],
      ['vars', RANK.roleVar],
    ] as const)
      for (const file of await mainFiles(fs, join(dir, part))) {
        const text = await read(file);
        if (text === undefined) continue;
        for (const v of fileVars(file, text)) add(defOf(v, { kind: 'role', role, part }, rank));
      }
    for (const file of [
      join(dir, 'meta/argument_specs.yml'),
      join(dir, 'meta/argument_specs.yaml'),
      join(dir, 'meta/main.yml'),
      join(dir, 'meta/main.yaml'),
    ]) {
      const text = (await fs.kind(file)) === 'file' ? await read(file) : undefined;
      if (text !== undefined) for (const d of specDefs(file, text, role)) add(d);
    }
  }

  // Playbooks and task files the flow runs: literal vars_files and include_vars.
  for (const raw of [...new Set(req.files ?? [])]) {
    const owner = inside(raw);
    if (!owner || over()) continue;
    const text = await read(owner);
    if (text === undefined) continue;
    let data: unknown;
    try {
      data = parse(text, { logLevel: 'error' });
    } catch {
      continue;
    }
    if (!Array.isArray(data)) continue;
    const dir = dirOf(owner);
    const plays = data.some((p) => isMap(p) && ('hosts' in p || 'import_playbook' in p));
    const varsFrom = async (rel: string, scope: VarScope, rank: number, places: string[]) => {
      for (const place of places) {
        const file = inside(join(place, rel));
        if (!file || (await fs.kind(file)) !== 'file') continue;
        const body = await read(file);
        if (body !== undefined) for (const v of fileVars(file, body)) add(defOf(v, scope, rank));
        return;
      }
    };
    const tasks = async (list: unknown, when: boolean) => {
      if (!Array.isArray(list)) return;
      for (const t of list) {
        if (!isMap(t) || over()) continue;
        const cond = when || t.when !== undefined;
        for (const b of ['block', 'rescue', 'always']) await tasks(t[b], cond);
        const key = Object.keys(t).find((k) => INCLUDE_VARS.test(k));
        if (!key) continue;
        const arg = t[key];
        const file = typeof arg === 'string' ? arg.trim() : isMap(arg) ? arg.file : undefined;
        // `name:` nests the file's variables under one name; `dir:` is read at run time.
        if (typeof file !== 'string' || (isMap(arg) && (arg.name || arg.dir))) continue;
        const scope: VarScope = { kind: 'includeVars', owner, ...(cond ? { when: true } : {}) };
        await varsFrom(file, scope, RANK.includeVars, [join(dir, 'vars'), dir, 'vars', '']);
      }
    };
    if (plays)
      for (const play of data) {
        if (!isMap(play)) continue;
        const files = Array.isArray(play.vars_files) ? play.vars_files : [];
        for (const f of files) {
          // A list inside vars_files: the first of them that is there.
          const choices = (Array.isArray(f) ? f : [f]).filter(
            (c): c is string => typeof c === 'string',
          );
          for (const c of choices) {
            const path = inside(join(dir, c));
            if (path && (await fs.kind(path)) === 'file') {
              await varsFrom(c, { kind: 'varsFile', owner }, RANK.varsFile, [dir]);
              break;
            }
          }
        }
        for (const part of ['pre_tasks', 'tasks', 'post_tasks'])
          await tasks(play[part], play.when !== undefined);
      }
    else await tasks(data, false);
  }

  const out: VarIndex = { defs, groups, hosts: [...hosts].sort() };
  if (inv.sources.some((s) => s.kind !== 'missing' && s.kind !== 'outside' && !isStatic(s.kind)))
    out.dynamic = true;
  if (cut) out.cut = cut;
  return out;
}

/** Where a role is, as a play at the repository root finds it: roles/, then roles_path. */
async function roleDir(
  fs: InventoryFs,
  role: string,
  rolesPath: readonly string[],
): Promise<string | undefined> {
  const parts = role.split('.');
  const candidates =
    parts.length === 3 && !role.includes('/')
      ? [`collections/ansible_collections/${parts[0]}/${parts[1]}/roles/${parts[2]}`]
      : [join('roles', role), ...rolesPath.map((p) => join(p, role))];
  for (const c of candidates) {
    const dir = inside(c);
    if (dir && (await fs.kind(dir)) === 'dir') return dir;
  }
  return undefined;
}

/** A role part's main file, or every file of its main/ folder (sorted, as Ansible loads them). */
async function mainFiles(fs: InventoryFs, dir: string): Promise<string[]> {
  for (const name of ['main.yml', 'main.yaml', 'main'])
    if ((await fs.kind(join(dir, name))) === 'file') return [join(dir, name)];
  const list = await fs.list(join(dir, 'main'));
  return (list ?? [])
    .filter((e) => !e.dir && /\.ya?ml$/i.test(e.name))
    .map((e) => join(dir, `main/${e.name}`));
}

/** The main entry point's options in argument_specs: documentation, with their defaults. */
function specDefs(file: string, text: string, role: string): VarDef[] {
  let data: unknown;
  try {
    data = parse(text, { logLevel: 'error' });
  } catch {
    return [];
  }
  const specs = isMap(data) ? data.argument_specs : undefined;
  const options = isMap(specs) && isMap(specs.main) ? specs.main.options : undefined;
  if (!isMap(options)) return [];
  const lines = text.split(/\r?\n/);
  const out: VarDef[] = [];
  for (const [name, opt] of Object.entries(options)) {
    // The option's own line: its key, indented, after `options:`.
    const at = lines.findIndex(
      (l, i) =>
        i > 0 &&
        new RegExp(`^\\s+${name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(l) &&
        lines.slice(0, i).some((p) => /^\s+options\s*:/.test(p)),
    );
    const desc = isMap(opt) ? opt.description : undefined;
    const doc = Array.isArray(desc) ? desc.join(' ') : typeof desc === 'string' ? desc : undefined;
    const d: VarDef = {
      name,
      scope: { kind: 'role', role, part: 'spec' },
      file,
      line: Math.max(0, at),
      rank: RANK.spec,
      ...(doc ? { doc: oneLine(doc) } : {}),
    };
    const dflt = isMap(opt) ? opt.default : undefined;
    if (SECRET.test(name) || holdsSecret(dflt)) d.secret = true;
    else if (dflt !== undefined) d.value = oneLine(dflt);
    out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------- precedence

/** Whose definitions a reader sees besides the inventory's. */
export interface RepoContext {
  /** The role the reading step runs: its defaults and vars. */
  role?: string;
  /** The playbook or task file the reading step runs: its vars_files and include_vars. */
  own?: readonly string[];
  /** Playbooks and task files earlier steps run: their include_vars stay with the host. */
  upstream?: readonly string[];
}

/** A name's definitions in the repository, as one reader sees them, and the winner when certain. */
export interface RepoAnswer {
  /** Highest rank first; documentation (argument_specs) last. */
  defs: VarDef[];
  /** The definition that wins, when it is certain. */
  winner?: VarDef;
  /** For whom: `for host x`, `for every host`, or the groups and hosts it depends on. */
  scope: string;
  /** Why there is no winner, or why the winner may still change. */
  why?: string;
  /** With a host: the definitions that apply to it (the others are other hosts'). */
  applies?: VarDef[];
}

export function defsOf(index: VarIndex, name: string): VarDef[] {
  return Object.hasOwn(index.defs, name) ? (index.defs[name] as VarDef[]) : [];
}

/** Each group's depth: `all` 0, a child one more than its deepest parent. */
function depths(index: VarIndex): Map<string, number> {
  const out = new Map<string, number>();
  const depth = (g: string, seen: Set<string>): number => {
    const known = out.get(g);
    if (known !== undefined) return known;
    if (g === 'all' || seen.has(g)) return 0;
    seen.add(g);
    const parents = index.groups[g]?.parents ?? ['all'];
    const d = 1 + Math.max(0, ...parents.map((p) => depth(p, seen)));
    out.set(g, d);
    return d;
  };
  for (const g of Object.keys(index.groups)) depth(g, new Set());
  out.set('all', 0);
  return out;
}

/** The groups a host is in, with every parent, and `all`. */
export function hostGroups(index: VarIndex, host: string): Set<string> {
  const out = new Set<string>(['all']);
  const up = (g: string) => {
    if (out.has(g)) return;
    out.add(g);
    for (const p of index.groups[g]?.parents ?? []) up(p);
  };
  for (const [name, g] of Object.entries(index.groups)) if (g.hosts.includes(host)) up(name);
  return out;
}

const normOwner = (p: string) => inside(p) ?? norm(p);

/** Whether a reader sees a definition at all (the inventory's: every reader). */
function seen(def: VarDef, ctx: RepoContext): boolean {
  const s = def.scope;
  if (s.kind === 'role') return !!ctx.role && s.role === ctx.role;
  if (s.kind === 'varsFile') return (ctx.own ?? []).some((o) => normOwner(o) === s.owner);
  if (s.kind === 'includeVars')
    return [...(ctx.own ?? []), ...(ctx.upstream ?? [])].some((o) => normOwner(o) === s.owner);
  return true;
}

/** Whether a definition applies to every host (not one group's or one host's). */
const everyHost = (d: VarDef) =>
  d.scope.kind === 'group' ? d.scope.group === 'all' : d.scope.kind !== 'host';

/** Where a definition is, in words: the scope and the kind of file. */
export function defLabel(d: VarDef): string {
  const s = d.scope;
  switch (s.kind) {
    case 'group':
      return s.inline
        ? `group ${s.group}, in the inventory file`
        : `group_vars of ${s.group}${s.root ? ' at the repository root' : ''}`;
    case 'host':
      return s.inline
        ? `host ${s.host}, in the inventory file`
        : `host_vars of ${s.host}${s.root ? ' at the repository root' : ''}`;
    case 'role':
      return s.part === 'defaults'
        ? `default of role ${s.role}`
        : s.part === 'vars'
          ? `role var of ${s.role}`
          : `argument_specs of role ${s.role} (documentation: Ansible does not set its default)`;
    case 'varsFile':
      return `vars_files of ${s.owner}`;
    case 'includeVars':
      return `include_vars in ${s.owner}${s.when ? ' (when its condition holds)' : ''}`;
  }
}

/**
 * A name's definitions as `ctx`'s reader sees them, highest rank first, and which one wins: for
 * `host` when one is picked, else for every host when each of them applies to every host. Only a
 * certain winner is named: not with a dynamic source, a cut index, a host the static files do not
 * name, or an include_vars under a condition.
 */
export function repoAnswer(
  index: VarIndex,
  name: string,
  ctx: RepoContext,
  host?: string,
): RepoAnswer | undefined {
  const all = defsOf(index, name).filter((d) => seen(d, ctx));
  if (!all.length) return undefined;
  const depth = depths(index);
  const key = (d: VarDef): [number, number, number, string] =>
    d.scope.kind === 'group'
      ? [
          d.rank,
          depth.get(d.scope.group) ?? 1,
          index.groups[d.scope.group]?.priority ?? 1,
          d.scope.group,
        ]
      : [d.rank, 0, 0, ''];
  // Highest first: Ansible sorts groups by depth, priority and name, and the later one wins.
  const defs = [...all].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return (kb[i] as number) - (ka[i] as number);
    return ka[3] < kb[3] ? 1 : ka[3] > kb[3] ? -1 : 0;
  });
  const values = defs.filter((d) => d.rank > 0);
  const unsure = index.dynamic
    ? 'a dynamic inventory source may set it too'
    : index.cut
      ? 'not every file was read (limits)'
      : undefined;
  if (host) {
    const groups = hostGroups(index, host);
    const applies = values.filter((d) =>
      d.scope.kind === 'group'
        ? groups.has(d.scope.group)
        : d.scope.kind === 'host'
          ? d.scope.host === host
          : true,
    );
    const top = applies[0];
    const why = !index.hosts.includes(host)
      ? `${host} is not in the static inventory`
      : top?.scope.kind === 'includeVars' && top.scope.when
        ? 'the include_vars that would win runs under a condition'
        : unsure;
    return {
      defs,
      applies,
      ...(top && !why ? { winner: top } : {}),
      scope: `for host ${host}`,
      ...(why ? { why } : !top ? { why: `nothing here applies to ${host}` } : {}),
    };
  }
  if (values.every(everyHost)) {
    const top = values[0];
    const why =
      top?.scope.kind === 'includeVars' && top.scope.when
        ? 'the include_vars that would win runs under a condition'
        : unsure;
    return {
      defs,
      ...(top && !why ? { winner: top } : {}),
      scope: 'for every host',
      ...(why ? { why } : {}),
    };
  }
  const where = [
    ...new Set(
      values.map((d) =>
        d.scope.kind === 'group'
          ? `group ${d.scope.group}`
          : d.scope.kind === 'host'
            ? `host ${d.scope.host}`
            : 'every host',
      ),
    ),
  ];
  return {
    defs,
    scope: `depends on the host: ${where.join(', ')}`,
    why: 'pick a host to see which one wins',
  };
}

/** The roles, playbooks and task files a flow's steps run: what its index needs to read. */
export function indexInputs(nodes: readonly FlowNode[] | undefined): {
  roles: string[];
  files: string[];
} {
  const roles = new Set<string>();
  const files = new Set<string>();
  const walk = (list: readonly FlowNode[] | undefined, depth: number) => {
    if (depth > 32) return;
    for (const n of list ?? []) {
      const own = stepFile(n);
      if (n.impl?.kind === 'role' && n.impl.ref) roles.add(n.impl.ref);
      if (own) files.add(own);
      walk(n.subflow?.nodes, depth + 1);
    }
  };
  walk(nodes, 0);
  return { roles: [...roles].sort(), files: [...files].sort() };
}

/** The playbook or task file a step runs, from the repository root (AFD-291). */
export function stepFile(node: Pick<FlowNode, 'impl'>): string | undefined {
  const impl = node.impl;
  if (!impl?.ref) return undefined;
  if (impl.kind === 'playbook') return inside(impl.ref);
  if (impl.kind === 'module' && /^(ansible\.(builtin|legacy)\.)?include_tasks$/.test(impl.ref)) {
    const p = impl.params;
    const file = typeof p === 'string' ? p : isMap(p) ? (p.file ?? p._raw_params) : undefined;
    return typeof file === 'string' ? inside(file) : undefined;
  }
  return undefined;
}
