// AFD-259, AFD-260: changes to an inventory's static files (YAML and INI): hosts, groups and the
// variables written in them. Each change is the smallest edit of the text that says it: comments,
// order and layout stay. Pure: the files' text in, the changed files out; the Inventory view and
// the agents' tool (AFD-261) both write through here.
//
// What is not written as plain names is not edited: a host that is one of a range (`sw[01:10]`),
// a dynamic source, an anchor or alias. The error says so, and the file opens as text instead.
import { parse, stringify } from 'yaml';
import { deleteKey, renameKey, setIn } from '../yaml/ops';
import type { Path } from '../yaml/parse';
import type { YamlValue } from '../yaml/render';
import { YamlEditError, YamlTransaction } from '../yaml/transaction';
import { expandRange, isStatic, type SourceKind } from './origins';

export interface InventoryFile {
  path: string;
  kind: SourceKind;
  text: string;
}

export type InventoryOp =
  | { op: 'add_host'; host: string; group: string }
  /** Without `group`: from every group it is written in. */
  | { op: 'remove_host'; host: string; group?: string }
  | { op: 'rename_host'; host: string; to: string }
  | { op: 'move_host'; host: string; from: string; to: string }
  /** `parent`: as a child of that group. `file`: where, when several files could hold it. */
  | { op: 'add_group'; group: string; parent?: string; file?: string }
  | { op: 'remove_group'; group: string }
  | { op: 'rename_group'; group: string; to: string }
  /**
   * AFD-262: a group, with everything in it, under another parent. `from`: the parent it leaves
   * (absent: the top level); `to`: the parent it goes under (absent: the top level).
   */
  | { op: 'move_group'; group: string; from?: string; to?: string }
  /** A variable written in the inventory file itself, on a host or in a group's variables. */
  | { op: 'set_var'; host?: string; group?: string; key: string; value: unknown }
  | { op: 'remove_var'; host?: string; group?: string; key: string };

export type InventoryEdit =
  | { ok: true; files: InventoryFile[] }
  /** `choose`: files a new group could go to; ask, and pass one as `file`. */
  | { ok: false; error: string; choose?: string[] };

const fail = (error: string): InventoryEdit => ({ ok: false, error });

/** A tag the parser does not know (`!vault`, `!unsafe`) is expected here, not a warning to log. */
const QUIET = { logLevel: 'error' } as const;

export function hostNameProblem(name: string): string | undefined {
  if (!name) return 'Enter a host name';
  if (!/^[A-Za-z0-9_.:-]+$/.test(name))
    return 'A host name has letters, digits, dots, dashes and underscores (a range is written in the file)';
  return undefined;
}

/** Ansible's rule for group names (it warns on others, and they do not work as variables). */
export function groupNameProblem(name: string): string | undefined {
  if (!name) return 'Enter a group name';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    return 'A group name has letters, digits and underscores, and does not start with a digit';
  return undefined;
}

export function varNameProblem(name: string): string | undefined {
  if (!name) return 'Enter a variable name';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    return 'A variable name has letters, digits and underscores, and does not start with a digit';
  return undefined;
}

// ---------------------------------------------------------------- INI

interface IniLine {
  raw: string;
  /** The section the line is in: its group and what it lists. */
  group: string;
  section: 'hosts' | 'children' | 'vars';
  header?: true;
  /** First word of a host or child line, the key of a variable line. */
  name?: string;
}

function iniLines(text: string): IniLine[] {
  let group = 'ungrouped';
  let section: IniLine['section'] = 'hosts';
  return text.split(/\r?\n/).map((raw): IniLine => {
    const t = raw.trim();
    const header = /^\[([^\]:]+)(?::(vars|children))?\]/.exec(t);
    if (header) {
      group = (header[1] as string).trim();
      section = (header[2] as 'vars' | 'children' | undefined) ?? 'hosts';
      return { raw, group, section, header: true };
    }
    if (!t || t.startsWith('#') || t.startsWith(';')) return { raw, group, section };
    const name = section === 'vars' ? t.split('=')[0]?.trim() : t.split(/\s+/)[0];
    return { raw, group, section, name };
  });
}

/**
 * A comment after a host and its variables. Only `#` starts one there: `;` is a comment at the
 * start of a line, and after a host Ansible reads it as a (broken) variable.
 */
const HOST_COMMENT = /\s+#.*$/;

const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');

function iniJoin(lines: IniLine[], text: string): string {
  return lines.map((l) => l.raw).join(eolOf(text));
}

/** The index after the last line with content of a section; -1 when the section is not there. */
function sectionEnd(lines: IniLine[], group: string, section: IniLine['section']): number {
  let end = -1;
  lines.forEach((l, i) => {
    if (l.group === group && l.section === section && (l.header || l.name)) end = i + 1;
  });
  // Hosts before the first section have no header: the top of the file is theirs.
  if (end === -1 && group === 'ungrouped' && section === 'hosts') {
    const first = lines.findIndex((l) => l.header);
    return first === -1 ? lines.length : first;
  }
  return end;
}

