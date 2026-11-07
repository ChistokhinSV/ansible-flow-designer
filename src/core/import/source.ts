// Playbooks, task files and roles as import sources (AFD-26): one normalized tree per playbook.
// Tasks take their module and arguments apart (action:, local_action:, free-form and k=v forms),
// inherit their play's and blocks' keywords as Ansible does, and literal includes and imports are
// read in. What a flow cannot hold is listed per item, so the mapper can say so.
// Ansible's own loader (the probe, ADR-0012) needs an environment, flattens blocks and drops
// arguments, conditions and loops; this reader works anywhere and keeps them.
import { templated } from '../flow/jinja';
import { isAllowedKeyword } from '../flow/keywords';
import { builtinFqcn, shortName } from './builtins';
import {
  type AnsibleConfig,
  basename,
  dirname,
  exists,
  isMapping,
  isTemplated,
  isVaultFile,
  join,
  lineOf,
  normalize,
  type Plain,
  type PlainMap,
  parseAnsible,
  parseConfig,
  type SourceIO,
  toValue,
} from './read';

export interface Origin {
  path: string;
  line?: number;
}

export interface TaskForm {
  kind: 'task';
  name: string;
  /** As written (`copy`, `cisco.ios.ios_config`). */
  module: string;
  /** Fully qualified when known. */
  fqcn?: string;
  params: Record<string, unknown>;
  /** Task keywords a binding carries (impl.keywords), inherited ones included. */
  keywords: Record<string, unknown>;
  register?: string;
  notify: string[];
  /** Handlers: the topics they listen to besides their name. */
  listen: string[];
  tags: string[];
  become?: boolean;
  /** Whole seconds, or a template given at run time (AFD-112). */
  timeout?: number | string;
  retries?: number | string;
  delay?: number | string;
  until?: string;
  ignoreUnreachable?: boolean;
  /** Keywords with no place in a flow. */
  dropped: string[];
  /** Local files the task reads (template src, ...): where Ansible finds them, or missing. */
  files: LocalFile[];
  origin: Origin;
}

export interface LocalFile {
  /** The parameter, or `cmd` for a script's first word. */
  param: string;
  written: string;
  /** Repository path, when found. */
  path?: string;
}

export interface VarsFile {
  file: string;
  path?: string;
  /** Top-level variable names in it (none when encrypted or missing). */
  keys: string[];
}

export interface BlockForm {
  kind: 'block';
  name: string;
  items: Item[];
  rescue: Item[];
  always: Item[];
  origin: Origin;
}

export interface IncludeForm {
  kind: 'include';
  name: string;
  /** The file as written. */
  file: string;
  /** Read in: the file's items (a literal path that exists). */
  path?: string;
  items?: Item[];
  /** Why it is not read in (a templated path, a loop, missing). */
  dynamic?: string;
  keywords: Record<string, unknown>;
  tags: string[];
  origin: Origin;
}

/** A task file of a split role: one step per file (decision 2). */
export interface RoleStep {
  /** include_role tasks_from: the file under tasks/ without its extension. */
  tasksFrom: string;
  name: string;
  keywords: Record<string, unknown>;
  tags: string[];
}

export interface RoleForm {
  kind: 'role';
  name: string;
  /** What include_role names: the role name, or an FQCN for a collection role. */
  ref: string;
  /** Folder of the role, when found. */
  dir?: string;
  /** Whether generated plays find it (roles_path of the repository's ansible.cfg, collections). */
  onRolesPath: boolean;
  /** Role variables and include options (tasks_from, vars_from, ...). */
  params: Record<string, unknown>;
  keywords: Record<string, unknown>;
  tags: string[];
  become?: boolean;
  split?: RoleStep[];
  /** Variables the role registers or sets (read statically), so later steps can read them. */
  outputs: string[];
  dropped: string[];
  origin: Origin;
}

export interface MetaForm {
  kind: 'meta';
  name: string;
  action: string;
  keywords: Record<string, unknown>;
  origin: Origin;
}

export type Item = TaskForm | BlockForm | IncludeForm | RoleForm | MetaForm;

export interface VarPrompt {
  name: string;
  private: boolean;
  default?: unknown;
  prompt?: string;
}

export interface PlayForm {
  kind: 'play';
  name: string;
  hosts: string;
  gatherFacts: boolean;
  gatherParams: Record<string, unknown>;
  become?: boolean;
  serial?: string | number;
  maxFailPercentage?: number;
  anyErrorsFatal?: boolean;
  collections: string[];
  vars: Record<string, unknown>;
  varsFiles: VarsFile[];
  varsPrompt: VarPrompt[];
  preTasks: Item[];
  roles: Item[];
  tasks: Item[];
  postTasks: Item[];
  handlers: Item[];
  dropped: string[];
  origin: Origin;
}

export interface ImportPlaybookForm {
  kind: 'import_playbook';
  name: string;
  file: string;
  playbook?: PlaybookForm;
  /** Why it is not read in. */
  missing?: string;
  keywords: Record<string, unknown>;
  origin: Origin;
}

