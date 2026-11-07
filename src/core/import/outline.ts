// What an AI assistant reads before it designs a flow from existing automation (AFD-27): a playbook,
// a folder, a role or an AWX export as compact text. Each task carries the exact binding an import
// would write (`impl:`), so an intent-based flow keeps the playbook's modules, parameters and
// keywords. Secrets show by name only. Long outlines come in pages.
import {
  exportTemplates,
  jobTemplateFromExport,
  playbooksOf,
  type WorkflowNodeSource,
  type WorkflowSource,
  workflowFromExport,
} from '../awx/workflow';
import { duration } from '../engine/util';
import { createIdFactory } from '../flow/ids';
import type { ImplBinding, NodeSettings } from '../flow/types';
import { importPlaybook } from './playbook';
import {
  basename,
  dirname,
  exists,
  isMapping,
  join,
  normalize,
  parseAnsible,
  relative,
  type SourceIO,
} from './read';
import { VAULT } from './secrets';
import {
  type Item,
  type PlaybookForm,
  type PlayForm,
  type RoleForm,
  readPlaybook,
  scanFolder,
  type TaskForm,
} from './source';

/** Characters per page: about 6k tokens. */
export const OUTLINE_PAGE = 24_000;
const LONG = 240;

export interface OutlineRequest {
  path: string;
  /** `#7`: one task in full. */
  focus?: string;
  /** The flow the design goes to (flows/<key>/<key>.flow.yaml): file paths are rewritten for it. */
  flow?: string;
  page?: number;
  resolveModule?(name: string, collections: string[]): string | undefined;
}

/** The generated folder of a flow file: flows/x/x.flow.yaml → flows/x/generated. */
export function generatedDirOf(flow: string | undefined, fallbackKey = 'imported'): string {
  if (!flow) return `flows/${fallbackKey}/generated`;
  return join(dirname(normalize(flow)), 'generated');
}

/** A secret-free copy for display: vault values become a marker naming the variable. */
function shown(value: unknown, name = 'value'): unknown {
  if (value === VAULT) return `<secret ${name}>`;
  if (Array.isArray(value)) return value.map((v) => shown(v, name));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shown(v, k)]));
  return value;
}

/** The binding and settings an as-is import writes for a task (paths rewritten for `generated`). */
export function taskBinding(
  t: TaskForm,
  generated: string,
): { impl: ImplBinding; settings?: NodeSettings } {
  const params: Record<string, unknown> = { ...t.params };
  for (const f of t.files)
    if (f.path) {
      const local = `{{ playbook_dir }}/${relative(generated, f.path)}`;
      params[f.param] =
        f.param === 'cmd' && typeof params.cmd === 'string'
          ? params.cmd.replace(f.written, local)
          : local;
    }
  const impl: ImplBinding = {
    kind: 'module',
    ref: t.fqcn ?? t.module,
    ...(Object.keys(params).length ? { params: shown(params) as Record<string, unknown> } : {}),
    ...(t.register ? { register: t.register } : {}),
    ...(Object.keys(t.keywords).length
      ? { keywords: shown(t.keywords) as Record<string, unknown> }
      : {}),
  };
  const settings: NodeSettings = {};
  if (t.become) settings.become = true;
  if (t.tags.length) settings.tags = [...new Set(t.tags)];
  if (t.timeout) settings.timeout = typeof t.timeout === 'number' ? duration(t.timeout) : t.timeout;
  if (t.retries !== undefined) settings.retries = t.retries;
  if (t.delay !== undefined) settings.delay = t.delay;
  if (t.until) settings.until = t.until;
  return { impl, ...(Object.keys(settings).length ? { settings } : {}) };
}

function roleBinding(r: RoleForm): ImplBinding {
  return {
    kind: 'role',
    ref: r.ref,
    ...(Object.keys(r.params).length ? { params: shown(r.params) as Record<string, unknown> } : {}),
    ...(Object.keys(r.keywords).length
      ? { keywords: shown(r.keywords) as Record<string, unknown> }
      : {}),
  };
}

/** JSON on one line, long strings cut (focus shows them whole). */
function compact(value: unknown, n: number): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === 'string' && v.length > LONG
      ? `${v.slice(0, LONG)}…(+${v.length - LONG} chars; focus #${n})`
      : v,
  );
}

