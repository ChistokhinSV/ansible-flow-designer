// AFD-258: where the hosts and groups of an inventory are written. Ansible reads an inventory into
// one merged result and does not say which file and line a host came from, so the static files
// (YAML and INI) are read here as text to find them: the Inventory view opens a host or a group at
// its line. Pure: text in, entries out. What a file means is still Ansible's to say; this only
// finds names.
import { isMap, isScalar, LineCounter, parseDocument, type YAMLMap } from 'yaml';

/** What an inventory source is, by how Ansible's inventory plugins take it. */
export type SourceKind =
  /** A static YAML inventory (`.yml`, `.yaml`, `.json`). */
  | 'yaml'
  /** A static INI inventory (any other text file). */
  | 'ini'
  /** A YAML file that configures an inventory plugin (`plugin:`): the hosts come from elsewhere. */
  | 'plugin'
  /** A program that prints the inventory. */
  | 'script'
  | 'toml';

/** Sources whose hosts are written in the file, so they can be found (and later edited). */
export const isStatic = (kind: SourceKind): boolean => kind === 'yaml' || kind === 'ini';

export const SOURCE_LABEL: Record<SourceKind, string> = {
  yaml: 'YAML',
  ini: 'INI',
  plugin: 'dynamic: an inventory plugin (read-only)',
  script: 'dynamic: a script (read-only)',
  toml: 'TOML (read-only)',
};

export function sourceKind(path: string, text: string): SourceKind {
  const name = path.toLowerCase();
  if (/\.(py|sh|rb|pl|ps1)$/.test(name) || text.startsWith('#!')) return 'script';
  if (name.endsWith('.toml')) return 'toml';
  if (/\.(ya?ml|json)$/.test(name)) return /^plugin\s*:/m.test(text) ? 'plugin' : 'yaml';
  return 'ini';
}

/**
 * Files a directory inventory skips (Ansible's `inventory_ignore_extensions` default, which
 * includes `.ini` and `.cfg`), and the variables beside it.
 */
export function ignoredInFolder(path: string): boolean {
  const parts = path.split('/');
  const name = (parts.at(-1) as string).toLowerCase();
  if (parts.some((p) => p === 'group_vars' || p === 'host_vars')) return true;
  if (name.startsWith('.') || name.endsWith('~')) return true;
  return /\.(pyc|pyo|swp|bak|rpm|md|txt|rst|orig|ini|cfg|retry)$/.test(name);
}

export interface OriginEntry {
  type: 'host' | 'group';
  /** The name as written: a host name, a host range (`sw[01:10]`), or a group name. */
  name: string;
  /** For a host: the group it is written under (`ungrouped` before the first section). */
  group?: string;
  file: string;
  /** Zero-based line. */
  line: number;
}

export interface Origin {
  file: string;
  line: number;
  /** The host is one of a range written on this line: it has no line of its own. */
  range?: string;
}

/** The entries of a static INI inventory. */
export function iniEntries(file: string, text: string): OriginEntry[] {
  const out: OriginEntry[] = [];
  let group = 'ungrouped';
  let section: 'hosts' | 'children' | 'vars' = 'hosts';
  text.split(/\r?\n/).forEach((raw, line) => {
    const text = raw.trim();
    if (!text || text.startsWith('#') || text.startsWith(';')) return;
    const header = /^\[([^\]:]+)(?::(vars|children))?\]/.exec(text);
    if (header) {
      group = (header[1] as string).trim();
      section = (header[2] as 'vars' | 'children' | undefined) ?? 'hosts';
      out.push({ type: 'group', name: group, file, line });
      return;
    }
    if (section === 'vars') return;
    const name = text.split(/\s+/)[0] as string;
    if (section === 'children') out.push({ type: 'group', name, file, line });
    else out.push({ type: 'host', name, group, file, line });
  });
  return out;
}

/** The entries of a static YAML inventory: groups with `hosts`, `children` and `vars`. */
export function yamlEntries(file: string, text: string): OriginEntry[] {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  const out: OriginEntry[] = [];
  const lineOf = (node: unknown): number => {
    const at = (node as { range?: [number, number, number] } | null)?.range?.[0];
    return at === undefined ? 0 : lines.linePos(at).line - 1;
  };
  const keyName = (key: unknown): string | undefined =>
    isScalar(key) && key.value !== null ? String(key.value) : undefined;
  const walk = (groups: YAMLMap, depth: number) => {
    // A group inside itself, however it is written, is not followed forever.
    if (depth > 32) return;
    for (const pair of groups.items) {
      const group = keyName(pair.key);
      if (!group) continue;
      out.push({ type: 'group', name: group, file, line: lineOf(pair.key) });
      if (!isMap(pair.value)) continue;
      for (const part of pair.value.items) {
        const what = keyName(part.key);
        if (what === 'hosts' && isMap(part.value))
          for (const host of part.value.items) {
            const name = keyName(host.key);
            if (name) out.push({ type: 'host', name, group, file, line: lineOf(host.key) });
          }
        else if (what === 'children' && isMap(part.value)) walk(part.value, depth + 1);
      }
    }
  };
  if (isMap(doc.contents)) walk(doc.contents, 0);
  return out;
}