const line = (raw: string, like: IniLine): IniLine => ({ ...like, raw, header: undefined });

/** Adds a line to a section, making the section at the end of the file when it is not there. */
function iniAdd(
  lines: IniLine[],
  group: string,
  section: IniLine['section'],
  raw: string,
  name: string,
): IniLine[] {
  const out = [...lines];
  const end = sectionEnd(out, group, section);
  if (end >= 0) {
    out.splice(end, 0, { raw, group, section, name });
    return out;
  }
  // A file ends with one empty entry when its last line has a newline.
  while (out.length && out.at(-1)?.raw.trim() === '') out.pop();
  const title = section === 'hosts' ? `[${group}]` : `[${group}:${section}]`;
  if (out.length) out.push({ raw: '', group, section });
  out.push({ raw: title, group, section, header: true }, { raw, group, section, name });
  out.push({ raw: '', group, section });
  return out;
}

/** A value on an INI line: plain when it can be, quoted when it has spaces or a comment sign. */
function iniValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return undefined;
  if (/[\r\n]/.test(value)) return undefined;
  return /[\s#;"'=]/.test(value) || value === '' ? JSON.stringify(value) : value;
}

/** `key=value` words of a host line, quotes kept together. */
function iniWords(rest: string): string[] {
  return rest.match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
}

function iniHostsWritten(lines: IniLine[], host: string, group?: string): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (l.section === 'hosts' && !l.header && l.name === host && (!group || l.group === group))
      out.push(i);
  });
  return out;
}

/** The host is there only as one of a range: it has no line of its own to change. */
function inRange(names: readonly string[], host: string): string | undefined {
  return names.find((n) => n !== host && (expandRange(n) ?? []).includes(host));
}