const short = (v: unknown, max = 60): string => {
  const s = (typeof v === 'string' ? v : JSON.stringify(shown(v))) ?? '';
  const one = s.replaceAll(/\s+/g, ' ');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

interface Ctx {
  generated: string;
  lines: string[];
  tasks: Map<number, { form: TaskForm | RoleForm; play: string }>;
  n: number;
  play: string;
}

function itemLines(items: Item[], ctx: Ctx, indent: string): void {
  for (const item of items) {
    switch (item.kind) {
      case 'task': {
        const n = ++ctx.n;
        ctx.tasks.set(n, { form: item, play: ctx.play });
        const kw = Object.keys(item.keywords);
        const parts = [
          `#${n} ${item.name || '(no name)'}`,
          item.fqcn ?? `${item.module} (not fully qualified)`,
          item.register ? `register ${item.register}` : '',
          ...kw.map((k) => (k === 'when' || k === 'loop' ? `${k} ${short(item.keywords[k])}` : k)),
          item.notify.length ? `notify ${item.notify.join(', ')}` : '',
          item.listen.length ? `listen ${item.listen.join(', ')}` : '',
          item.tags.length ? `tags ${item.tags.join(',')}` : '',
          item.become ? 'become' : '',
          item.dropped.length ? `no flow form: ${item.dropped.join(', ')}` : '',
        ].filter(Boolean);
        ctx.lines.push(`${indent}${parts.join(' · ')}`);
        const { impl, settings } = taskBinding(item, ctx.generated);
        ctx.lines.push(
          `${indent}   impl: ${compact(impl, n)}${settings ? ` settings: ${compact(settings, n)}` : ''}`,
        );
        break;
      }
      case 'block':
        ctx.lines.push(
          `${indent}block "${item.name || 'Block'}"${item.rescue.length ? ' with rescue' : ''}${item.always.length ? ' and always' : ''}`,
        );
        itemLines(item.items, ctx, `${indent}  `);
        if (item.rescue.length) {
          ctx.lines.push(
            `${indent}rescue (runs for hosts that failed in the block: wire the block's failed_hosts here):`,
          );
          itemLines(item.rescue, ctx, `${indent}  `);
        }
        if (item.always.length) {
          ctx.lines.push(`${indent}always (runs for every host after the block and rescue):`);
          itemLines(item.always, ctx, `${indent}  `);
        }
        break;
      case 'include':
        if (item.items) {
          ctx.lines.push(
            `${indent}include ${item.file} (${item.path})${item.name ? ` "${item.name}"` : ''}`,
          );
          itemLines(item.items, ctx, `${indent}  `);
        } else ctx.lines.push(`${indent}include ${item.file}: not read in, ${item.dynamic}`);
        break;
      case 'role': {
        const n = ++ctx.n;
        ctx.tasks.set(n, { form: item, play: ctx.play });
        const parts = [
          `#${n} role ${item.ref}${item.name !== item.ref ? ` "${item.name}"` : ''}`,
          item.dir ? `in ${item.dir}` : 'not in the repository',
          item.dir && !item.onRolesPath ? 'not on roles_path' : '',
          item.split
            ? `split: ${item.split.map((s) => s.tasksFrom).join(', ')} (one tasks_from step each)`
            : '',
          item.outputs.length ? `sets ${item.outputs.join(', ')}` : '',
          ...Object.keys(item.keywords).map((k) =>
            k === 'when' ? `when ${short(item.keywords.when)}` : k,
          ),
          item.tags.length ? `tags ${item.tags.join(',')}` : '',
          item.become ? 'become' : '',
        ].filter(Boolean);
        ctx.lines.push(`${indent}${parts.join(' · ')}`);
        ctx.lines.push(`${indent}   impl: ${compact(roleBinding(item), n)}`);
        // A split role becomes a subflow bound to the role, one step per task file.
        for (const s of item.split ?? [])
          ctx.lines.push(
            `${indent}   step "${s.name}" impl: ${compact({ ...roleBinding(item), params: { ...roleBinding(item).params, tasks_from: s.tasksFrom } }, n)}`,
          );
        break;
      }
      case 'meta':
        ctx.lines.push(
          `${indent}meta ${item.action}${item.action === 'flush_handlers' ? ' (handlers run here)' : ''}`,
        );
        break;
    }
  }
}

function playLines(p: PlayForm, ctx: Ctx, indent: string): void {
  ctx.play = p.name;
  const head = [
    `Play "${p.name || '(no name)'}"`,
    `hosts ${p.hosts}`,
    `gather_facts ${p.gatherFacts}`,
    p.become ? 'become' : '',
    p.serial !== undefined ? `serial ${p.serial}` : '',
    p.anyErrorsFatal ? 'any_errors_fatal' : '',
    p.maxFailPercentage !== undefined ? `max_fail_percentage ${p.maxFailPercentage}` : '',
    p.collections.length ? `collections ${p.collections.join(',')}` : '',
    p.dropped.length ? `no flow form: ${p.dropped.join(', ')}` : '',
  ].filter(Boolean);
  ctx.lines.push(`${indent}${head.join(' · ')}`);
  const vars = Object.entries(p.vars).map(([k, v]) => `${k}=${short(shown(v, k), 40)}`);
  if (vars.length) ctx.lines.push(`${indent}  vars: ${vars.join(', ')}`);
  for (const f of p.varsFiles) {
    ctx.lines.push(
      `${indent}  vars_files ${f.file}${f.path ? ` (${f.path}: ${f.keys.join(', ') || 'no keys'})` : ': not found'}`,
    );
    // As a step at the play's start; its keys are the step's outputs.
    if (f.path)
      ctx.lines.push(
        `${indent}     step impl: ${JSON.stringify({ kind: 'module', ref: 'ansible.builtin.include_vars', params: { file: `{{ playbook_dir }}/${relative(ctx.generated, f.path)}` } })}`,
      );
  }
  if (p.gatherFacts)
    ctx.lines.push(
      `${indent}  gathers facts first: step impl: ${JSON.stringify({ kind: 'module', ref: 'ansible.builtin.gather_facts', ...(Object.keys(p.gatherParams).length ? { params: p.gatherParams } : {}) })}`,
    );
  if (p.varsPrompt.length)
    ctx.lines.push(
      `${indent}  prompts: ${p.varsPrompt.map((q) => `${q.name}${q.private ? ' (secret)' : ''}`).join(', ')}`,
    );
  const section = (title: string, items: Item[]) => {
    if (!items.length) return;
    ctx.lines.push(`${indent}  ${title}:`);
    itemLines(items, ctx, `${indent}    `);
  };
  section('pre_tasks', p.preTasks);
  section('roles', p.roles);
  section('tasks', p.tasks);
  section('post_tasks', p.postTasks);
  section(
    'handlers (run once at the end of each section when notified; as a step: give the notifier a register and the handler keywords.when "(<register> | default({})) is changed")',
    p.handlers,
  );
}

function bookLines(book: PlaybookForm, ctx: Ctx, indent: string): void {
  for (const entry of book.plays) {
    if (entry.kind === 'play') playLines(entry, ctx, indent);
    else if (entry.playbook) {
      ctx.lines.push(`${indent}import_playbook ${entry.file} (${entry.playbook.path})`);
      bookLines(entry.playbook, ctx, `${indent}  `);
    } else ctx.lines.push(`${indent}import_playbook ${entry.file}: not read, ${entry.missing}`);
  }
}

function paged(lines: string[], page: number, more: string): string {
  const pages: string[][] = [[]];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > OUTLINE_PAGE && (pages.at(-1)?.length ?? 0) > 0) {
      pages.push([]);
      size = 0;
    }
    pages.at(-1)?.push(line);
    size += line.length + 1;
  }
  const i = Math.min(Math.max(page, 1), pages.length) - 1;
  const text = (pages[i] ?? []).join('\n');
  if (pages.length === 1) return text;
  return `${text}\n\n(page ${i + 1} of ${pages.length}${i + 1 < pages.length ? `: call again with page ${i + 2}${more}` : ''})`;
}