export interface InventoryProblem {
  file: string;
  /** Zero-based line. */
  line: number;
  /** What is wrong, and how it is written instead. */
  message: string;
}

const scalarText = (node: unknown): string => {
  const v = (node as { value?: unknown; source?: string } | null) ?? {};
  return typeof v.source === 'string' ? v.source : String(v.value);
};

/**
 * What Ansible refuses in a static YAML inventory: it then reads nothing of the file, and says so
 * only in a warning of its own. The usual one is a value where a mapping belongs (a host given
 * its address directly). Found here so the view can point at the line.
 */
export function yamlProblems(file: string, text: string): InventoryProblem[] {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  const at = (node: unknown): number => {
    const start = (node as { range?: [number, number, number] } | null)?.range?.[0];
    return start === undefined ? 0 : lines.linePos(start).line - 1;
  };
  const out: InventoryProblem[] = doc.errors.map((e) => ({
    file,
    line: lines.linePos(e.pos[0]).line - 1,
    message: `The YAML does not read: ${e.message.split('\n')[0]}`,
  }));
  if (out.length) return out;
  const name = (key: unknown) => (isScalar(key) ? String(key.value) : '?');
  const empty = (v: unknown) => v === null || v === undefined || (isScalar(v) && v.value === null);
  const group = (key: unknown, value: unknown, depth: number) => {
    if (empty(value) || depth > 32) return;
    if (!isMap(value)) {
      out.push({
        file,
        line: at(key),
        message: `The group ${name(key)} has a value where its hosts, vars and children belong: write them under it, or leave it empty`,
      });
      return;
    }
    for (const part of value.items) {
      const what = name(part.key);
      if (!['hosts', 'vars', 'children'].includes(what)) {
        out.push({
          file,
          line: at(part.key),
          message: `${what} under the group ${name(key)}: a group holds hosts, vars and children only (a host goes under hosts:)`,
        });
        continue;
      }
      if (empty(part.value)) continue;
      if (!isMap(part.value)) {
        out.push({
          file,
          line: at(part.key),
          message: `${what} of ${name(key)} is a ${isScalar(part.value) ? 'value' : 'list'}: write ${what === 'vars' ? 'name: value' : 'each name as a key'} under it`,
        });
        continue;
      }
      if (what === 'hosts')
        for (const host of part.value.items)
          if (!empty(host.value) && !isMap(host.value))
            out.push({
              file,
              line: at(host.key),
              message: isScalar(host.value)
                ? `${name(host.key)} has the value ${scalarText(host.value)}: a host's variables go under it, so its address is written as ansible_host: ${scalarText(host.value)} on the next line, indented`
                : `${name(host.key)} has a list: a host's variables go under it as name: value`,
            });
      if (what === 'children')
        for (const child of part.value.items) group(child.key, child.value, depth + 1);
    }
  };
  if (doc.contents && !isMap(doc.contents))
    out.push({ file, line: 0, message: 'The inventory is not a mapping of groups (all: …)' });
  else if (isMap(doc.contents)) for (const top of doc.contents.items) group(top.key, top.value, 0);
  return out;
}

/** What Ansible refuses in a static INI inventory: a word after a host that is not name=value. */
export function iniProblems(file: string, text: string): InventoryProblem[] {
  const out: InventoryProblem[] = [];
  let section: 'hosts' | 'children' | 'vars' = 'hosts';
  text.split(/\r?\n/).forEach((raw, line) => {
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) return;
    const header = /^\[([^\]:]+)(?::(\w+))?\]/.exec(t);
    if (header) {
      if (header[2] && header[2] !== 'vars' && header[2] !== 'children')
        out.push({
          file,
          line,
          message: `[${header[1]}:${header[2]}]: a section is a group, [group:vars] or [group:children]`,
        });
      section = (header[2] as 'vars' | 'children' | undefined) ?? 'hosts';
      return;
    }
    if (t.startsWith('[')) {
      out.push({ file, line, message: 'A section header that does not close: [group]' });
      return;
    }
    if (section === 'vars' && !t.includes('='))
      out.push({ file, line, message: `${t}: a variable is written name=value` });
    if (section !== 'hosts') return;
    const words = t.replace(/\s+#.*$/, '').match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
    const bad = words.slice(1).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (bad)
      out.push({
        file,
        line,
        message: `${words[0]}: "${bad}" is not name=value (a host's address is written ansible_host=${bad})`,
      });
  });
  return out;
}

export function sourceProblems(file: string, text: string, kind: SourceKind): InventoryProblem[] {
  try {
    return kind === 'yaml'
      ? yamlProblems(file, text)
      : kind === 'ini'
        ? iniProblems(file, text)
        : [];
  } catch {
    return [];
  }
}