function iniEdit(file: InventoryFile, op: InventoryOp): string | { error: string } {
  let lines = iniLines(file.text);
  const hostNames = (group?: string) =>
    lines
      .filter((l) => l.section === 'hosts' && l.name && (!group || l.group === group))
      .map((l) => l.name as string);
  const rangeError = (host: string, group?: string) => {
    const range = inRange(hostNames(group), host);
    return range
      ? {
          error: `${host} is written as one of the range ${range} in ${file.path}: change it in the file`,
        }
      : undefined;
  };
  switch (op.op) {
    case 'add_host': {
      if (iniHostsWritten(lines, op.host, op.group).length)
        return { error: `${op.host} is in ${op.group} already` };
      lines = iniAdd(lines, op.group, 'hosts', op.host, op.host);
      break;
    }
    case 'remove_host': {
      const at = iniHostsWritten(lines, op.host, op.group);
      if (!at.length)
        return (
          rangeError(op.host, op.group) ?? {
            error: `${op.host} is not written in ${op.group ?? file.path}`,
          }
        );
      lines = lines.filter((_, i) => !at.includes(i));
      break;
    }
    case 'rename_host': {
      const at = iniHostsWritten(lines, op.host);
      if (!at.length)
        return rangeError(op.host) ?? { error: `${op.host} is not written in ${file.path}` };
      for (const i of at) {
        const l = lines[i] as IniLine;
        lines[i] = { ...l, name: op.to, raw: l.raw.replace(op.host, op.to) };
      }
      break;
    }
    case 'add_group': {
      const known = lines.some((l) => l.header && l.group === op.group);
      if (known && !op.parent) return { error: `The group ${op.group} is there already` };
      if (!known) {
        while (lines.length && lines.at(-1)?.raw.trim() === '') lines.pop();
        if (lines.length) lines.push({ raw: '', group: op.group, section: 'hosts' });
        lines.push({ raw: `[${op.group}]`, group: op.group, section: 'hosts', header: true });
        lines.push({ raw: '', group: op.group, section: 'hosts' });
      }
      if (op.parent) {
        const child = lines.some(
          (l) => l.group === op.parent && l.section === 'children' && l.name === op.group,
        );
        if (child) return { error: `${op.group} is a child of ${op.parent} already` };
        lines = iniAdd(lines, op.parent, 'children', op.group, op.group);
      }
      break;
    }
    case 'remove_group': {
      if (!lines.some((l) => l.header && l.group === op.group))
        return { error: `The group ${op.group} is not written in ${file.path}` };
      lines = lines.filter(
        (l) => l.group !== op.group && !(l.section === 'children' && l.name === op.group),
      );
      break;
    }
    case 'rename_group': {
      if (!lines.some((l) => l.header && l.group === op.group))
        return { error: `The group ${op.group} is not written in ${file.path}` };
      if (lines.some((l) => l.header && l.group === op.to))
        return { error: `The group ${op.to} is there already` };
      lines = lines.map((l) => {
        if (l.header && l.group === op.group)
          return { ...l, group: op.to, raw: l.raw.replace(`[${op.group}`, `[${op.to}`) };
        if (l.section === 'children' && l.name === op.group)
          return { ...l, name: op.to, raw: l.raw.replace(op.group, op.to) };
        return l.group === op.group ? { ...l, group: op.to } : l;
      });
      break;
    }
    case 'move_group': {
      if (!lines.some((l) => l.header && l.group === op.group))
        return { error: `The group ${op.group} is not written in ${file.path}` };
      const childOf = (parent: string) =>
        lines.findIndex(
          (l) => l.group === parent && l.section === 'children' && l.name === op.group,
        );
      if (op.from) {
        const at = childOf(op.from);
        if (at < 0) return { error: `${op.group} is not a child of ${op.from} in ${file.path}` };
        lines = lines.filter((_, i) => i !== at);
      }
      if (op.to) {
        if (childOf(op.to) >= 0) return { error: `${op.group} is a child of ${op.to} already` };
        // Up from the new parent: the group itself must not be there.
        const parents = (name: string) =>
          lines.filter((l) => l.section === 'children' && l.name === name).map((l) => l.group);
        const seen = new Set<string>();
        const queue = [op.to];
        while (queue.length) {
          const name = queue.pop() as string;
          if (name === op.group)
            return { error: `${op.to} is ${op.group} or inside it: a group cannot hold itself` };
          if (seen.has(name)) continue;
          seen.add(name);
          queue.push(...parents(name));
        }
        if (!lines.some((l) => l.header && l.group === op.to))
          return { error: `The group ${op.to} is not written in ${file.path}` };
        lines = iniAdd(lines, op.to, 'children', op.group, op.group);
      }
      break;
    }
    case 'set_var':
    case 'remove_var': {
      const value = op.op === 'set_var' ? iniValue(op.value) : '';
      if (value === undefined)
        return {
          error: `An INI inventory holds simple values on a line: put ${op.key} in host_vars/ or group_vars/, or use a YAML inventory`,
        };
      if (op.group) {
        const at = lines.findIndex(
          (l) => l.group === op.group && l.section === 'vars' && l.name === op.key,
        );
        if (op.op === 'remove_var') {
          if (at < 0) return { error: `${op.key} is not written for ${op.group} in ${file.path}` };
          lines = lines.filter((_, i) => i !== at);
        } else if (at >= 0) lines[at] = line(`${op.key}=${value}`, lines[at] as IniLine);
        else {
          if (!lines.some((l) => l.header && l.group === op.group) && op.group !== 'all')
            return { error: `The group ${op.group} is not written in ${file.path}` };
          lines = iniAdd(lines, op.group, 'vars', `${op.key}=${value}`, op.key);
        }
        break;
      }
      const host = op.host as string;
      const at = iniHostsWritten(lines, host);
      if (!at.length)
        return rangeError(host) ?? { error: `${host} is not written in ${file.path}` };
      // A host's variables are the same on each of its lines: written on the first that has it,
      // else on its first line.
      let done = false;
      for (const i of at) {
        const l = lines[i] as IniLine;
        const comment = HOST_COMMENT.exec(l.raw)?.[0] ?? '';
        const body = comment ? l.raw.slice(0, -comment.length) : l.raw;
        const indent = /^\s*/.exec(body)?.[0] ?? '';
        const words = iniWords(body.trim().slice(host.length));
        const found = words.findIndex((w) => w.startsWith(`${op.key}=`));
        if (found < 0) continue;
        if (op.op === 'remove_var') words.splice(found, 1);
        else words[found] = `${op.key}=${value}`;
        lines[i] = { ...l, raw: `${indent}${[host, ...words].join(' ')}${comment}` };
        done = true;
        break;
      }
      if (!done) {
        if (op.op === 'remove_var')
          return { error: `${op.key} is not written for ${host} in ${file.path}` };
        const i = at[0] as number;
        const l = lines[i] as IniLine;
        const comment = HOST_COMMENT.exec(l.raw)?.[0] ?? '';
        const body = comment ? l.raw.slice(0, -comment.length) : l.raw;
        lines[i] = { ...l, raw: `${body.trimEnd()} ${op.key}=${value}${comment}` };
      }
      break;
    }
    default:
      return { error: 'Not a change of one file' };
  }
  return iniJoin(lines, file.text);
}

// ---------------------------------------------------------------- YAML