async function playbookOutline(io: SourceIO, req: OutlineRequest): Promise<string> {
  const read = await readPlaybook(
    io,
    req.path,
    req.resolveModule ? { resolveModule: req.resolveModule } : {},
  );
  if (!read.playbook) return read.notes.join('\n') || `${req.path} is not a playbook.`;
  const generated = generatedDirOf(req.flow, basename(req.path).replace(/\.ya?ml$/, ''));
  const ctx: Ctx = { generated, lines: [], tasks: new Map(), n: 0, play: '' };
  bookLines(read.playbook, ctx, '');
  const focus = /^#?(\d+)$/.exec(req.focus?.trim() ?? '');
  if (focus) {
    const hit = ctx.tasks.get(Number(focus[1]));
    if (!hit) return `No task #${focus[1]}: the playbook has ${ctx.n}.`;
    const f = hit.form;
    const binding = f.kind === 'task' ? taskBinding(f, generated) : { impl: roleBinding(f) };
    return [
      `#${focus[1]} ${f.name || '(no name)'} · play "${hit.play}" · ${f.origin.path}:${f.origin.line ?? '?'}`,
      `impl: ${JSON.stringify(binding.impl, null, 2)}`,
      ...('settings' in binding && binding.settings
        ? [`settings: ${JSON.stringify(binding.settings)}`]
        : []),
      ...(f.kind === 'task' && f.notify.length ? [`notify: ${f.notify.join(', ')}`] : []),
      ...(f.kind === 'role' && f.split
        ? [
            `split role, steps: ${f.split.map((s) => `${s.name} (tasks_from ${s.tasksFrom})`).join(', ')}`,
          ]
        : []),
    ].join('\n');
  }
  const asIs = importPlaybook(read.playbook, {
    key: 'outline',
    newId: createIdFactory(),
    generatedDir: generated,
  });
  const header = [
    `Playbook ${read.playbook.path}: ${ctx.n} task(s) and role(s). Files read: ${read.files.length}.`,
    `Paths in impl are written for ${generated} (the flow ${req.flow ?? `flows/<key>/<key>.flow.yaml`}).`,
    'Each #n line is a task; its impl is the binding to copy into add_node (impl) or bind. focus "#n" shows one in full.',
    '',
  ];
  const tail = [
    '',
    `An as-is import (flow_import) would make ${asIs.counts.steps} step(s); it notes:`,
    ...(asIs.notes.length ? asIs.notes.map((n) => `- ${n}`) : ['- nothing']),
  ];
  return paged([...header, ...ctx.lines, ...tail], req.page ?? 1, '');
}