export function sourceEntries(file: string, text: string, kind: SourceKind): OriginEntry[] {
  try {
    return kind === 'yaml' ? yamlEntries(file, text) : kind === 'ini' ? iniEntries(file, text) : [];
  } catch {
    // A file that does not read has no entries; Ansible says what is wrong with it.
    return [];
  }
}

const RANGE = /\[([^\]:]+):([^\]:]+)(?::(\d+))?\]/;

/**
 * The names a host range stands for (`sw[01:10]`, `db-[a:c]`, with a step), 2000 at most; a plain
 * name is itself. Undefined when the range does not read.
 */
export function expandRange(pattern: string): string[] | undefined {
  const m = RANGE.exec(pattern);
  if (!m) return [pattern];
  const [whole, from, to, stepText] = m as unknown as [string, string, string, string | undefined];
  const step = stepText ? Number(stepText) : 1;
  if (step < 1) return undefined;
  const head = pattern.slice(0, m.index);
  const tail = pattern.slice(m.index + whole.length);
  const middles: string[] = [];
  if (/^\d+$/.test(from) && /^\d+$/.test(to)) {
    // A leading zero keeps the width (01, 02, … 10).
    const width = from.length > 1 && from.startsWith('0') ? from.length : 0;
    for (let n = Number(from); n <= Number(to) && middles.length <= 2000; n += step)
      middles.push(String(n).padStart(width, '0'));
  } else if (/^[A-Za-z]$/.test(from) && /^[A-Za-z]$/.test(to)) {
    for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c += step)
      middles.push(String.fromCharCode(c));
  } else return undefined;
  const out: string[] = [];
  for (const middle of middles) {
    const rest = expandRange(`${head}${middle}${tail}`);
    if (!rest) return undefined;
    out.push(...rest);
    if (out.length > 2000) return undefined;
  }
  return out;
}

/** Where each host and group is written, across the files of an inventory. */
export class OriginIndex {
  private readonly groups = new Map<string, Origin>();
  /** Host name → its places, each with the group it is written under. */
  private readonly hosts = new Map<string, (Origin & { group?: string })[]>();

  constructor(entries: readonly OriginEntry[]) {
    for (const e of entries) {
      if (e.type === 'group') {
        // The first place a group is written is where it opens.
        if (!this.groups.has(e.name)) this.groups.set(e.name, { file: e.file, line: e.line });
        continue;
      }
      const names = expandRange(e.name) ?? [e.name];
      const range = names.length > 1 || names[0] !== e.name ? e.name : undefined;
      for (const name of names) {
        const list = this.hosts.get(name) ?? [];
        list.push({ file: e.file, line: e.line, group: e.group, ...(range ? { range } : {}) });
        this.hosts.set(name, list);
      }
    }
  }

  group(name: string): Origin | undefined {
    return this.groups.get(name);
  }

  /** A host's place under this group when it is written there, else its first place. */
  host(name: string, group?: string): Origin | undefined {
    const list = this.hosts.get(name);
    const found = list?.find((o) => o.group === group) ?? list?.[0];
    if (!found) return undefined;
    const { group: _group, ...origin } = found;
    return origin;
  }
}

/** The `inventory` of an ansible.cfg's `[defaults]`: its sources as written, in order. */
export function defaultInventory(cfg: string): string[] {
  let inDefaults = false;
  for (const raw of cfg.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      inDefaults = header[1] === 'defaults';
      continue;
    }
    const m = inDefaults ? /^(inventory|hostfile)\s*[=:]\s*(.*)$/.exec(line) : null;
    if (m)
      return (m[2] as string)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  }
  return [];
}

/**
 * A file saved, created or deleted in the repository (its path from the root) that the inventory
 * view has to read again for: a source of the inventory, variables beside one, or ansible.cfg.
 * `sources`: the files in use, when they are known.
 */
export function touchesInventory(rel: string, sources: readonly string[] | undefined): boolean {
  const path = rel.split('\\').join('/');
  const parts = path.split('/');
  if (parts.at(-1) === 'ansible.cfg') return true;
  if (parts.some((p) => p === 'group_vars' || p === 'host_vars')) return true;
  if (sources) return sources.some((s) => s === path || path.startsWith(`${s}/`));
  return /(^|\/)(hosts|inventor(y|ies))(\/|[._-]|$)/i.test(path);
}

/** A new, empty YAML inventory, with the shape shown in comments. */
export function newInventoryText(): string {
  return [
    '# An Ansible inventory: groups hold hosts, and a host can be in several groups.',
    '# Variables go under a host or under `vars:` of a group, or into host_vars/ and group_vars/.',
    '#',
    '# all:',
    '#   children:',
    '#     lab:',
    '#       hosts:',
    '#         sw-lab-01:',
    '#           ansible_host: 192.0.2.11',
    '#       vars:',
    '#         ansible_network_os: cisco.ios.ios',
    'all:',
    '  children: {}',
    '',
  ].join('\n');
}
