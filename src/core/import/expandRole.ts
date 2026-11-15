// Expand into Subflow (AFD-293): a step bound to a role becomes a subflow of the role's work, so each
// part gets its own ports and routing. A role whose main only includes task files keeps running as
// the role: a step per file (include_role tasks_from), as import does. Any other role is copied: a
// step per task, read as import reads a playbook, its handlers as notify links (AFD-292), its
// defaults and vars (and the values the step passed) as the subflow's inputs, and its templates and
// files written from the repository root (AFD-291). The host reads the files; the command
// (expandRole) puts the subflow in the step's place.

import type { IdFactory } from '../flow/ids';
import type {
  Contract,
  Edge,
  ExpandedFrom,
  FlowDocument,
  FlowNode,
  SubflowBody,
} from '../flow/types';
import { walkNodes } from '../flow/walk';
import { importPlaybook } from './playbook';
import { join, normalize, parseAnsible, type SourceIO } from './read';
import { type ReadOptions, type RoleForm, readPlaybook } from './source';

/** What a host hands the expandRole command: the subflow to put in place and where it came from. */
export interface RoleExpansion {
  source?: Pick<FlowNode, 'subflow' | 'inputs' | 'intent'>;
  expanded?: Omit<ExpandedFrom, 'design' | 'step'>;
  notes: string[];
  error?: string;
}

/** The role folders that shape an expansion; a change to any file in them is a change to the role. */
export const ROLE_PARTS = ['tasks', 'handlers', 'defaults', 'vars'] as const;