export interface PlaybookForm {
  path: string;
  plays: (PlayForm | ImportPlaybookForm)[];
}

export interface ReadOptions {
  /** Short module name + the play's collections → FQCN (the catalog, when the host has one). */
  resolveModule?(name: string, collections: string[]): string | undefined;
}

export interface ReadResult {
  playbook?: PlaybookForm;
  /** What did not read one to one, for the user. */
  notes: string[];
  /** Every file read, repository paths. */
  files: string[];
  config?: AnsibleConfig;
}

// ---- keywords ------------------------------------------------------------------------------------

/** Every key a task may have besides its module (Ansible's Task attributes). */
const TASK_KEYS = new Set([
  'name',
  'action',
  'local_action',
  'args',
  'async',
  'poll',
  'become',
  'become_exe',
  'become_flags',
  'become_method',
  'become_user',
  'changed_when',
  'check_mode',
  'collections',
  'connection',
  'debugger',
  'delay',
  'delegate_facts',
  'delegate_to',
  'diff',
  'environment',
  'failed_when',
  'ignore_errors',
  'ignore_unreachable',
  'loop',
  'loop_control',
  'module_defaults',
  'no_log',
  'notify',
  'listen',
  'port',
  'register',
  'remote_user',
  'retries',
  'run_once',
  'tags',
  'throttle',
  'timeout',
  'until',
  'vars',
  'when',
  'any_errors_fatal',
  'block',
  'rescue',
  'always',
]);

const isTaskKey = (k: string) => TASK_KEYS.has(k) || /^with_[a-z_]+$/.test(k);

/** What blocks and plays hand down to their tasks. */
interface Scope {
  keywords: Record<string, unknown>;
  when: unknown[];
  tags: string[];
  become?: boolean;
  ignoreUnreachable?: boolean;
  /** Keywords that have no place, inherited. */
  dropped: string[];
}

const EMPTY_SCOPE: Scope = { keywords: {}, when: [], tags: [], dropped: [] };

/** Keywords a block or play hands down (their own `when`, tags and become are kept apart). */
const INHERITED = new Set([
  'become_user',
  'become_method',
  'become_flags',
  'become_exe',
  'environment',
  'connection',
  'remote_user',
  'port',
  'ignore_errors',
  'no_log',
  'check_mode',
  'diff',
  'delegate_to',
  'delegate_facts',
  'run_once',
  'throttle',
  'module_defaults',
  'debugger',
  'vars',
]);

const asList = (v: unknown): string[] =>
  v === undefined || v === null
    ? []
    : (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);

const asBool = (v: unknown): boolean | undefined =>
  typeof v === 'boolean'
    ? v
    : typeof v === 'string' && /^(yes|true|on|1)$/i.test(v)
      ? true
      : typeof v === 'string' && /^(no|false|off|0)$/i.test(v)
        ? false
        : undefined;

const asInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v)
    ? v
    : typeof v === 'string' && /^[0-9]+$/.test(v.trim())
      ? Number(v)
      : undefined;

/**
 * A number, or a whole template the flow keeps as a value given at run time (AFD-112: a templated
 * retries, delay or timeout used to be dropped on import).
 */
const asIntOrTemplate = (v: unknown): number | string | undefined =>
  asInt(v) ?? (templated(v) ? v.trim() : undefined);

/** A block's or play's own keys added to what its parent handed down. */
function narrow(parent: Scope, raw: PlainMap, own: 'block' | 'play'): Scope {
  const keywords = { ...parent.keywords };
  // A play's vars become flow inputs; a block's vars reach its tasks.
  for (const k of INHERITED)
    if (raw[k] !== undefined && !(own === 'play' && k === 'vars')) {
      const v = toValue(raw[k] as Plain);
      keywords[k] =
        k === 'vars' && isMapping(keywords.vars) && isMapping(v) ? { ...keywords.vars, ...v } : v;
    }
  const dropped = [...parent.dropped];
  if (own === 'block' && raw.any_errors_fatal !== undefined) dropped.push('any_errors_fatal');
  return {
    keywords,
    when: own === 'block' && raw.when !== undefined ? [...parent.when, raw.when] : parent.when,
    tags: [...parent.tags, ...asList(raw.tags)],
    become: asBool(raw.become) ?? parent.become,
    ignoreUnreachable: asBool(raw.ignore_unreachable) ?? parent.ignoreUnreachable,
    dropped,
  };
}

