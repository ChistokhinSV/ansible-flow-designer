// Reading Ansible files for an import (AFD-26): YAML with Ansible's tags, the line of every mapping,
// repository paths and ansible.cfg. Pure: files come through a SourceIO, so the same reader runs in
// the extension (workspace.fs), the MCP server (files inside its roots) and tests (memory).
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  parseDocument,
  type ScalarTag,
} from 'yaml';
import { VAULT } from './secrets';

/** Files by repository path (forward slashes, no leading slash). */
export interface SourceIO {
  /** The text of a file, or undefined when it is missing or not allowed. */
  read(path: string): Promise<string | undefined>;
  /** Entries of a folder ('' is the root); empty when it is missing. */
  list(dir: string): Promise<{ name: string; dir: boolean }[]>;
  /** Cheaper than read when the host can tell. */
  exists?(path: string): Promise<boolean>;
}

export async function exists(io: SourceIO, path: string): Promise<boolean> {
  return io.exists ? io.exists(path) : (await io.read(path)) !== undefined;
}

// ---- paths ---------------------------------------------------------------------------------------

export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function join(...parts: string[]): string {
  return normalize(parts.filter(Boolean).join('/'));
}

/** `to` relative to the folder `from`, both repository paths. */
export function relative(from: string, to: string): string {
  const a = normalize(from).split('/').filter(Boolean);
  const b = normalize(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/') || '.';
}

export const isTemplated = (s: string) => /{{|{%/.test(s);

// ---- YAML ----------------------------------------------------------------------------------------

/** The line (1-based) where a mapping started, for notes and the outline. */
export const LINE = Symbol('line');

export type Plain = string | number | boolean | null | typeof VAULT | Plain[] | PlainMap;
export interface PlainMap {
  [key: string]: Plain;
  [LINE]?: number;
}

const vault: ScalarTag = { tag: '!vault', resolve: () => VAULT as unknown as string };
const unsafe: ScalarTag = { tag: '!unsafe', resolve: (s: string) => s };

/** A file that is encrypted as a whole (ansible-vault encrypt): nothing in it can be read. */
export const isVaultFile = (text: string) => text.trimStart().startsWith('$ANSIBLE_VAULT;');

/**
 * Parses one YAML document the way Ansible reads it: `!vault` values become VAULT (the ciphertext is
 * dropped), `!unsafe` is a plain string, merge keys apply, and every mapping remembers its line.
 */
export function parseAnsible(text: string): { value: Plain; error?: string } {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, customTags: [vault, unsafe], uniqueKeys: false });
  if (doc.errors.length) return { value: null, error: doc.errors[0]?.message.split('\n')[0] };
  const plain = (node: unknown, depth = 0): Plain => {
    if (depth > 64) return null;
    if (isAlias(node)) return plain(node.resolve(doc), depth + 1);
    if (isMap(node)) {
      const out: PlainMap = {};
      const range = (node as Node).range;
      if (range) out[LINE] = lineCounter.linePos(range[0]).line;
      const merged: PlainMap[] = [];
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        const value = plain(pair.value, depth + 1);
        if (key === '<<') {
          for (const m of Array.isArray(value) ? value : [value])
            if (m && typeof m === 'object' && !Array.isArray(m)) merged.push(m as PlainMap);
        } else out[key] = value;
      }
      for (const m of merged) for (const [k, v] of Object.entries(m)) if (!(k in out)) out[k] = v;
      return out;
    }
    if (isSeq(node)) return node.items.map((i) => plain(i, depth + 1));
    if (isScalar(node)) return node.value as Plain;
    return null;
  };
  return { value: plain(doc.contents) };
}

export const isMapping = (v: unknown): v is PlainMap =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export const lineOf = (v: unknown): number | undefined =>
  isMapping(v) ? (v as PlainMap)[LINE] : undefined;

/** A copy without the line markers and with VAULT kept (secrets are handled by the mapper). */
export function toValue(v: Plain): unknown {
  if (Array.isArray(v)) return v.map(toValue);
  if (isMapping(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)]));
  return v;
}

// ---- ansible.cfg ---------------------------------------------------------------------------------

export interface AnsibleConfig {
  /** Folder of the ansible.cfg file. */
  dir: string;
  rolesPath: string[];
  collectionsPath: string[];
  /** `explicit`: plays gather facts only when they ask. */
  gathering?: string;
}

/** The [defaults] section of an ansible.cfg (paths relative to its folder, `~` left out). */
export function parseConfig(text: string, dir: string): AnsibleConfig {
  let section = '';
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head) section = head[1]?.trim().toLowerCase() ?? '';
    else if (section === 'defaults') {
      const kv = /^([A-Za-z_]+)\s*[=:]\s*(.*)$/.exec(line);
      if (kv?.[1]) values[kv[1].toLowerCase()] = kv[2]?.trim() ?? '';
    }
  }
  const paths = (v?: string) =>
    (v ?? '')
      .split(/[:,]/)
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith('~') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p))
      .map((p) => join(dir, p));
  return {
    dir,
    rolesPath: paths(values.roles_path),
    collectionsPath: paths(values.collections_path ?? values.collections_paths),
    gathering: values.gathering?.toLowerCase(),
  };
}