interface YamlGroup {
  name: string;
  path: Path;
  /** The group as data: its `hosts`, `children`, `vars`. */
  value: Record<string, unknown> | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Every place a group is written, top level first, then children in order. */
function yamlGroups(text: string): YamlGroup[] {
  const out: YamlGroup[] = [];
  const walk = (groups: unknown, at: Path, depth: number) => {
    if (!isObject(groups) || depth > 32) return;
    for (const [name, value] of Object.entries(groups)) {
      const path = [...at, name];
      out.push({ name, path, value: isObject(value) ? value : null });
      if (isObject(value)) walk(value.children, [...path, 'children'], depth + 1);
    }
  };
  walk(parse(text, QUIET), [], 0);
  return out;
}

const hostsOf = (g: YamlGroup): Record<string, unknown> | undefined =>
  isObject(g.value?.hosts) ? g.value.hosts : undefined;

function yamlEdit(file: InventoryFile, op: InventoryOp): string | { error: string } {
  const groups = yamlGroups(file.text);
  const tx = new YamlTransaction(file.text);
  const named = (name: string) => groups.filter((g) => g.name === name);
  /**
   * Sets `key` in the map at `mapPath`, whose current value is `now`. An empty or missing map is
   * written anew as a block, so `{}` and `key:` do not grow into one long line.
   */
  const put = (mapPath: Path, now: unknown, key: string, value: YamlValue) =>
    isObject(now) && Object.keys(now).length > 0
      ? tx.apply((f) => setIn(f, [...mapPath, key], value))
      : tx.apply((f) => setIn(f, mapPath, { [key]: value }));
  const withHost = (host: string, group?: string) =>
    groups.filter((g) => (!group || g.name === group) && hostsOf(g) && host in (hostsOf(g) ?? {}));
  const rangeError = (host: string, group?: string) => {
    const names = groups
      .filter((g) => !group || g.name === group)
      .flatMap((g) => Object.keys(hostsOf(g) ?? {}));
    const range = inRange(names, host);
    return range
      ? {
          error: `${host} is written as one of the range ${range} in ${file.path}: change it in the file`,
        }
      : undefined;
  };
  switch (op.op) {
    case 'add_host': {
      const g = named(op.group)[0];
      if (!g) return { error: `The group ${op.group} is not written in ${file.path}` };
      if (withHost(op.host, op.group).length)
        return { error: `${op.host} is in ${op.group} already` };
      if (g.value === null || Object.keys(g.value).length === 0)
        tx.apply((f) => setIn(f, g.path, { hosts: { [op.host]: {} } }));
      else put([...g.path, 'hosts'], g.value.hosts, op.host, {});
      break;
    }
    case 'remove_host': {
      const at = withHost(op.host, op.group);
      if (!at.length)
        return (
          rangeError(op.host, op.group) ?? {
            error: `${op.host} is not written in ${op.group ?? file.path}`,
          }
        );
      for (const g of at) tx.apply((f) => deleteKey(f, [...g.path, 'hosts'], op.host));
      break;
    }
    case 'rename_host': {
      const at = withHost(op.host);
      if (!at.length)
        return rangeError(op.host) ?? { error: `${op.host} is not written in ${file.path}` };
      for (const g of at) tx.apply((f) => renameKey(f, [...g.path, 'hosts'], op.host, op.to));
      break;
    }
    case 'add_group': {
      const known = named(op.group).length > 0;
      if (op.parent) {
        const parent = named(op.parent)[0];
        if (!parent) return { error: `The group ${op.parent} is not written in ${file.path}` };
        if (isObject(parent.value?.children) && op.group in parent.value.children)
          return { error: `${op.group} is a child of ${op.parent} already` };
        if (parent.value === null || Object.keys(parent.value).length === 0)
          tx.apply((f) => setIn(f, parent.path, { children: { [op.group]: {} } }));
        else put([...parent.path, 'children'], parent.value.children, op.group, {});
        break;
      }
      if (known) return { error: `The group ${op.group} is there already` };
      // Under `all` when the file is written that way, else a group of its own at the top.
      const all = groups.find((g) => g.name === 'all' && g.path.length === 1);
      if (!all) tx.apply((f) => setIn(f, [op.group], {}));
      else if (all.value === null || Object.keys(all.value).length === 0)
        tx.apply((f) => setIn(f, all.path, { children: { [op.group]: {} } }));
      else put([...all.path, 'children'], all.value.children, op.group, {});
      break;
    }
    case 'remove_group': {
      const at = named(op.group);
      if (!at.length) return { error: `The group ${op.group} is not written in ${file.path}` };
      for (const g of at) tx.apply((f) => deleteKey(f, g.path.slice(0, -1), op.group));
      break;
    }
    case 'rename_group': {
      const at = named(op.group);
      if (!at.length) return { error: `The group ${op.group} is not written in ${file.path}` };
      if (named(op.to).length) return { error: `The group ${op.to} is there already` };
      for (const g of at) tx.apply((f) => renameKey(f, g.path.slice(0, -1), op.group, op.to));
      break;
    }
    case 'move_group': {
      const top = groups.find((g) => g.name === 'all' && g.path.length === 1);
      // Where it is now: under `from`, else at the top (a key of its own, or a child of `all`).
      const isUnder = (g: YamlGroup, parent: string) =>
        g.path.length >= 3 && g.path.at(-2) === 'children' && g.path.at(-3) === parent;
      const source = named(op.group).find((g) =>
        op.from ? isUnder(g, op.from) : g.path.length === 1 || isUnder(g, 'all'),
      );
      if (!source)
        return {
          error: op.from
            ? `${op.group} is not a child of ${op.from} in ${file.path}`
            : `${op.group} is not at the top level in ${file.path}`,
        };
      const target = op.to ? named(op.to)[0] : top;
      if (op.to && !target) return { error: `The group ${op.to} is not written in ${file.path}` };
      const inSource = (path: Path) => source.path.every((part, i) => path[i] === part);
      if (target && inSource(target.path))
        return { error: `${op.to} is ${op.group} or inside it: a group cannot hold itself` };
      if (target && isObject(target.value?.children) && op.group in target.value.children)
        return {
          error: op.to
            ? `${op.group} is a child of ${op.to} already`
            : `${op.group} is at the top level already`,
        };
      if (!target && source.path.length === 1)
        return { error: `${op.group} is at the top level already` };
      // The group's lines as they are written, comments and all: its key line and every line
      // after it that is indented deeper.
      const lineOf = (text: string, name: string, parentPath: Path) => {
        const doc = new YamlTransaction(text).current.doc;
        const map = (parentPath.length ? doc.getIn(parentPath, true) : doc.contents) as
          | { flow?: boolean; items?: { key: { value?: unknown; range?: number[] } | null }[] }
          | undefined;
        const pair = map?.items?.find((p) => p.key?.value === name);
        const at = pair?.key?.range?.[0];
        if (map?.flow || at === undefined) return undefined;
        const before = text.slice(0, at);
        const start = before.lastIndexOf('\n') + 1;
        // A key that does not start its line is written inline: not moved as lines.
        if (before.slice(start).trim() !== '') return undefined;
        return { line: before.split('\n').length - 1, column: at - start };
      };
      const inline = {
        error: `${op.group} is written inline in ${file.path} (a {…} mapping): move it in the file`,
      };
      const from = lineOf(file.text, op.group, source.path.slice(0, -1));
      if (!from) return inline;
      const eol = eolOf(file.text);
      const all = file.text.split(/\r?\n/);
      let end = from.line + 1;
      while (end < all.length) {
        const l = all[end] as string;
        if (l.trim() !== '' && l.length - l.trimStart().length <= from.column) break;
        end++;
      }
      while (end > from.line + 1 && (all[end - 1] as string).trim() === '') end--;
      const block = all.slice(from.line, end);
      // Out of the old place and a stand-in at the new one, by the minimal-edit machinery; then
      // the stand-in's line is replaced with the group's own lines, indented for the new place.
      tx.apply((f) => deleteKey(f, source.path.slice(0, -1), op.group));
      const after = yamlGroups(tx.text);
      const parent = op.to
        ? after.find((g) => g.name === op.to)
        : after.find((g) => g.name === 'all' && g.path.length === 1);
      let parentPath: Path;
      if (!parent) {
        tx.apply((f) => setIn(f, [op.group], {}));
        parentPath = [];
      } else {
        parentPath = [...parent.path, 'children'];
        if (parent.value === null || Object.keys(parent.value).length === 0)
          tx.apply((f) => setIn(f, parent.path, { children: { [op.group]: {} } }));
        else put(parentPath, parent.value.children, op.group, {});
      }
      const to = lineOf(tx.text, op.group, parentPath);
      if (!to) return inline;
      const out = tx.text.split(/\r?\n/);
      const moved = block.map((l) =>
        l.trim() === '' ? '' : `${' '.repeat(to.column)}${l.slice(from.column)}`,
      );
      out.splice(to.line, 1, ...moved);
      const text = out.join(eol);
      // The same data in the new place, or nothing is changed.
      const path = [...parentPath, op.group].map(String);
      const dig = (data: unknown, keys: string[]) =>
        keys.reduce<unknown>((v, k) => (isObject(v) ? v[k] : undefined), data);
      if (
        new YamlTransaction(text).text !== text ||
        JSON.stringify(dig(parse(text, QUIET), path)) !== JSON.stringify(source.value)
      )
        return {
          error: `${op.group} could not be moved safely in ${file.path}: move it in the file`,
        };
      return text;
    }
    case 'set_var':
    case 'remove_var': {
      let mapPath: Path;
      let now: unknown;
      let who: string;
      if (op.group) {
        const g = named(op.group)[0];
        if (!g) return { error: `The group ${op.group} is not written in ${file.path}` };
        mapPath = [...g.path, 'vars'];
        now = g.value?.vars;
        who = op.group;
        if (op.op === 'set_var' && (g.value === null || Object.keys(g.value).length === 0)) {
          tx.apply((f) => setIn(f, g.path, { vars: { [op.key]: op.value as YamlValue } }));
          break;
        }
      } else {
        const host = op.host as string;
        const at = withHost(host);
        if (!at.length)
          return rangeError(host) ?? { error: `${host} is not written in ${file.path}` };
        // Where the variable is written already, else the host's first place.
        const g =
          at.find((x) => {
            const vars = hostsOf(x)?.[host];
            return isObject(vars) && op.key in vars;
          }) ?? (at[0] as YamlGroup);
        mapPath = [...g.path, 'hosts', host];
        now = hostsOf(g)?.[host];
        who = host;
      }
      if (op.op === 'remove_var') {
        if (!isObject(now) || !(op.key in now))
          return { error: `${op.key} is not written for ${who} in ${file.path}` };
        tx.apply((f) => deleteKey(f, mapPath, op.key));
      } else put(mapPath, now, op.key, op.value as YamlValue);
      break;
    }
    default:
      return { error: 'Not a change of one file' };
  }
  return tx.text;
}

// ---------------------------------------------------------------- both

function editFile(file: InventoryFile, op: InventoryOp): string | { error: string } {
  try {
    return file.kind === 'yaml' ? yamlEdit(file, op) : iniEdit(file, op);
  } catch (e) {
    if (e instanceof YamlEditError)
      return {
        error:
          e.code === 'unsupported'
            ? `${file.path} uses YAML anchors or aliases there: change it in the file`
            : `${file.path}: ${e.message}`,
      };
    throw e;
  }
}

/** What each static file writes: its groups, and for each the hosts as written. */
export function written(file: InventoryFile): { groups: string[]; hosts: Map<string, string[]> } {
  const hosts = new Map<string, string[]>();
  const groups: string[] = [];
  const add = (group: string, host?: string) => {
    if (!groups.includes(group)) groups.push(group);
    if (host) hosts.set(group, [...(hosts.get(group) ?? []), host]);
  };
  try {
    if (file.kind === 'yaml')
      for (const g of yamlGroups(file.text)) {
        add(g.name);
        for (const h of Object.keys(hostsOf(g) ?? {})) add(g.name, h);
      }
    else if (file.kind === 'ini')
      for (const l of iniLines(file.text)) {
        if (l.header) add(l.group);
        else if (l.section === 'hosts' && l.name) add(l.group, l.name);
        else if (l.section === 'children' && l.name) add(l.name);
      }
  } catch {
    // A file that does not read holds nothing to change.
  }
  return { groups, hosts };
}

/**
 * Applies one change to the inventory's files. A change goes to the file that writes what it
 * touches: a host's lines wherever they are, a group where it is first written.
 */
export function editInventory(files: readonly InventoryFile[], op: InventoryOp): InventoryEdit {
  const statics = files.filter((f) => isStatic(f.kind));
  if (!statics.length)
    return fail(
      'This inventory has no YAML or INI file to change (a dynamic source is read-only): create one with New Inventory…',
    );
  const info = new Map(statics.map((f) => [f.path, written(f)]));
  const withGroup = (group: string) =>
    statics.filter((f) => info.get(f.path)?.groups.includes(group));
  const withHost = (host: string, group?: string) =>
    statics.filter((f) =>
      [...(info.get(f.path)?.hosts ?? [])].some(
        ([g, names]) =>
          (!group || g === group) && names.some((n) => (expandRange(n) ?? [n]).includes(host)),
      ),
    );
  const apply = (targets: InventoryFile[], one: InventoryOp): InventoryEdit => {
    const out: InventoryFile[] = [];
    for (const file of targets) {
      const text = editFile(file, one);
      if (typeof text !== 'string') return fail(text.error);
      if (text !== file.text) out.push({ ...file, text });
    }
    return { ok: true, files: out };
  };
  const first = <T>(list: T[]): T[] => list.slice(0, 1);

  switch (op.op) {
    case 'add_host': {
      const bad = hostNameProblem(op.host) ?? groupNameProblem(op.group);
      if (bad) return fail(bad);
      let targets = first(withGroup(op.group));
      // `ungrouped` and `all` are Ansible's own: written in the first INI file, or under `all`.
      if (!targets.length && op.group === 'ungrouped')
        targets = first(statics.filter((f) => f.kind === 'ini'));
      if (!targets.length)
        return fail(
          `The group ${op.group} is not written in a file of this inventory: add the group first`,
        );
      return apply(targets, op);
    }
    case 'remove_host': {
      const targets = op.group ? first(withHost(op.host, op.group)) : withHost(op.host);
      if (!targets.length) return fail(`${op.host} is not written in a file of this inventory`);
      return apply(targets, op);
    }
    case 'rename_host': {
      const bad = hostNameProblem(op.to);
      if (bad) return fail(bad);
      if (withHost(op.to).length) return fail(`${op.to} is in the inventory already`);
      const targets = withHost(op.host);
      if (!targets.length) return fail(`${op.host} is not written in a file of this inventory`);
      return apply(targets, op);
    }
    case 'move_host': {
      if (op.from === op.to) return fail(`${op.host} is in ${op.to} already`);
      // The variables written on the host where it leaves go with it.
      const carried = inlineVars(statics, { host: op.host, under: op.from });
      if (carried.some((v) => v.vaulted))
        return fail(
          `${op.host} has a vault-encrypted value written on it in ${op.from}: move it in the file`,
        );
      // Each step works on the texts the one before left, so a file that holds both groups is
      // written once, and nothing is written when a step is refused.
      let now = [...files];
      const changed = new Map<string, InventoryFile>();
      const steps: InventoryOp[] = [
        { op: 'remove_host', host: op.host, group: op.from },
        { op: 'add_host', host: op.host, group: op.to },
        ...carried.map(
          (v): InventoryOp => ({ op: 'set_var', host: op.host, key: v.key, value: v.value }),
        ),
      ];
      for (const step of steps) {
        const r = editInventory(now, step);
        if (!r.ok) return r;
        for (const f of r.files) changed.set(f.path, f);
        now = now.map((f) => changed.get(f.path) ?? f);
      }
      return { ok: true, files: [...changed.values()] };
    }
    case 'add_group': {
      const bad =
        groupNameProblem(op.group) ?? (op.parent ? groupNameProblem(op.parent) : undefined);
      if (bad) return fail(bad);
      if (op.parent) {
        const targets = first(withGroup(op.parent));
        if (!targets.length)
          return fail(`The group ${op.parent} is not written in a file of this inventory`);
        return apply(targets, op);
      }
      if (withGroup(op.group).length) return fail(`The group ${op.group} is there already`);
      const target = op.file ? statics.filter((f) => f.path === op.file) : statics;
      if (target.length !== 1)
        return {
          ok: false,
          error: 'Which file should hold the new group?',
          choose: statics.map((f) => f.path),
        };
      return apply(target, op);
    }
    case 'remove_group': {
      const targets = withGroup(op.group);
      if (!targets.length)
        return fail(`The group ${op.group} is not written in a file of this inventory`);
      return apply(targets, op);
    }
    case 'rename_group': {
      const bad = groupNameProblem(op.to);
      if (bad) return fail(bad);
      if (withGroup(op.to).length) return fail(`The group ${op.to} is there already`);
      const targets = withGroup(op.group);
      if (!targets.length)
        return fail(`The group ${op.group} is not written in a file of this inventory`);
      return apply(targets, op);
    }
    case 'move_group': {
      if (op.from === op.to)
        return fail(`${op.group} is ${op.to ? `under ${op.to}` : 'at the top level'} already`);
      if (op.to === op.group) return fail('A group cannot hold itself');
      const targets = first(withGroup(op.group));
      if (!targets.length)
        return fail(`The group ${op.group} is not written in a file of this inventory`);
      if (op.to && !withGroup(op.to).length)
        return fail(`The group ${op.to} is not written in a file of this inventory`);
      if (op.to && !written(targets[0] as InventoryFile).groups.includes(op.to))
        return fail(`${op.to} is written in another file than ${op.group}: move it in the files`);
      return apply(targets, op);
    }
    case 'set_var':
    case 'remove_var': {
      const bad = varNameProblem(op.key);
      if (bad) return fail(bad);
      if (!op.host === !op.group) return fail('A variable is a host’s or a group’s: name one');
      const holders = op.group ? withGroup(op.group) : withHost(op.host as string);
      // Where it is written already, else the first file that writes the host or the group.
      const has = holders.filter((f) => inlineVars([f], op).some((v) => v.key === op.key));
      const targets = first(has.length ? has : holders);
      if (!targets.length)
        return fail(`${op.group ?? op.host} is not written in a file of this inventory`);
      return apply(targets, op);
    }
  }
}

// ---------------------------------------------------------------- variables

export interface VarEntry {
  key: string;
  /** As data; undefined when vaulted. */
  value?: unknown;
  /** The value is vault-encrypted: never shown, never edited here. */
  vaulted?: true;
  file: string;
  /** Zero-based line. */
  line: number;
}

const lineOfOffset = (text: string, offset: number) => text.slice(0, offset).split('\n').length - 1;

/** The keys of the YAML map at `path` of a text, with their lines; `!vault` values are not read. */
function yamlMapVars(file: string, text: string, path: Path): VarEntry[] {
  let tx: YamlTransaction;
  try {
    tx = new YamlTransaction(text);
  } catch {
    return [];
  }
  const node = path.length ? tx.current.doc.getIn(path, true) : tx.current.doc.contents;
  const items = (node as { items?: { key: unknown; value: unknown }[] } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const out: VarEntry[] = [];
  for (const pair of items) {
    const key = (pair.key as { value?: unknown; range?: [number, number, number] } | null) ?? {};
    if (typeof key.value !== 'string') continue;
    const value = pair.value as { tag?: string; toJSON?: () => unknown } | null;
    const entry: VarEntry = { key: key.value, file, line: lineOfOffset(text, key.range?.[0] ?? 0) };
    if (value?.tag === '!vault') entry.vaulted = true;
    else entry.value = value?.toJSON ? value.toJSON() : null;
    out.push(entry);
  }
  return out;
}

/** A word of an INI line as data, the way the INI inventory plugin reads simple values. */
function iniRead(word: string): unknown {
  if (/^".*"$/.test(word)) {
    try {
      return JSON.parse(word);
    } catch {
      return word.slice(1, -1);
    }
  }
  if (/^'.*'$/.test(word)) return word.slice(1, -1);
  if (/^-?\d+$/.test(word)) return Number(word);
  if (/^(true|false)$/i.test(word)) return word.toLowerCase() === 'true';
  return word;
}

/** The variables written in the inventory files themselves for a host or a group. */
export function inlineVars(
  files: readonly InventoryFile[],
  /** `under`: only what is written on the host where it is listed in that group. */
  target: { host?: string; group?: string; under?: string },
): VarEntry[] {
  const out: VarEntry[] = [];
  const seen = new Set<string>();
  const push = (v: VarEntry) => {
    if (seen.has(v.key)) return;
    seen.add(v.key);
    out.push(v);
  };
  for (const file of files) {
    if (file.kind === 'yaml') {
      let groups: YamlGroup[];
      try {
        groups = yamlGroups(file.text);
      } catch {
        continue;
      }
      for (const g of groups) {
        if (target.group && g.name === target.group)
          for (const v of yamlMapVars(file.path, file.text, [...g.path, 'vars'])) push(v);
        if (
          target.host &&
          (!target.under || g.name === target.under) &&
          hostsOf(g) &&
          target.host in (hostsOf(g) ?? {})
        )
          for (const v of yamlMapVars(file.path, file.text, [...g.path, 'hosts', target.host]))
            push(v);
      }
    } else if (file.kind === 'ini') {
      iniLines(file.text).forEach((l, i) => {
        if (target.group && l.group === target.group && l.section === 'vars' && l.name) {
          const at = l.raw.indexOf('=');
          push({
            key: l.name,
            value: iniRead(l.raw.slice(at + 1).trim()),
            file: file.path,
            line: i,
          });
        }
        if (
          target.host &&
          (!target.under || l.group === target.under) &&
          l.section === 'hosts' &&
          !l.header &&
          l.name === target.host
        ) {
          const body = l.raw.replace(HOST_COMMENT, '').trim().slice(target.host.length);
          for (const word of iniWords(body)) {
            const at = word.indexOf('=');
            if (at > 0)
              push({
                key: word.slice(0, at),
                value: iniRead(word.slice(at + 1)),
                file: file.path,
                line: i,
              });
          }
        }
      });
    }
  }
  return out;
}

/** A whole file encrypted with ansible-vault: nothing in it is read or changed here. */
export const isVaultFile = (text: string): boolean =>
  text.trimStart().startsWith('$ANSIBLE_VAULT;');

/** The variables of a `host_vars/` or `group_vars/` file (a YAML mapping). */
export function fileVars(path: string, text: string): VarEntry[] {
  return isVaultFile(text) ? [] : yamlMapVars(path, text, []);
}

/** Sets a variable in a variables file; `text` undefined makes a new file. */
export function setVarInFile(
  text: string | undefined,
  key: string,
  value: unknown,
): string | { error: string } {
  const bad = varNameProblem(key);
  if (bad) return { error: bad };
  if (text !== undefined && isVaultFile(text))
    return { error: 'The file is encrypted with ansible-vault: change it with ansible-vault edit' };
  const base =
    text === undefined || text.trim() === '' || text.trim() === '---' ? '---\n{}\n' : text;
  try {
    const tx = new YamlTransaction(base);
    const now = parse(base, QUIET) as unknown;
    if (now !== null && !isObject(now)) return { error: 'The file is not a mapping of variables' };
    if (isObject(now) && Object.keys(now).length > 0)
      tx.apply((f) => setIn(f, [key], value as YamlValue));
    else {
      // The first variable of the file: written as a block, not into `{}`.
      return `${base.startsWith('---') ? '---\n' : ''}${stringify({ [key]: value }, { lineWidth: 0 })}`;
    }
    return tx.text;
  } catch (e) {
    if (e instanceof YamlEditError) return { error: e.message };
    throw e;
  }
}

export function removeVarInFile(text: string, key: string): string | { error: string } {
  if (isVaultFile(text))
    return { error: 'The file is encrypted with ansible-vault: change it with ansible-vault edit' };
  try {
    return new YamlTransaction(text).apply((f) => deleteKey(f, [], key)).text;
  } catch (e) {
    if (e instanceof YamlEditError) return { error: e.message };
    throw e;
  }
}

/**
 * What the user typed for a value, as data: YAML as it would be in a variables file (`10`, `true`,
 * `[a, b]`, `{k: v}`), else the text itself.
 */
export function parseValue(text: string): unknown {
  const t = text.trim();
  if (t === '') return '';
  try {
    const v = parse(t, QUIET) as unknown;
    return v === undefined ? t : v;
  } catch {
    return t;
  }
}

/** A value on one line, for the view: strings as they are, the rest as compact YAML-like JSON. */
export function showValue(v: VarEntry): string {
  if (v.vaulted) return '(vaulted)';
  if (typeof v.value === 'string') return v.value;
  return JSON.stringify(v.value ?? null);
}