/** A task's keywords over what it inherits; `when` lists are ANDed in order. */
function taskKeywords(
  scope: Scope,
  raw: PlainMap,
): { keywords: Record<string, unknown>; dropped: string[] } {
  const keywords: Record<string, unknown> = { ...scope.keywords };
  const dropped = [...scope.dropped];
  for (const [k, v] of Object.entries(raw)) {
    if (!isTaskKey(k) || k === 'when') continue;
    if (
      [
        'name',
        'action',
        'local_action',
        'args',
        'register',
        'notify',
        'listen',
        'tags',
        'become',
        'timeout',
        'retries',
        'delay',
        'until',
        'ignore_unreachable',
        'block',
        'rescue',
        'always',
        'collections',
      ].includes(k)
    )
      continue;
    if (k === 'with_items' || k === 'with_list') keywords.loop = toValue(v);
    else if (k === 'vars' && isMapping(keywords.vars) && isMapping(v))
      keywords.vars = { ...keywords.vars, ...(toValue(v) as Record<string, unknown>) };
    else if (isAllowedKeyword(k)) keywords[k] = toValue(v);
    else dropped.push(k);
  }
  const when = [...scope.when, ...(raw.when !== undefined ? [raw.when] : [])]
    .flatMap((w) => (Array.isArray(w) ? w : [w]))
    .map((w) => toValue(w as Plain));
  if (when.length === 1) keywords.when = when[0];
  else if (when.length > 1) keywords.when = when;
  return { keywords, dropped: [...new Set(dropped)] };
}

// ---- module arguments ----------------------------------------------------------------------------