async function folderOutline(io: SourceIO, req: OutlineRequest): Promise<string> {
  const dir = normalize(req.path);
  const scan = await scanFolder(io, dir);
  const lines = [
    `Folder ${dir || '.'}: ${scan.playbooks.length} playbook(s), ${scan.roles.length} role(s).`,
  ];
  if (!scan.playbooks.length) lines.push('No playbooks here.');
  for (const p of scan.playbooks)
    lines.push(
      `- ${p.path} · "${p.title}"${p.entry ? ' · top level' : ` · imported by ${p.importedBy}`}`,
    );
  if (scan.roles.length) lines.push('', 'Roles:');
  for (const r of scan.roles)
    lines.push(`- ${r.name} (${r.dir})${r.split ? ' · split into task files' : ''}`);
  const cfg = await io.read('ansible.cfg');
  if (cfg !== undefined)
    lines.push(
      '',
      'ansible.cfg is at the repository root (roles_path and gathering are honoured).',
    );
  if (scan.truncated) lines.push('', 'The folder has more files than were scanned (2000).');
  lines.push(
    '',
    'Next: source_outline with the path of a top-level playbook for its plays and tasks.',
  );
  return lines.join('\n');
}

async function roleOutline(io: SourceIO, dir: string): Promise<string> {
  const lines = [`Role ${basename(dir)} (${dir})`];
  const tasks = (await io.list(join(dir, 'tasks'))).filter(
    (e) => !e.dir && /\.ya?ml$/.test(e.name),
  );
  for (const f of tasks) {
    const { value } = parseAnsible((await io.read(join(dir, 'tasks', f.name))) ?? '');
    const names = Array.isArray(value)
      ? value.filter(isMapping).map((t) => String(t.name ?? '(no name)'))
      : [];
    lines.push(`- tasks/${f.name}: ${names.join('; ') || 'no tasks'}`);
  }
  const defaults = parseAnsible((await io.read(join(dir, 'defaults/main.yml'))) ?? '').value;
  if (isMapping(defaults)) lines.push(`defaults: ${Object.keys(defaults).join(', ')}`);
  const specs = parseAnsible((await io.read(join(dir, 'meta/argument_specs.yml'))) ?? '').value;
  const entry =
    isMapping(specs) && isMapping(specs.argument_specs) ? specs.argument_specs : undefined;
  if (entry)
    for (const [name, spec] of Object.entries(entry))
      if (isMapping(spec) && isMapping(spec.options))
        lines.push(`argument_specs ${name}: ${Object.keys(spec.options).join(', ')}`);
  lines.push(
    '',
    'Bind the role as a unit (impl kind role); a role split into task files can be a subflow with one tasks_from step per file.',
  );
  return lines.join('\n');
}

