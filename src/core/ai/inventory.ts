// The inventory tool (AFD-261): the inventory a repository uses, for AI assistants. `list` shows
// its files, groups, hosts and variables as they are written; `edit` changes them with the same
// engine as the Inventory view (core/inventory/edit), so the same things are read-only: a host of
// a range, a dynamic source, vaulted values. Values that are vaulted, or whose name looks like a
// secret, are never shown.
import {
  editInventory,
  type InventoryOp,
  removeVarInFile,
  setVarInFile,
  showValue,
  type VarEntry,
  varNameProblem,
  written,
} from '../inventory/edit';
import {
  type InventoryData,
  targetVars,
  type VarPlace,
  varPlace,
  varRenames,
} from '../inventory/files';
import {
  expandRange,
  isStatic,
  SOURCE_LABEL,
  type SourceKind,
  sourceEntries,
} from '../inventory/origins';
import type { ToolResult } from './handlers';

/** What a host gives the tool: the inventory's files, and a way to write them. */
export interface InventoryIO {
  /**
   * The inventory in use (`inventory`: another one, a path in the repository), or why there is
   * none. `label` says which one it is.
   */
  read(inventory?: string): Promise<{ data: InventoryData; label: string } | string>;
  /**
   * Renames first (variables files of a renamed host or group), then writes whole files, new ones
   * too, under their names after the renames. Notes for the answer.
   */
  write(writes: { path: string; text: string }[], renames: [string, string][]): Promise<string[]>;
}

export type InventoryToolOp =
  | Exclude<InventoryOp, { op: 'set_var' }>
  /** `where`: `file` (host_vars/, group_vars/) or `inventory`; default: where it is, else the rule. */
  | {
      op: 'set_var';
      host?: string;
      group?: string;
      key: string;
      value: unknown;
      where?: 'file' | 'inventory';
    };

export interface InventoryInput {
  action?: 'list' | 'edit';
  inventory?: string;
  host?: string;
  group?: string;
  ops?: InventoryToolOp[];
}

const fail = (text: string): ToolResult => ({ text, isError: true });

/** Names whose values are not shown to a model: the product owner's list. */
const SECRET = /(password|passwd|secret|token|key)/i;