/** `src=a dest="b c" mode=0644` → {src, dest, mode}; quotes and `{{ }}` keep their spaces. */
export function parseKv(text: string): { args: Record<string, string>; rest: string } {
  const args: Record<string, string> = {};
  const rest: string[] = [];
  const tokens: string[] = [];
  let cur = '';
  let quote = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      cur += c;
      if (c === quote && text[i - 1] !== '\\') quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (text.startsWith('{{', i) || text.startsWith('{%', i)) {
      depth++;
      cur += text.slice(i, i + 2);
      i++;
    } else if ((text.startsWith('}}', i) || text.startsWith('%}', i)) && depth > 0) {
      depth--;
      cur += text.slice(i, i + 2);
      i++;
    } else if (/\s/.test(c) && depth === 0) {
      if (cur) tokens.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) tokens.push(cur);
  // Ansible's parse_kv drops the quotes and decodes escapes (`content="done\n"` ends in a newline).
  const ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };
  const unquote = (s: string) =>
    (/^(["']).*\1$/s.test(s) ? s.slice(1, -1) : s).replace(
      /\\([ntr\\"'])/g,
      (_, c: string) => ESC[c] ?? c,
    );
  for (const t of tokens) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(t);
    if (m?.[1]) args[m[1]] = unquote(m[2] ?? '');
    else rest.push(t);
  }
  return { args, rest: rest.join(' ') };
}

/** Modules whose arguments are a command line, and the options Ansible takes out of it. */
const FREE_FORM: Record<string, string> = {
  command: 'cmd',
  shell: 'cmd',
  script: 'cmd',
  raw: '_raw_params',
  win_command: '_raw_params',
  win_shell: '_raw_params',
};
const FREE_OPTIONS = new Set(['chdir', 'creates', 'removes', 'executable', 'stdin', 'warn']);

/** Module arguments from the task value: a map, k=v text, or a free-form command line. */
function moduleArgs(module: string, value: unknown, extra: unknown): Record<string, unknown> {
  const short = shortName(module).replace(/^ansible\.windows\./, '');
  let params: Record<string, unknown> = {};
  if (isMapping(value)) params = toValue(value) as Record<string, unknown>;
  else if (typeof value === 'string' && value.trim()) {
    const free = FREE_FORM[short];
    if (free) {
      const { args, rest } = parseKv(value);
      const options = Object.fromEntries(Object.entries(args).filter(([k]) => FREE_OPTIONS.has(k)));
      const kept = Object.entries(args)
        .filter(([k]) => !FREE_OPTIONS.has(k))
        .map(([k, v]) => `${k}=${v}`);
      params = { [free]: [rest, ...kept].filter(Boolean).join(' '), ...options };
    } else if (short === 'include_vars') params = { file: value.trim() };
    else {
      const { args, rest } = parseKv(value);
      params = rest ? { ...args, _raw_params: rest } : args;
    }
  }
  if (isMapping(extra)) params = { ...params, ...(toValue(extra) as Record<string, unknown>) };
  return params;
}

/** The module key and its value: a lone non-keyword key, or action / local_action. */
function moduleOf(raw: PlainMap): { module: string; value: unknown; local: boolean } | undefined {
  for (const key of ['action', 'local_action'] as const) {
    const a = raw[key];
    if (a === undefined) continue;
    if (typeof a === 'string') {
      const [module = '', ...rest] = a.trim().split(/\s+/);
      return { module, value: rest.join(' '), local: key === 'local_action' };
    }
    if (isMapping(a) && typeof a.module === 'string') {
      const { module, ...rest } = a;
      return { module: module as string, value: rest, local: key === 'local_action' };
    }
  }
  const keys = Object.keys(raw).filter((k) => !isTaskKey(k));
  if (!keys[0]) return undefined;
  return { module: keys[0], value: raw[keys[0]], local: false };
}

const INCLUDES = new Set(['include_tasks', 'import_tasks', 'include']);

/** Modules that read a local file, the parameter naming it and the subfolder Ansible looks in. */
const LOCAL_FILES: Record<string, { param: string; sub: string }> = {
  template: { param: 'src', sub: 'templates' },
  win_template: { param: 'src', sub: 'templates' },
  copy: { param: 'src', sub: 'files' },
  win_copy: { param: 'src', sub: 'files' },
  unarchive: { param: 'src', sub: 'files' },
  script: { param: 'cmd', sub: 'files' },
  include_vars: { param: 'file', sub: 'vars' },
};
const ROLE_INCLUDES = new Set(['include_role', 'import_role']);
// ---- the reader ----------------------------------------------------------------------------------

interface RoleInfo {
  dir?: string;
  onRolesPath: boolean;
  split?: RoleStep[];
  outputs: string[];
}

class Reader {
  readonly notes: string[] = [];
  readonly files = new Set<string>();
  private readonly roles = new Map<string, Promise<RoleInfo>>();
  /** Task files being read in, to stop an include cycle. */
  private readonly including: string[] = [];
  private config?: AnsibleConfig;
  private collections: string[] = [];

  constructor(
    private readonly io: SourceIO,
    private readonly opts: ReadOptions,
  ) {}

  /** The repository's ansible.cfg (the one runs use, ADR-0005). */
  async loadConfig(): Promise<AnsibleConfig | undefined> {
    const text = await this.io.read('ansible.cfg');
    if (text !== undefined) this.config = parseConfig(text, '');
    return this.config;
  }

  private async readYaml(path: string): Promise<Plain | undefined> {
    const text = await this.io.read(path);
    if (text === undefined) return undefined;
    this.files.add(path);
    if (isVaultFile(text)) {
      this.notes.push(`${path} is encrypted with Ansible Vault as a whole: not read.`);
      return undefined;
    }
    const { value, error } = parseAnsible(text);
    if (error) {
      this.notes.push(`${path} is not valid YAML (${error}): not read.`);
      return undefined;
    }
    return value;
  }

  async playbook(path: string, stack: string[] = []): Promise<PlaybookForm | undefined> {
    const data = await this.readYaml(path);
    if (data === undefined) return undefined;
    if (!Array.isArray(data)) {
      this.notes.push(`${path} is not a playbook (no list of plays).`);
      return undefined;
    }
    const plays: PlaybookForm['plays'] = [];
    for (const raw of data) {
      if (!isMapping(raw)) continue;
      const origin = { path, line: lineOf(raw) };
      const imp = raw.import_playbook ?? raw['ansible.builtin.import_playbook'];
      if (imp !== undefined) {
        plays.push(await this.importPlaybook(raw, String(imp), path, origin, stack));
        continue;
      }
      if (raw.hosts === undefined) {
        this.notes.push(`${path}:${origin.line ?? '?'}: a play without hosts was skipped.`);
        continue;
      }
      plays.push(await this.play(raw, path, origin));
    }
    return { path, plays };
  }

  private async importPlaybook(
    raw: PlainMap,
    file: string,
    from: string,
    origin: Origin,
    stack: string[],
  ): Promise<ImportPlaybookForm> {
    const keywords: Record<string, unknown> = {};
    if (raw.vars !== undefined) keywords.vars = toValue(raw.vars);
    if (raw.when !== undefined) keywords.when = toValue(raw.when);
    const form: ImportPlaybookForm = {
      kind: 'import_playbook',
      name: typeof raw.name === 'string' ? raw.name : basename(file).replace(/\.ya?ml$/, ''),
      file,
      keywords,
      origin,
    };
    if (isTemplated(file)) {
      form.missing = 'its path is templated';
      return form;
    }
    const path = join(dirname(from), file);
    if (stack.includes(path) || stack.length >= 8) {
      form.missing = stack.includes(path) ? 'it imports itself' : 'imports nest deeper than 8';
      return form;
    }
    form.playbook = await this.playbook(path, [...stack, from]);
    if (!form.playbook) form.missing = `${path} was not found or not read`;
    return form;
  }

  private async play(raw: PlainMap, path: string, origin: Origin): Promise<PlayForm> {
    this.collections = asList(raw.collections);
    const scope = narrow(EMPTY_SCOPE, raw, 'play');
    const dropped = ['strategy', 'order', 'force_handlers'].filter((k) => raw[k] !== undefined);
    const gather = asBool(raw.gather_facts);
    const gatherParams: Record<string, unknown> = {};
    if (raw.gather_subset !== undefined) gatherParams.gather_subset = toValue(raw.gather_subset);
    if (raw.gather_timeout !== undefined) gatherParams.gather_timeout = toValue(raw.gather_timeout);
    const dir = dirname(path);
    const section = async (key: string) =>
      this.items(Array.isArray(raw[key]) ? (raw[key] as Plain[]) : [], scope, dir, dir, path);
    const prompts = Array.isArray(raw.vars_prompt) ? raw.vars_prompt : [];
    return {
      kind: 'play',
      name: typeof raw.name === 'string' ? raw.name : '',
      hosts: Array.isArray(raw.hosts)
        ? raw.hosts.map(String).join(',')
        : String(raw.hosts ?? 'all'),
      gatherFacts: gather ?? this.config?.gathering !== 'explicit',
      gatherParams,
      become: scope.become,
      serial:
        typeof raw.serial === 'number' || typeof raw.serial === 'string' ? raw.serial : undefined,
      maxFailPercentage: asInt(raw.max_fail_percentage),
      anyErrorsFatal: asBool(raw.any_errors_fatal),
      collections: this.collections,
      vars: isMapping(raw.vars) ? (toValue(raw.vars) as Record<string, unknown>) : {},
      varsFiles: await this.varsFiles(raw.vars_files, dir),
      varsPrompt: prompts.filter(isMapping).map((p) => ({
        name: String(p.name ?? ''),
        private: asBool(p.private) ?? true,
        ...(p.default !== undefined ? { default: toValue(p.default) } : {}),
        ...(typeof p.prompt === 'string' ? { prompt: p.prompt } : {}),
      })),
      preTasks: await section('pre_tasks'),
      roles: await this.playRoles(raw.roles, scope, path),
      tasks: await section('tasks'),
      postTasks: await section('post_tasks'),
      handlers: await section('handlers'),
      dropped: [...new Set([...dropped, ...scope.dropped])],
      origin,
    };
  }

  /** The `roles:` section: strings or maps with role/name, vars, keywords and old-style vars. */
  private async playRoles(value: Plain | undefined, scope: Scope, path: string): Promise<Item[]> {
    const out: Item[] = [];
    for (const entry of Array.isArray(value) ? value : []) {
      const raw: PlainMap = isMapping(entry) ? entry : { role: entry as Plain };
      const name = String(raw.role ?? raw.name ?? '');
      if (!name) continue;
      const params: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw))
        if (!['role', 'name'].includes(k) && !isTaskKey(k)) params[k] = toValue(v);
      if (isMapping(raw.vars)) Object.assign(params, toValue(raw.vars));
      out.push(
        await this.role(name, params, { ...raw, vars: null } as PlainMap, scope, path, {
          path,
          line: lineOf(entry),
        }),
      );
    }
    return out;
  }

  async items(
    list: Plain[],
    scope: Scope,
    dir: string,
    playDir: string,
    file: string,
    depth = 0,
  ): Promise<Item[]> {
    const out: Item[] = [];
    for (const raw of list) {
      if (!isMapping(raw)) continue;
      const item = await this.item(raw, scope, dir, playDir, file, depth);
      if (item) out.push(item);
    }
    return out;
  }

  private async item(
    raw: PlainMap,
    scope: Scope,
    dir: string,
    playDir: string,
    file: string,
    depth: number,
  ): Promise<Item | undefined> {
    const origin = { path: file, line: lineOf(raw) };
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (Array.isArray(raw.block)) {
      const inner = narrow(scope, raw, 'block');
      const list = async (key: string) =>
        this.items(
          Array.isArray(raw[key]) ? (raw[key] as Plain[]) : [],
          inner,
          dir,
          playDir,
          file,
          depth,
        );
      return {
        kind: 'block',
        name,
        items: await list('block'),
        rescue: await list('rescue'),
        always: await list('always'),
        origin,
      };
    }
    const found = moduleOf(raw);
    if (!found) {
      this.notes.push(`${file}:${origin.line ?? '?'}: a task without a module was skipped.`);
      return undefined;
    }
    const short = shortName(found.module);
    const { keywords, dropped } = taskKeywords(scope, raw);
    if (found.local) keywords.delegate_to = 'localhost';
    const tags = [...scope.tags, ...asList(raw.tags)];
    if (INCLUDES.has(short))
      return this.include(
        raw,
        found.value,
        name,
        keywords,
        tags,
        dir,
        playDir,
        origin,
        scope,
        depth,
      );
    if (ROLE_INCLUDES.has(short)) {
      const args = moduleArgs(found.module, found.value, raw.args);
      const roleName = String(args.name ?? '');
      const params: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) if (k !== 'name' && k !== 'apply') params[k] = v;
      if (isMapping(raw.vars)) Object.assign(params, toValue(raw.vars));
      const apply = isMapping(args.apply) ? (args.apply as PlainMap) : {};
      const role = await this.role(
        roleName,
        params,
        { ...raw, ...apply, vars: null } as PlainMap,
        scope,
        file,
        origin,
      );
      role.name = name || role.name;
      return role;
    }
    if (short === 'meta') {
      return { kind: 'meta', name, action: String(found.value ?? '').trim(), keywords, origin };
    }
    const params = moduleArgs(found.module, found.value, raw.args);
    const fqcn =
      builtinFqcn(found.module) ?? this.opts.resolveModule?.(found.module, this.collections);
    const become = asBool(raw.become) ?? scope.become;
    return {
      kind: 'task',
      name,
      module: found.module,
      ...(fqcn ? { fqcn } : {}),
      params,
      keywords,
      ...(typeof raw.register === 'string' && raw.register ? { register: raw.register } : {}),
      notify: asList(raw.notify),
      listen: asList(raw.listen),
      tags,
      ...(become !== undefined ? { become } : {}),
      ...(asIntOrTemplate(raw.timeout) ? { timeout: asIntOrTemplate(raw.timeout) } : {}),
      ...(asIntOrTemplate(raw.retries) !== undefined
        ? { retries: asIntOrTemplate(raw.retries) }
        : {}),
      ...(asIntOrTemplate(raw.delay) !== undefined ? { delay: asIntOrTemplate(raw.delay) } : {}),
      ...(typeof raw.until === 'string' ? { until: raw.until } : {}),
      ...((asBool(raw.ignore_unreachable) ?? scope.ignoreUnreachable)
        ? { ignoreUnreachable: true }
        : {}),
      dropped: [
        ...dropped,
        ...(raw.retries !== undefined && asIntOrTemplate(raw.retries) === undefined
          ? ['retries']
          : []),
        ...(raw.delay !== undefined && asIntOrTemplate(raw.delay) === undefined ? ['delay'] : []),
        ...(raw.timeout !== undefined && !asIntOrTemplate(raw.timeout) ? ['timeout'] : []),
      ],
      files: await this.localFiles(found.module, params, dir, playDir),
      origin,
    };
  }

  /** Where Ansible would find the local files a task names, searched as it does. */
  private async localFiles(
    module: string,
    params: Record<string, unknown>,
    dir: string,
    playDir: string,
  ): Promise<LocalFile[]> {
    const short = shortName(module).replace(/^ansible\.windows\./, '');
    const spec = LOCAL_FILES[short];
    if (!spec || asBool(params.remote_src)) return [];
    let written = params[spec.param];
    if (short === 'script' && typeof written === 'string') written = written.trim().split(/\s+/)[0];
    if (typeof written !== 'string' || !written || isTemplated(written) || written.startsWith('/'))
      return [];
    const bases = [...new Set([dir, playDir])];
    const candidates = bases.flatMap((b) => [join(b, spec.sub, written), join(b, written)]);
    for (const path of candidates)
      if (await exists(this.io, path)) return [{ param: spec.param, written, path }];
    return [{ param: spec.param, written }];
  }

  private async varsFiles(value: Plain | undefined, dir: string): Promise<VarsFile[]> {
    const out: VarsFile[] = [];
    for (const entry of Array.isArray(value) ? value : []) {
      const file = Array.isArray(entry) ? entry[0] : entry;
      if (typeof file !== 'string') continue;
      if (isTemplated(file) || file.startsWith('/')) {
        out.push({ file, keys: [] });
        continue;
      }
      const path = join(dir, file);
      const data = (await exists(this.io, path)) ? await this.readYaml(path) : undefined;
      out.push({
        file,
        ...(data !== undefined ? { path } : {}),
        keys: isMapping(data) ? Object.keys(data) : [],
      });
    }
    return out;
  }

  private async include(
    raw: PlainMap,
    value: unknown,
    name: string,
    keywords: Record<string, unknown>,
    tags: string[],
    dir: string,
    playDir: string,
    origin: Origin,
    scope: Scope,
    depth: number,
  ): Promise<IncludeForm> {
    const args = isMapping(value) ? (toValue(value) as Record<string, unknown>) : {};
    const target =
      typeof value === 'string' ? value.trim() : String(args.file ?? args._raw_params ?? '');
    const form: IncludeForm = { kind: 'include', name, file: target, keywords, tags, origin };
    if (!target || isTemplated(target)) form.dynamic = 'its file name is templated';
    else if (
      keywords.loop !== undefined ||
      Object.keys(keywords).some((k) => k.startsWith('with_'))
    )
      form.dynamic = 'it runs in a loop';
    else if (depth >= 8) form.dynamic = 'includes nest deeper than 8';
    if (form.dynamic) return form;
    const candidates = [...new Set([join(dir, target), join(playDir, target)])];
    for (const path of candidates) {
      if (!(await exists(this.io, path))) continue;
      if (this.including.includes(path)) {
        form.dynamic = `${path} includes itself`;
        return form;
      }
      const data = await this.readYaml(path);
      if (data === undefined) break;
      form.path = path;
      // The include's own keywords reach every task in the file (static import semantics).
      const inner = narrow(scope, raw, 'block');
      this.including.push(path);
      form.items = await this.items(
        Array.isArray(data) ? data : [],
        inner,
        dirname(path),
        playDir,
        path,
        depth + 1,
      );
      this.including.pop();
      form.keywords = {};
      return form;
    }
    form.dynamic = `${candidates[0]} was not found`;
    return form;
  }

  private async role(
    name: string,
    params: Record<string, unknown>,
    raw: PlainMap,
    scope: Scope,
    file: string,
    origin: Origin,
  ): Promise<RoleForm> {
    // Role variables are params; every other keyword applies to the role's tasks.
    const { keywords, dropped } = taskKeywords(scope, raw);
    delete keywords.vars;
    const info = await this.roleInfo(name, dirname(file));
    const tags = [...scope.tags, ...asList(raw.tags)];
    const become = asBool(raw.become) ?? scope.become;
    return {
      kind: 'role',
      name: name.includes('/') ? basename(name) : name,
      ref: name.includes('/') && info.dir ? basename(info.dir) : name,
      ...(info.dir ? { dir: info.dir } : {}),
      onRolesPath: info.onRolesPath,
      params,
      keywords,
      tags,
      ...(become !== undefined ? { become } : {}),
      ...(info.split && !params.tasks_from ? { split: info.split } : {}),
      outputs: info.outputs,
      dropped,
      origin,
    };
  }

  /** Where a role lives, whether runs find it, its split and what it registers. */
  roleInfo(name: string, fromDir: string): Promise<RoleInfo> {
    const key = `${fromDir}|${name}`;
    let found = this.roles.get(key);
    if (!found) {
      found = this.findRole(name, fromDir);
      this.roles.set(key, found);
    }
    return found;
  }

  private async findRole(name: string, fromDir: string): Promise<RoleInfo> {
    const parts = name.split('.');
    const cfgRoles = this.config?.rolesPath ?? [];
    let candidates: { dir: string; onRolesPath: boolean }[];
    if (!name.includes('/') && parts.length === 3) {
      const [ns, coll, role] = parts;
      const bases = [
        'collections',
        ...(this.config?.collectionsPath ?? []).map((p) => normalize(p)),
      ];
      candidates = [...new Set([...bases, join(fromDir, 'collections')])].map((b) => ({
        dir: join(b, 'ansible_collections', ns ?? '', coll ?? '', 'roles', role ?? ''),
        onRolesPath: true,
      }));
    } else {
      // Ansible's order: roles/ next to the playbook, then roles_path, then the playbook's folder.
      candidates = [
        { dir: join(fromDir, 'roles', name), onRolesPath: false },
        ...cfgRoles.map((p) => ({ dir: join(p, name), onRolesPath: true })),
        { dir: join('roles', name), onRolesPath: false },
        { dir: join(fromDir, name), onRolesPath: false },
      ];
    }
    for (const c of candidates) {
      for (const main of ['tasks/main.yml', 'tasks/main.yaml', 'meta/main.yml'])
        if (await exists(this.io, join(c.dir, main))) {
          const onRolesPath = c.onRolesPath || cfgRoles.includes(dirname(c.dir));
          return { dir: c.dir, onRolesPath, ...(await this.roleTasks(c.dir)) };
        }
    }
    // A collection role not in the repository is still bound by name: the EE may have it.
    return { onRolesPath: parts.length === 3, outputs: [] };
  }

  /** A split role (main only includes literal files) and the variables its tasks set. */
  private async roleTasks(dir: string): Promise<{ split?: RoleStep[]; outputs: string[] }> {
    const tasksDir = join(dir, 'tasks');
    const outputs = new Set<string>();
    const seen = new Set<string>();
    const walk = async (path: string, depth: number): Promise<Plain[] | undefined> => {
      if (seen.has(path) || depth > 4) return undefined;
      seen.add(path);
      const text = await this.io.read(path);
      if (text === undefined || isVaultFile(text)) return undefined;
      const { value } = parseAnsible(text);
      if (!Array.isArray(value)) return undefined;
      const visit = async (list: Plain[]) => {
        for (const t of list) {
          if (!isMapping(t)) continue;
          if (typeof t.register === 'string') outputs.add(t.register);
          for (const b of ['block', 'rescue', 'always'])
            if (Array.isArray(t[b])) await visit(t[b] as Plain[]);
          const m = moduleOf(t);
          const short = m ? shortName(m.module) : '';
          if (short === 'set_fact' && isMapping(m?.value))
            for (const k of Object.keys(m.value)) if (k !== 'cacheable') outputs.add(k);
          const target = INCLUDES.has(short)
            ? typeof m?.value === 'string'
              ? m.value
              : (m?.value as PlainMap)?.file
            : undefined;
          if (typeof target === 'string' && !isTemplated(target))
            await walk(join(dirname(path), target), depth + 1);
        }
      };
      await visit(value);
      return value;
    };
    let mainPath = join(tasksDir, 'main.yml');
    if (!(await exists(this.io, mainPath))) mainPath = join(tasksDir, 'main.yaml');
    const main = await walk(mainPath, 0);
    let split: RoleStep[] | undefined;
    if (main && main.length >= 2) {
      split = [];
      for (const t of main) {
        const m = isMapping(t) ? moduleOf(t) : undefined;
        const short = m ? shortName(m.module) : '';
        const target =
          typeof m?.value === 'string' ? m.value.trim() : (m?.value as PlainMap | undefined)?.file;
        const extra = isMapping(t)
          ? Object.keys(t).filter((k) => isTaskKey(k) && !['name', 'tags', 'when'].includes(k))
          : ['?'];
        if (
          !m ||
          !INCLUDES.has(short) ||
          typeof target !== 'string' ||
          isTemplated(target) ||
          extra.length
        ) {
          split = undefined;
          break;
        }
        const rel = normalize(join(dirname(mainPath.slice(tasksDir.length + 1)), target));
        split.push({
          tasksFrom: rel.replace(/\.ya?ml$/, ''),
          name:
            typeof (t as PlainMap).name === 'string'
              ? ((t as PlainMap).name as string)
              : basename(rel).replace(/\.ya?ml$/, ''),
          keywords:
            (t as PlainMap).when !== undefined
              ? { when: toValue((t as PlainMap).when as Plain) }
              : {},
          tags: asList((t as PlainMap).tags),
        });
      }
    }
    return { ...(split ? { split } : {}), outputs: [...outputs].sort() };
  }
}