/** FNV-1a of the role's files (paths relative to the role folder, sorted). */
export function roleFingerprint(files: { path: string; text: string }[]): string {
  const text = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\n${f.text}`)
    .join('\n\u0000\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const MAX_FILES = 500;

/** The role's YAML files under ROLE_PARTS, read through the host. */
export async function roleFiles(
  io: SourceIO,
  dir: string,
): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  const walk = async (rel: string, depth: number) => {
    if (depth > 6 || out.length >= MAX_FILES) return;
    for (const e of await io.list(join(dir, rel))) {
      const path = `${rel}/${e.name}`;
      if (e.dir) await walk(path, depth + 1);
      else if (/\.ya?ml$/.test(e.name)) {
        const text = await io.read(join(dir, path));
        if (text !== undefined) out.push({ path, text });
      }
    }
  };
  for (const part of ROLE_PARTS) await walk(part, 0);
  return out;
}

const VIRTUAL = '.afd-expand-role.yml';

/** The host's files with one more: the playbook the expansion reads. */
function withFile(io: SourceIO, path: string, text: string): SourceIO {
  return {
    read: (p) => (normalize(p) === path ? Promise.resolve(text) : io.read(p)),
    list: (d) => io.list(d),
    exists: (p) =>
      normalize(p) === path
        ? Promise.resolve(true)
        : io.exists
          ? io.exists(p)
          : io.read(p).then((t) => t !== undefined),
  };
}

/** A YAML file's text under a key of the virtual play, indented; empty when it holds nothing. */
function nested(text: string | undefined, indent: string): string {
  if (!text) return '';
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => !/^(---|\.\.\.)\s*$/.test(l) && !l.startsWith('%'));
  return lines.map((l) => (l.trim() ? indent + l : l)).join('\n');
}

const readText = async (io: SourceIO, base: string) =>
  (await io.read(`${base}.yml`)) ?? (await io.read(`${base}.yaml`));

/**
 * The subflow a role step expands into. `step` is the role step (or an expanded subflow being
 * updated: its `expanded_from.step`); `newId` mints the IDs of the steps (the command copies them
 * again).
 */
export async function expandRoleSource(
  io: SourceIO,
  step: Pick<FlowNode, 'key'> & { impl: FlowNode['impl'] },
  newId: IdFactory,
  opts: ReadOptions = {},
): Promise<RoleExpansion> {
  const impl = step.impl;
  if (impl?.kind !== 'role') return { notes: [], error: 'The step is not bound to a role' };
  const params = impl.params ?? {};
  if (params.tasks_from !== undefined)
    return {
      notes: [],
      error: `The step runs one task file of ${impl.ref} (tasks_from): there is nothing to expand`,
    };
  // Where the role is, as a play at the repository root finds it (roles/, then roles_path).
  const finder = withFile(
    io,
    VIRTUAL,
    `- hosts: all\n  roles:\n    - role: ${JSON.stringify(impl.ref)}\n`,
  );
  const found = await readPlaybook(finder, VIRTUAL, opts);
  const play = found.playbook?.plays[0];
  const form = play?.kind === 'play' ? (play.roles[0] as RoleForm | undefined) : undefined;
  if (!form?.dir)
    return {
      notes: [],
      error: `Role ${impl.ref} is not in the repository (a role of a collection cannot be expanded)`,
    };
  const dir = form.dir;
  const source = roleFingerprint(await roleFiles(io, dir));
  const keywords = impl.keywords ?? {};
  if (form.split) {
    const result = importPlaybook(found.playbook ?? { path: VIRTUAL, plays: [] }, {
      key: step.key,
      newId,
      generatedDir: 'flows/expand/generated',
    });
    const sub = result.doc.nodes.find((n) => n.type === 'subflow' && n.subflow);
    if (!sub?.subflow) return { notes: result.notes, error: `Role ${impl.ref} read as no steps` };
    // What the step passed and its keywords reach every task file, as they reached the role.
    for (const n of walkNodes(sub.subflow.nodes)) {
      if (n.impl?.kind !== 'role') continue;
      n.impl.params = { ...params, ...n.impl.params };
      const kw = mergeKeywords(keywords, n.impl.keywords ?? {});
      if (Object.keys(kw).length) n.impl.keywords = kw;
    }
    clean(sub.subflow);
    return {
      source: { subflow: sub.subflow, intent: `Runs role ${impl.ref}, one step per task file` },
      expanded: { role: impl.ref, dir, mode: 'files', source },
      notes: [],
    };
  }

  // A copy of each task: the role's main, handlers and variables in a play next to its tasks, so
  // includes and files resolve as they do in the role.
  const tasksText = await readText(io, `${dir}/tasks/main`);
  if (tasksText === undefined)
    return { notes: [], error: `Role ${impl.ref} has no tasks/main.yml` };
  const tasks = parseAnsible(tasksText);
  if (tasks.error || !Array.isArray(tasks.value))
    return { notes: [], error: `${dir}/tasks/main.yml is not a list of tasks` };
  const handlersText = await readText(io, `${dir}/handlers/main`);
  const defaultsText = await readText(io, `${dir}/defaults/main`);
  const varsText = await readText(io, `${dir}/vars/main`);
  const passed = Object.entries(params)
    .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join('\n');
  const vars = [
    isMap(defaultsText) ? nested(defaultsText, '    ') : '',
    isMap(varsText) ? nested(varsText, '    ') : '',
    passed,
  ]
    .filter(Boolean)
    .join('\n');
  const handlers = isList(handlersText) ? nested(handlersText, '    ') : '';
  const text = [
    `- name: ${JSON.stringify(impl.ref)}`,
    '  hosts: all',
    '  gather_facts: false',
    ...(vars ? ['  vars:', vars] : []),
    '  tasks:',
    nested(tasksText, '    '),
    ...(handlers ? ['  handlers:', handlers] : []),
    '',
  ].join('\n');
  const path = `${dir}/tasks/${VIRTUAL}`;
  const read = await readPlaybook(withFile(io, path, text), path, opts);
  if (!read.playbook?.plays.length)
    return { notes: read.notes, error: `Role ${impl.ref} could not be read` };
  const result = importPlaybook(
    read.playbook,
    { key: step.key, newId, generatedDir: 'flows/expand/generated' },
    read.notes,
  );
  const body = levelOf(result.doc);
  if (!body.nodes?.length)
    return { notes: result.notes, error: `Role ${impl.ref} has no tasks to copy` };
  // Flow inputs of the copy are the subflow's inputs: steps read them from the subflow.
  // The import's hosts input is the flow's business, not the subflow's.
  const inputs: Contract = Object.fromEntries(
    Object.entries(structuredClone(result.doc.flow.inputs ?? {})).filter(
      ([, f]) => f?.type !== 'host_list',
    ),
  );
  for (const n of walkNodes(body.nodes)) {
    // A template reads the role's variables where the import cannot see them.
    if (n.impl?.kind === 'module' && /(^|\.)(win_)?template$/.test(n.impl.ref))
      for (const [name, f] of Object.entries(inputs))
        if (!n.inputs?.[name])
          n.inputs = { ...n.inputs, [name]: { type: f.type, from: `${step.key}.${name}` } };
    for (const side of ['inputs', 'outputs'] as const)
      for (const f of Object.values(n[side] ?? {}))
        if (f?.from?.startsWith('flow.')) f.from = `${step.key}.${f.from.slice(5)}`;
    if ((n.impl?.kind === 'module' || n.impl?.kind === 'role') && Object.keys(keywords).length) {
      const kw = mergeKeywords(keywords, n.impl.keywords ?? {});
      if (Object.keys(kw).length) n.impl.keywords = kw;
    }
  }
  clean(body);
  const notes = result.notes.filter((n) => !n.includes(VIRTUAL));
  if (varsText && isMap(varsText))
    notes.push(
      `The variables in ${dir}/vars are inputs of the subflow now: inventory and group_vars can set them, which they could not in the role.`,
    );
  return {
    source: {
      subflow: body,
      ...(Object.keys(inputs).length ? { inputs } : {}),
      intent: `A copy of role ${impl.ref}, one step per task`,
    },
    expanded: { role: impl.ref, dir, mode: 'tasks', source },
    notes,
  };
}

const isMap = (text: string | undefined) => {
  if (!text) return false;
  const v = parseAnsible(text).value;
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
};
const isList = (text: string | undefined) => {
  if (!text) return false;
  const v = parseAnsible(text).value;
  return Array.isArray(v) && v.length > 0;
};

/** The step's keywords on top of a task's own: `when`s add up, the task's own win otherwise. */
function mergeKeywords(
  outer: Record<string, unknown>,
  own: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...outer, ...own };
  if (outer.when !== undefined && own.when !== undefined)
    out.when = [
      ...(Array.isArray(outer.when) ? outer.when : [outer.when]),
      ...(Array.isArray(own.when) ? own.when : [own.when]),
    ];
  return out;
}

/** Imported steps carry where they came from (AFD-61); a copy of a role is no import. */
function clean(body: SubflowBody): void {
  for (const n of walkNodes(body.nodes)) delete n.origin;
}

/**
 * The imported play's top level as a subflow's level: start's wire is the entry, wires into the
 * success end leave through ok_hosts, those into the failed end through failed_hosts.
 */
function levelOf(doc: FlowDocument): SubflowBody {
  const ends = new Map(
    doc.nodes.filter((n) => n.type === 'start' || n.type === 'end').map((n) => [n.id, n] as const),
  );
  const nodes = doc.nodes.filter((n) => !ends.has(n.id));
  const edges: Edge[] = [];
  let entry: string | undefined;
  const outputs: Record<string, { node: string; port: string }[]> = {};
  for (const e of doc.edges) {
    const from = ends.get(e.from.node);
    const to = ends.get(e.to.node);
    if (from?.type === 'start') {
      if (!to) entry ??= e.to.node;
      continue;
    }
    if (to?.type === 'end') {
      const port = to.outcome === 'failed' ? 'failed_hosts' : 'ok_hosts';
      outputs[port] = [...(outputs[port] ?? []), { node: e.from.node, port: e.from.port }];
      continue;
    }
    if (!from && !to) edges.push(e);
  }
  const annotations = (doc.annotations ?? []).filter((a) => !a.on || !ends.has(a.on));
  return {
    nodes,
    ...(edges.length ? { edges } : {}),
    ...(annotations.length ? { annotations } : {}),
    ...(entry || Object.keys(outputs).length
      ? {
          boundary: {
            ...(entry ? { in: entry } : {}),
            ...(Object.keys(outputs).length ? { outputs } : {}),
          },
        }
      : {}),
  };
}