export function shownToAgent(v: VarEntry): string {
  if (v.vaulted) return '(vaulted)';
  if (SECRET.test(v.key)) return '(hidden: the name looks like a secret)';
  const text = showValue(v);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const few = (names: string[], max = 40) =>
  names.length > max
    ? `${names.slice(0, max).join(', ')}, … (${names.length - max} more)`
    : names.join(', ');

interface Written {
  groups: string[];
  /** Group → hosts as written (ranges as written). */
  hosts: Map<string, string[]>;
}

/** What the static files write, merged across them. */
function writtenIn(data: InventoryData): Written {
  const out: Written = { groups: [], hosts: new Map() };
  for (const file of data.texts) {
    const w = written(file);
    for (const g of w.groups) if (!out.groups.includes(g)) out.groups.push(g);
    for (const [g, hosts] of w.hosts)
      out.hosts.set(g, [...new Set([...(out.hosts.get(g) ?? []), ...hosts])]);
  }
  for (const e of data.entries)
    if (e.type === 'group' && !out.groups.includes(e.name)) out.groups.push(e.name);
  return out;
}

function varLines(data: InventoryData, target: { host?: string; group?: string }): string[] {
  const vars = targetVars(data, target);
  return vars.length
    ? vars.map((v) => `  - ${v.key} = ${shownToAgent(v)}  (${v.file}:${v.line + 1})`)
    : ['  (none written for it)'];
}

function list(data: InventoryData, label: string, input: InventoryInput): ToolResult {
  const w = writtenIn(data);
  const dynamic = data.sources.filter((s) => s.kind === 'plugin' || s.kind === 'script');
  if (input.host) {
    const host = input.host;
    const groups = [...w.hosts]
      .filter(([, names]) => names.some((n) => (expandRange(n) ?? [n]).includes(host)))
      .map(([g]) => g);
    const range = [...w.hosts.values()]
      .flat()
      .find((n) => n !== host && (expandRange(n) ?? []).includes(host));
    if (!groups.length && !targetVars(data, { host }).length)
      return fail(
        `${host} is not written in a file of ${label}${dynamic.length ? ' (a dynamic source may still provide it; its variables can go to host_vars/)' : ''}.`,
      );
    return {
      text: [
        `Host ${host} in ${label}`,
        `Groups: ${groups.length ? groups.join(', ') : '(none written)'}`,
        ...(range
          ? [
              `Written as one of the range ${range}: its line is not edited; variables go to host_vars/.`,
            ]
          : []),
        'Variables written for it:',
        ...varLines(data, { host }),
      ].join('\n'),
    };
  }
  if (input.group) {
    const group = input.group;
    if (!w.groups.includes(group) && !targetVars(data, { group }).length)
      return fail(`The group ${group} is not written in a file of ${label}.`);
    const hosts = w.hosts.get(group) ?? [];
    return {
      text: [
        `Group ${group} in ${label}`,
        `Hosts as written (${hosts.length}): ${hosts.length ? few(hosts) : '(none)'}`,
        'Variables written for it:',
        ...varLines(data, { group }),
      ].join('\n'),
    };
  }
  const lines = [`Inventory: ${label}`, 'Sources:'];
  for (const s of data.sources)
    lines.push(
      `- ${s.path}: ${
        s.kind === 'missing'
          ? 'not found'
          : s.kind === 'outside'
            ? 'outside the repository (not read)'
            : SOURCE_LABEL[s.kind as SourceKind]
      }`,
    );
  if (!data.sources.length)
    lines.push('- (none: ansible.cfg names no inventory in the repository)');
  if (data.problems.length) {
    lines.push('Problems (Ansible leaves out what it cannot read: the group, or the whole file):');
    for (const p of data.problems.slice(0, 20))
      lines.push(`- ${p.file}:${p.line + 1}: ${p.message}`);
  }
  lines.push('Groups as written in the files:');
  for (const g of w.groups) {
    const hosts = w.hosts.get(g) ?? [];
    const vars = targetVars(data, { group: g }).length;
    lines.push(
      `- ${g}: ${plural(hosts.length, 'host line')}${hosts.length ? `: ${few(hosts, 12)}` : ''}${vars ? `; ${plural(vars, 'variable')}` : ''}`,
    );
  }
  if (!w.groups.length) lines.push('- (none)');
  if (dynamic.length)
    lines.push(
      `Hosts of ${dynamic.map((s) => s.path).join(', ')} come from elsewhere and are not listed; they are read-only here.`,
    );
  lines.push(
    `Variables folders: host_vars ${data.varDirs.host ?? '(none)'}, group_vars ${data.varDirs.group ?? '(none)'}.`,
    'Details: action list with host or group. Changes: action edit with ops.',
  );
  return { text: lines.join('\n') };
}

/** One line for the answer: what an op did. */
function did(op: InventoryToolOp, extra = ''): string {
  switch (op.op) {
    case 'add_host':
      return `Added ${op.host} to ${op.group}.`;
    case 'remove_host':
      return `Removed ${op.host} from ${op.group ?? 'every group'}.`;
    case 'rename_host':
      return `Renamed ${op.host} to ${op.to}.${extra}`;
    case 'move_host':
      return `Moved ${op.host} from ${op.from} to ${op.to}.`;
    case 'add_group':
      return `Added the group ${op.group}${op.parent ? ` under ${op.parent}` : ''}.`;
    case 'remove_group':
      return `Deleted the group ${op.group}.`;
    case 'rename_group':
      return `Renamed the group ${op.group} to ${op.to}.${extra}`;
    case 'move_group':
      return `Moved the group ${op.group} ${op.to ? `under ${op.to}` : 'to the top level'}.`;
    case 'set_var':
      return `Set ${op.key} for ${op.host ?? op.group}${extra}.`;
    case 'remove_var':
      return `Removed ${op.key} from ${op.host ?? op.group}${extra}.`;
  }
}

const BUILT_IN = new Set(['all', 'ungrouped']);

async function edit(
  io: InventoryIO,
  start: InventoryData,
  label: string,
  ops: InventoryToolOp[],
): Promise<ToolResult> {
  // Every op works on what the ones before left; nothing is written unless all of them apply.
  let data = start;
  const writes = new Map<string, string>();
  const renames: [string, string][] = [];
  const lines: string[] = [];
  const put = (path: string, text: string, isVarFile?: { of: 'host' | 'group'; name: string }) => {
    writes.set(path, text);
    const texts = data.texts.map((f) => (f.path === path ? { ...f, text } : f));
    data = {
      ...data,
      texts,
      // Where things are written, as the texts are now: a host added by an earlier op of the
      // batch is written in the file, so its variable goes on its line, not to a variables file.
      entries: texts.flatMap((f) => sourceEntries(f.path, f.text, f.kind)),
      varFiles: isVarFile
        ? [...data.varFiles.filter((f) => f.path !== path), { ...isVarFile, path, text }]
        : data.varFiles,
      // A variables file made now makes its folder: the next variable goes there too.
      varDirs:
        isVarFile && !data.varDirs[isVarFile.of]
          ? { ...data.varDirs, [isVarFile.of]: path.slice(0, path.lastIndexOf('/')) }
          : data.varDirs,
    };
  };
  for (const [i, op] of ops.entries()) {
    const no = (why: string) => fail(`op ${i + 1} (${op.op}): ${why} Nothing was changed.`);
    if (!op || typeof op !== 'object' || typeof op.op !== 'string') return no('not an op.');
    if (
      (op.op === 'remove_group' || op.op === 'rename_group' || op.op === 'move_group') &&
      BUILT_IN.has(op.group)
    )
      return no(`${op.group} is Ansible's own group.`);
    if (op.op === 'set_var' || op.op === 'remove_var') {
      const bad = varNameProblem(op.key);
      if (bad) return no(`${bad}.`);
      if (!op.host === !op.group) return no('name a host or a group.');
      const target = op.host ? { host: op.host } : { group: op.group };
      const of = op.host ? 'host' : 'group';
      const name = (op.host ?? op.group) as string;
      const now = targetVars(data, target).find((v) => v.key === op.key);
      if (now?.vaulted)
        return no(`${op.key} is vault-encrypted in ${now.file}: it is changed with ansible-vault.`);
      let place: VarPlace;
      if (op.op === 'remove_var') {
        if (!now) return no(`${op.key} is not written for ${name}.`);
        place = now.inline ? { inline: true } : { file: now.file };
      } else if (now && !op.where) place = now.inline ? { inline: true } : { file: now.file };
      else {
        const rule = varPlace(data, target);
        const file = 'ask' in rule ? rule.ask[0] : 'file' in rule ? rule : undefined;
        if (op.where === 'inventory') place = { inline: true };
        else if (op.where === 'file')
          place = file ?? {
            file: `${data.varDirs.base ? `${data.varDirs.base}/` : ''}${of}_vars/${name}.yml`,
          };
        // Both in use: the variables file, as the rule prefers a folder that is there.
        else place = 'ask' in rule ? rule.ask[0] : rule;
      }
      if ('inline' in place) {
        const { where: _where, ...plain } = op as InventoryToolOp & { where?: string };
        const r = editInventory(data.texts, plain as InventoryOp);
        if (!r.ok) return no(`${r.error}.`);
        for (const f of r.files) put(f.path, f.text);
        lines.push(did(op, ` in ${r.files[0]?.path ?? 'the inventory file'}`));
        continue;
      }
      const path = place.file;
      const before = writes.get(path) ?? data.varFiles.find((f) => f.path === path)?.text;
      const text =
        op.op === 'set_var'
          ? setVarInFile(before, op.key, op.value)
          : removeVarInFile(before ?? '', op.key);
      if (typeof text !== 'string') return no(`${text.error}.`);
      put(path, text, { of, name });
      lines.push(did(op, ` in ${path}`));
      continue;
    }
    const r = editInventory(data.texts, op);
    if (!r.ok)
      return no(
        r.choose
          ? `several files could hold the new group: pass file, one of ${r.choose.join(', ')}.`
          : `${r.error}.`,
      );
    for (const f of r.files) put(f.path, f.text);
    let extra = '';
    if (op.op === 'rename_host' || op.op === 'rename_group') {
      const of = op.op === 'rename_host' ? 'host' : 'group';
      const from = op.op === 'rename_host' ? op.host : op.group;
      const moved = varRenames(data, of, from, op.to);
      renames.push(...moved);
      if (moved.length)
        extra = ` Its variables file is renamed too (${moved.map(([, to]) => to).join(', ')}).`;
      data = {
        ...data,
        varFiles: data.varFiles.map((f) => {
          const hit = moved.find(([old]) => f.path === old || f.path.startsWith(`${old}/`));
          return hit && f.of === of && f.name === from
            ? { ...f, name: op.to, path: `${hit[1]}${f.path.slice(hit[0].length)}` }
            : f;
        }),
      };
    }
    lines.push(did(op, extra));
  }
  // A file renamed in this batch is written under its new name.
  const out = [...writes].map(([path, text]) => {
    const hit = renames.find(([old]) => path === old || path.startsWith(`${old}/`));
    return { path: hit ? `${hit[1]}${path.slice(hit[0].length)}` : path, text };
  });
  const notes = await io.write(out, renames);
  return {
    text: [
      `${label}: ${plural(ops.length, 'change')}.`,
      ...lines.map((l) => `- ${l}`),
      ...notes,
    ].join('\n'),
  };
}

export async function inventoryTool(
  io: InventoryIO | undefined,
  input: InventoryInput,
): Promise<ToolResult> {
  if (!io) return fail('The inventory is not available here');
  const action = input.action ?? 'list';
  if (action !== 'list' && action !== 'edit') return fail('action is list or edit');
  const read = await io.read(input.inventory);
  if (typeof read === 'string') return fail(read);
  if (action === 'list') return list(read.data, read.label, input);
  if (!Array.isArray(input.ops) || input.ops.length === 0)
    return fail('edit needs ops: a list of at least one change');
  if (!read.data.texts.length && input.ops.some((o) => o.op !== 'set_var' && o.op !== 'remove_var'))
    return fail(
      `${read.label} has no YAML or INI file to change${read.data.sources.some((s) => !isStatic(s.kind as SourceKind)) ? ' (its sources are dynamic or not found: read-only)' : ''}. Only variables in host_vars/ and group_vars/ can be set.`,
    );
  try {
    return await edit(io, read.data, read.label, input.ops);
  } catch (e) {
    return fail(`The inventory was not changed: ${(e as Error).message}`);
  }
}