/** Reads a playbook with everything it imports and includes. */
export async function readPlaybook(
  io: SourceIO,
  path: string,
  opts: ReadOptions = {},
): Promise<ReadResult> {
  const reader = new Reader(io, opts);
  const config = await reader.loadConfig();
  const playbook = await reader.playbook(normalize(path));
  return { playbook, notes: reader.notes, files: [...reader.files], ...(config ? { config } : {}) };
}

// ---- folders -------------------------------------------------------------------------------------

/** Folders a scan never enters: tooling, generated code, and Ansible content that is not a playbook. */
const SKIP_DIRS = new Set([
  'node_modules',
  'generated',
  'out',
  'dist',
  'venv',
  'roles',
  'group_vars',
  'host_vars',
  'collections',
  'flows',
  'molecule',
  '__pycache__',
]);

const PLAY_HINT = /^[ \t]*-?[ \t]*(hosts|(ansible\.builtin\.)?import_playbook)[ \t]*:/m;

export interface FolderPlaybook {
  path: string;
  /** The first play's name, else the file name. */
  title: string;
  /** Not imported by another playbook in the folder: offered first. */
  entry: boolean;
  /** Who imports it, when not an entry. */
  importedBy?: string;
}

export interface FolderScan {
  playbooks: FolderPlaybook[];
  /** Roles under roles/ (and roles_path) with whether each is split. */
  roles: { name: string; dir: string; split: boolean }[];
  truncated: boolean;
}