function nodeLine(n: WorkflowNodeSource, present: Set<string>): string {
  const edges = [
    n.success.length ? `success → ${n.success.join(', ')}` : '',
    n.failure.length ? `failure → ${n.failure.join(', ')}` : '',
    n.always.length ? `always → ${n.always.join(', ')}` : '',
  ].filter(Boolean);
  const what =
    n.kind === 'job'
      ? `job template "${n.name}" · playbook ${n.job?.playbook ?? '?'}${n.job?.playbook ? (present.has(n.job.playbook) ? ' (in this repository)' : ` (not here: project ${n.job?.project ?? '?'}${n.job?.scmUrl ? `, ${n.job.scmUrl}` : ''})`) : ''}`
      : n.kind === 'approval'
        ? `approval "${n.name}"${n.timeout ? ` · timeout ${n.timeout}s` : ''}`
        : `${n.kind} "${n.name}"`;
  return [
    `${n.identifier}: ${what}`,
    n.converge ? 'converge all' : '',
    n.limit ? `limit ${n.limit}` : '',
    n.extraData ? `extra_data ${Object.keys(n.extraData).join(', ')}` : '',
    ...edges,
  ]
    .filter(Boolean)
    .join(' · ');
}

async function awxOutline(io: SourceIO, req: OutlineRequest): Promise<string> {
  let data: unknown;
  try {
    data = JSON.parse((await io.read(req.path)) ?? '');
  } catch {
    return `${req.path} is not JSON.`;
  }
  const names = exportTemplates(data);
  if (typeof names === 'string') return `${req.path}: ${names}`;
  const lines: string[] = [`AWX export ${req.path}`];
  const describe = async (src: WorkflowSource, kind: string, indent = '') => {
    const present = new Set<string>();
    for (const ref of playbooksOf(src))
      if (await exists(io, ref.replace(/^\.?\//, ''))) present.add(ref);
    lines.push(`${indent}${kind} "${src.name}"${src.description ? `: ${src.description}` : ''}`);
    if (src.limit) lines.push(`${indent}  limit ${src.limit}`);
    if (src.survey?.length)
      lines.push(
        `${indent}  survey: ${src.survey.map((q) => `${q.variable} (${q.type}${q.type === 'password' ? ', secret' : ''})`).join(', ')}`,
      );
    if (src.extraVars)
      lines.push(`${indent}  extra vars: ${Object.keys(src.extraVars).join(', ')}`);
    for (const n of src.nodes) {
      lines.push(`${indent}  ${nodeLine(n, present)}`);
      if (n.workflow) await describe(n.workflow, 'nested workflow', `${indent}    `);
    }
    const local = [...present];
    if (local.length)
      lines.push(
        `${indent}  playbooks in this repository (source_outline them for their tasks): ${local.join(', ')}`,
      );
  };
  for (const w of names.workflows)
    await describe(workflowFromExport(data as never, w), 'Workflow template');
  for (const j of names.jobs)
    await describe(jobTemplateFromExport(data as never, j), 'Job template');
  lines.push(
    '',
    'AWX success, failure and always edges are per job; flow ports are per host (success → ok_hosts, failure → failed_hosts, always → both). Secrets are shown by name only.',
  );
  return paged(lines, req.page ?? 1, '');
}

/** The outline of whatever `path` is: an AWX export, a role, a folder or a playbook. */
export async function sourceOutline(io: SourceIO, req: OutlineRequest): Promise<string> {
  const path = normalize(req.path);
  if (path.endsWith('.json')) return awxOutline(io, { ...req, path });
  if (/\.ya?ml$/.test(path)) {
    if ((await io.read(path)) === undefined)
      return `${path} was not found (or is not readable here).`;
    return playbookOutline(io, { ...req, path });
  }
  if (await exists(io, join(path, 'tasks/main.yml'))) return roleOutline(io, path);
  return folderOutline(io, { ...req, path });
}