/** The playbooks of a folder (and below), which ones are entries, and its roles. */
export async function scanFolder(io: SourceIO, dir: string, maxFiles = 2000): Promise<FolderScan> {
  const files: string[] = [];
  let truncated = false;
  const walk = async (d: string, depth: number) => {
    if (depth > 6) return;
    for (const e of await io.list(d)) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (e.name.startsWith('.')) continue;
      const path = join(d, e.name);
      if (e.dir) {
        if (!SKIP_DIRS.has(e.name)) await walk(path, depth + 1);
      } else if (/\.ya?ml$/.test(e.name) && !e.name.endsWith('.flow.yaml')) files.push(path);
    }
  };
  await walk(normalize(dir), 0);
  const playbooks: FolderPlaybook[] = [];
  const imports = new Map<string, string>();
  for (const path of files) {
    const text = await io.read(path);
    if (text === undefined || !PLAY_HINT.test(text) || isVaultFile(text)) continue;
    const { value } = parseAnsible(text);
    if (!Array.isArray(value)) continue;
    const items = value.filter(isMapping);
    const plays = items.filter((p) => p.hosts !== undefined);
    const imported = items
      .map((p) => p.import_playbook ?? p['ansible.builtin.import_playbook'])
      .filter((f): f is string => typeof f === 'string' && !isTemplated(f));
    if (!plays.length && !imported.length) continue;
    for (const f of imported) imports.set(join(dirname(path), f), path);
    const first = plays.find((p) => typeof p.name === 'string');
    playbooks.push({
      path,
      title: typeof first?.name === 'string' ? first.name : basename(path),
      entry: true,
    });
  }
  for (const p of playbooks) {
    const by = imports.get(p.path);
    if (by) {
      p.entry = false;
      p.importedBy = by;
    }
  }
  const roles: FolderScan['roles'] = [];
  const reader = new Reader(io, {});
  const config = await reader.loadConfig();
  const roleDirs = [...new Set([join(dir, 'roles'), 'roles', ...(config?.rolesPath ?? [])])];
  for (const base of roleDirs)
    for (const e of await io.list(base))
      if (e.dir && !e.name.startsWith('.') && !roles.some((r) => r.dir === join(base, e.name))) {
        const r = await reader.roleInfo(e.name, dirname(base));
        if (r.dir) roles.push({ name: e.name, dir: r.dir, split: !!r.split });
      }
  playbooks.sort((a, b) => Number(b.entry) - Number(a.entry) || a.path.localeCompare(b.path));
  return { playbooks, roles, truncated };
}
