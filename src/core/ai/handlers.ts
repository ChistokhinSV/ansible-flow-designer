// The AI tools themselves (AFD-19), independent of who calls them: Copilot through the extension
// host, Claude Code, Codex and Gemini through the MCP server. Each adapter supplies a FlowIO (how
// files are found, read and written there); every answer is plain text by key, never with IDs.
import { importWorkflow } from '../awx/import';
import {
  type AwxExport,
  exportTemplates,
  jobTemplateFromExport,
  playbooksOf,
  workflowFromExport,
} from '../awx/workflow';
import { checksum } from '../engine/util';
import { toDrawio } from '../export/drawio';
import { type ExportSource, levelSuffix, scenesOf } from '../export/scene';
import { sceneSvg } from '../export/svg';
import { completeIds } from '../flow/completeIds';
import { parseFlow } from '../flow/document';
import { SLUG, slugify } from '../flow/ids';
import { type FlowModel, ROOT } from '../flow/model';
import { openFailPorts } from '../flow/openPorts';
import type { SchemaValidator } from '../flow/schema';
import { newFlowText } from '../flow/template';
import { flowText } from '../flow/text';
import { type Finding, validateFlow } from '../flow/validate';
import { generatedDirOf, sourceOutline } from '../import/outline';
import { importPlaybook } from '../import/playbook';
import type { SourceIO } from '../import/read';
import type { ImportResult } from '../import/result';
import { type PlaybookForm, readPlaybook } from '../import/source';
import { diffEdits } from '../yaml/edits';
import { countFindings, describeFlow, formatFindings } from './describe';
import { applyOps, type Op, OpError, type OpsContext } from './ops';
import { type ReferenceTopic, reference } from './reference';
import { keyPath, RefError, resolveNode, withoutIds } from './refs';
import { checkOps, dropNulls } from './specs';

export interface FlowIO {
  /** Flow files the tools may see, as the paths tools take. */
  list(): Promise<string[]>;
  /** The flow a call without path means: the one open in the designer, if any. */
  current?(): string | undefined;
  /** Throws an Error with a message for the model when the path is not an allowed flow. */
  read(path: string): Promise<string>;
  /** Writes the new text of a flow; returns its final text (e.g. version bumped) and notes. */
  write(path: string, before: string, after: string): Promise<{ text: string; notes: string[] }>;
  /** Creates a new flow file; throws when it exists or is not allowed. */
  create(path: string, text: string): Promise<{ text: string; notes: string[] }>;
  /** How ops run for a flow: IDs, the author of decisions, the layout for tidy_up. */
  ops(path: string): OpsContext;
  schema: SchemaValidator;
  /**
   * AFD-25: writes an export (.drawio or .svg) inside the roots, creating folders; returns its path
   * as the tools show it. Throws for anything else.
   */
  writeExport?(path: string, text: string): Promise<string>;
  /**
   * AFD-27: Ansible files inside the roots (playbooks, task files, roles, ansible.cfg, AWX export
   * JSON), read-only: the reader of the root that holds `path`, the path within it, and the prefix
   * tools show for that root (its name when there are several, else ''). Absent where the host
   * cannot read them.
   */
  source?(path: string): { io: SourceIO; path: string; prefix: string } | undefined;
  /** Short module name + the play's collections → FQCN, where a catalog is loaded. */
  resolveModule?(name: string, collections: string[]): string | undefined;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

const fail = (text: string): ToolResult => ({ text, isError: true });

/** A short fingerprint of the file text: flow_edit refuses when the file changed since. */
export function revisionOf(text: string): string {
  return checksum(text).slice(-10);
}

interface Loaded {
  path: string;
  text: string;
  model: FlowModel;
  findings: Finding[];
}

async function pathOf(io: FlowIO, path: unknown): Promise<string> {
  if (typeof path === 'string' && path.trim()) return path.trim();
  const current = io.current?.();
  if (current) return current;
  const all = await io.list();
  if (all.length === 1) return all[0] as string;
  throw new Error(
    all.length === 0
      ? 'No flow files (*.flow.yaml) here; create one with flow_new'
      : `Name the flow with path: ${all.slice(0, 20).join(', ')}${all.length > 20 ? ', …' : ''}`,
  );
}

function check(text: string, schema: SchemaValidator): Omit<Loaded, 'path' | 'text'> | string {
  const parsed = parseFlow(text);
  if (!parsed.doc) {
    const e = parsed.errors[0];
    const line = e ? text.slice(0, e.offset).split('\n').length : 1;
    return `The file does not parse as YAML (line ${line}: ${e?.message ?? 'unknown error'}). Fix the YAML first.`;
  }
  const { model, findings } = validateFlow(parsed.doc, schema(parsed.doc));
  return { model, findings };
}

async function load(io: FlowIO, rawPath: unknown): Promise<Loaded | ToolResult> {
  let path: string;
  let text: string;
  try {
    path = await pathOf(io, rawPath);
    text = await io.read(path);
  } catch (e) {
    return fail((e as Error).message);
  }
  const checked = check(text, io.schema);
  if (typeof checked === 'string') return fail(`${path}: ${checked}`);
  return { path, text, ...checked };
}

const isResult = (x: Loaded | ToolResult): x is ToolResult => !('model' in x);

export async function flowList(io: FlowIO): Promise<ToolResult> {
  const paths = await io.list();
  if (paths.length === 0) return { text: 'No flow files (*.flow.yaml). Create one with flow_new.' };
  const lines: string[] = [];
  for (const path of paths.slice(0, 100)) {
    try {
      const checked = check(await io.read(path), io.schema);
      if (typeof checked === 'string') {
        lines.push(`- ${path}: does not parse`);
        continue;
      }
      const f = checked.model.doc.flow;
      lines.push(
        `- ${path}: "${f?.name}" (key ${f?.key}, version ${f?.version}); ${countFindings(checked.findings)}`,
      );
    } catch (e) {
      lines.push(`- ${path}: ${(e as Error).message}`);
    }
  }
  if (paths.length > 100) lines.push(`- … ${paths.length - 100} more`);
  return { text: lines.join('\n') };
}

export async function flowDescribe(
  io: FlowIO,
  input: { path?: string; level?: string; layout?: boolean },
): Promise<ToolResult> {
  const l = await load(io, input.path);
  if (isResult(l)) return l;
  let level: string | undefined;
  if (input.level && input.level !== 'all') {
    if (input.level === 'top') level = ROOT;
    else {
      try {
        const sub = resolveNode(l.model, input.level);
        if (sub.node.type !== 'subflow')
          return fail(
            `${sub.path} is a ${sub.node.type}, not a subflow; level is all, top or a subflow`,
          );
        level = sub.id;
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  }
  // AFD-24: where the canvas shows each node, when asked.
  const shown = input.layout ? await io.ops(l.path).positions?.(l.model) : undefined;
  return {
    text: `${l.path}\n${describeFlow(l.model, l.findings, revisionOf(l.text), level, shown)}`,
  };
}

export async function flowValidate(io: FlowIO, input: { path?: string }): Promise<ToolResult> {
  const l = await load(io, input.path);
  if (isResult(l)) return l;
  const gaps = l.findings.some((f) => f.code === 'missing-id');
  return {
    text: [
      `${l.path}: ${countFindings(l.findings)}`,
      formatFindings(l.model, l.findings),
      ...(gaps ? ['', 'The file was written by hand: run flow_complete_ids first.'] : []),
      `Revision: ${revisionOf(l.text)}`,
    ].join('\n'),
  };
}

export function flowReference(input: { topic?: ReferenceTopic }): ToolResult {
  const topics = ['all', 'format', 'ports', 'patterns', 'ops', 'problems'];
  const topic = input.topic ?? 'all';
  if (!topics.includes(topic)) return fail(`topic is one of ${topics.join(', ')}`);
  return { text: reference(topic) };
}

/**
 * Problems keyed by what they are about (code, node by key, port, field), so an edit that renames
 * a node or adds IDs does not make old problems look new.
 */
/**
 * Findings by what they are about, so an edit can tell which are new and which went away. The
 * message is part of it (one node can have several findings of one code, AFD-21), with the node's
 * title taken out, so retitling a node is not a new problem. Several equal findings count each.
 */
function problemKeys(model: FlowModel, findings: Finding[]): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const f of findings) {
    const node = f.node ? model.nodes.get(f.node)?.node : undefined;
    const edge = f.edge ? model.edges.get(f.edge)?.edge : undefined;
    let message = withoutIds(model, f.message);
    if (node?.title) message = message.replaceAll(`"${node.title}"`, '"<node>"');
    const key = [
      f.code,
      f.node ? keyPath(model, f.node) : '',
      f.port ?? '',
      edge ? `${keyPath(model, edge.from.node)}.${edge.from.port}` : '',
      f.path.filter((p) => typeof p === 'string').join('.'),
      message,
    ].join('|');
    out.set(key, [...(out.get(key) ?? []), f]);
  }
  return out;
}

/** "11 warning(s), 2 info" for the findings that went away. */
function solvedText(solved: Finding[]): string {
  if (solved.length === 0) return '';
  const n = (s: Finding['severity']) => solved.filter((f) => f.severity === s).length;
  const parts = [
    n('error') ? `${n('error')} error(s)` : '',
    n('warning') ? `${n('warning')} warning(s)` : '',
    n('info') ? `${n('info')} info` : '',
  ].filter(Boolean);
  return `; solved by this edit: ${parts.join(', ')}`;
}

/** Changed lines, whole, for a dry run. */
function changedLines(before: string, after: string, max = 60): string {
  const out: string[] = [];
  let delta = 0;
  for (const e of [...diffEdits(before, after)].sort((a, b) => a.start - b.start)) {
    const from = before.lastIndexOf('\n', e.start - 1) + 1;
    const end = before.indexOf('\n', e.end);
    const to = end < 0 ? before.length : end;
    const grow = e.newText.length - (e.end - e.start);
    const lines = (t: string, sign: string) =>
      t.length
        ? t
            .replaceAll('\r', '')
            .split('\n')
            .map((l) => `${sign} ${l}`)
        : [];
    out.push(
      `@@ line ${before.slice(0, from).split('\n').length}`,
      ...lines(before.slice(from, to), '-'),
      ...lines(after.slice(from + delta, to + delta + grow), '+'),
    );
    delta += grow;
  }
  if (out.length > max)
    return [...out.slice(0, max), `… ${out.length - max} more line(s)`].join('\n');
  return out.join('\n');
}

export async function flowEdit(
  io: FlowIO,
  input: { path?: string; ops?: unknown; revision?: string; dry_run?: boolean },
): Promise<ToolResult> {
  const given = dropNulls(input.ops);
  const problems = checkOps(given);
  if (problems.length > 0)
    return fail(
      `${problems.join('\n')}\nNothing was written. flow_reference topic ops lists the ops.`,
    );
  const l = await load(io, input.path);
  if (isResult(l)) return l;
  const now = revisionOf(l.text);
  if (input.revision && input.revision !== now)
    return fail(
      `The flow changed since revision ${input.revision}; nothing was written. The flow now:\n${describeFlow(l.model, l.findings, now)}`,
    );
  const ops = given as Op[];
  let result: Awaited<ReturnType<typeof applyOps>>;
  try {
    result = await applyOps(l.text, ops, io.ops(l.path));
  } catch (e) {
    if (e instanceof OpError || e instanceof RefError)
      return fail(`${e.message}\nflow_describe shows the keys and ports.`);
    throw e;
  }
  if (result.text === l.text) return { text: `Nothing changed. Revision: ${now}` };

  const before = problemKeys(l.model, l.findings);
  const report = (text: string, model: FlowModel, findings: Finding[], notes: string[]) => {
    const after = problemKeys(model, findings);
    const added = [...after.entries()].flatMap(([k, fs]) => fs.slice(before.get(k)?.length ?? 0));
    const solved = [...before.entries()].flatMap(([k, fs]) => fs.slice(after.get(k)?.length ?? 0));
    return [
      ...(result.created.length ? [`Created: ${result.created.join(', ')}`] : []),
      ...(result.dropped.length
        ? [`Back to implemented (design changed after a passing run): ${result.dropped.join(', ')}`]
        : []),
      ...result.notes,
      ...notes,
      `Problems: ${countFindings(findings)}${solvedText(solved)}`,
      ...(added.length ? ['New problems:', formatFindings(model, added, 30)] : []),
      `Revision: ${revisionOf(text)}`,
    ].join('\n');
  };

  if (input.dry_run) {
    const checked = check(result.text, io.schema);
    if (typeof checked === 'string') return fail(checked);
    return {
      text: [
        `Dry run of ${ops.length} op(s) on ${l.path}: nothing was written.`,
        report(result.text, checked.model, checked.findings, []).replace(/\nRevision: .*$/, ''),
        'Changes:',
        changedLines(l.text, result.text),
      ].join('\n'),
    };
  }
  let written: { text: string; notes: string[] };
  try {
    written = await io.write(l.path, l.text, result.text);
  } catch (e) {
    return fail(`Not written: ${(e as Error).message}`);
  }
  const checked = check(written.text, io.schema);
  if (typeof checked === 'string') return fail(checked);
  return {
    text: [
      `Applied ${ops.length} op(s) to ${l.path}.`,
      report(written.text, checked.model, checked.findings, written.notes),
    ].join('\n'),
  };
}

export async function flowNew(
  io: FlowIO,
  input: { path?: string; name?: string; key?: string; goal?: string },
): Promise<ToolResult> {
  const path = input.path?.trim() ?? '';
  if (!path.endsWith('.flow.yaml')) return fail('path must end with .flow.yaml');
  if (!input.name?.trim()) return fail('name is required');
  // The file is <key>.flow.yaml by convention: a file name that is a key names the flow.
  const base =
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.flow\.yaml$/, '') ?? '';
  const key = input.key ?? (SLUG.test(base) ? base : slugify(input.name, 'flow'));
  if (!SLUG.test(key)) return fail(`Key "${key}" must be lowercase letters, digits and dashes`);
  let text = newFlowText(input.name.trim(), key, io.ops(path).newId);
  if (input.goal)
    text = (await applyOps(text, [{ op: 'update_flow', goal: input.goal }], io.ops(path))).text;
  let created: { text: string; notes: string[] };
  try {
    created = await io.create(path, text);
  } catch (e) {
    return fail((e as Error).message);
  }
  const checked = check(created.text, io.schema);
  if (typeof checked === 'string') return fail(checked);
  return {
    text: [
      `Created ${path}.`,
      ...created.notes,
      describeFlow(checked.model, checked.findings, revisionOf(created.text)),
      'Next: add steps with flow_edit. add_node with after: "start.ok_hosts" puts the first step between start and done; after: "<that step>.ok_hosts" the next one, and so on.',
    ].join('\n'),
  };
}

export async function flowCompleteIds(io: FlowIO, input: { path?: string }): Promise<ToolResult> {
  const l = await load(io, input.path);
  if (isResult(l)) return l;
  const done = completeIds(l.text, io.ops(l.path).newId);
  const unresolved = done.unresolved.map((g) => `- ${g.message}`);
  if (done.text === l.text)
    return {
      text: unresolved.length
        ? `No IDs to add, but these keys name no node (fix them, then run again):\n${unresolved.join('\n')}`
        : `Nothing to complete: every item has its ID. Revision: ${revisionOf(l.text)}`,
    };
  let written: { text: string; notes: string[] };
  try {
    written = await io.write(l.path, l.text, done.text);
  } catch (e) {
    return fail(`Not written: ${(e as Error).message}`);
  }
  const f = done.filled;
  return {
    text: [
      `Completed IDs in ${l.path}: ${f.nodes} node(s), ${f.wires} wire(s), ${f.refs} reference(s) by key.`,
      ...written.notes,
      ...(unresolved.length
        ? ['These keys name no node (fix them, then run again):', ...unresolved]
        : []),
      `Revision: ${revisionOf(written.text)}`,
    ].join('\n'),
  };
}

/**
 * AFD-25: the flow as a draw.io file (a page per level) or SVG images of its levels, which embed
 * the draw.io file. Positions are what the canvas shows; PNG needs the designer, so not here.
 */
export async function flowExport(
  io: FlowIO,
  input: { path?: string; format?: string; level?: string; out?: string },
): Promise<ToolResult> {
  const format = input.format ?? 'drawio';
  if (format !== 'drawio' && format !== 'svg')
    return fail(
      'format is drawio or svg. For PNG, the user runs Export as Image in VS Code: the designer draws the text.',
    );
  const l = await load(io, input.path);
  if (isResult(l)) return l;
  if (l.findings.some((f) => f.code === 'missing-id' || f.code === 'unknown-key'))
    return fail(`${l.path} lacks IDs; run flow_complete_ids first`);
  const positions = io.ops(l.path).positions;
  if (!io.writeExport || !positions) return fail('Exports cannot be written here');
  const shown = await positions(l.model);
  const src: ExportSource = {
    doc: { ...l.model.doc, layout: shown.stored },
    shown,
    findings: l.findings,
    openPorts: openFailPorts(l.model),
  };
  const dir = l.path.includes('/') ? l.path.slice(0, l.path.lastIndexOf('/') + 1) : '';
  const key = l.model.doc.flow.key;
  const all = scenesOf(src);
  try {
    if (format === 'drawio') {
      const out = input.out ?? `${dir}${key}.drawio`;
      if (!out.endsWith('.drawio')) return fail('out must end in .drawio');
      const written = await io.writeExport(out, toDrawio(src));
      const subs = all.length - 1;
      return {
        text: [
          `Wrote ${written}: ${all.length} page(s), the top level${subs ? ` and ${subs} subflow(s), each linked from its subflow node` : ''}.`,
          'Nodes, ports and wires look as on the canvas. Each node carries its key, type, status, intent, binding, inputs, outputs, settings, open ports and problems as draw.io shape data (Edit Data, Ctrl+M; hover shows a summary).',
          'It opens in draw.io (desktop or app.diagrams.net) and in the Draw.io VS Code extension. The flow file stays the source: export again after changes.',
        ].join('\n'),
      };
    }
    let scenes = all.filter((s) => s.level === ROOT);
    if (input.level === 'all') scenes = all;
    else if (input.level && input.level !== 'top') {
      const sub = resolveNode(l.model, input.level);
      if (sub.node.type !== 'subflow')
        return fail(
          `${sub.path} is a ${sub.node.type}, not a subflow; level is top, all or a subflow`,
        );
      scenes = all.filter((s) => s.level === sub.id);
    }
    const first = scenes[0];
    if (!first) return fail('That level is not in the flow');
    const out = input.out ?? `${dir}${key}${levelSuffix(first)}.drawio.svg`;
    if (!out.endsWith('.svg')) return fail('out must end in .svg (best .drawio.svg)');
    const ext = out.endsWith('.drawio.svg') ? '.drawio.svg' : '.svg';
    const stem = out.slice(0, -ext.length);
    const base = scenes.length > 1 ? stem.slice(0, stem.length - levelSuffix(first).length) : stem;
    const written: string[] = [];
    for (const scene of scenes) {
      const file = scenes.length > 1 ? `${base}${levelSuffix(scene)}${ext}` : out;
      const svg = sceneSvg(src, scene, { embed: toDrawio(src, { first: scene.level }) });
      written.push(await io.writeExport(file, svg));
    }
    return {
      text: [
        `Wrote ${written.join(', ')}.`,
        'SVG images in the canvas look, light theme. Each embeds the draw.io diagram (all levels, this one first), so draw.io opens it as an editable diagram with the node details.',
      ].join('\n'),
    };
  } catch (e) {
    return fail((e as Error).message);
  }
}

/**
 * AFD-27: existing automation (a playbook, a folder, a role, an AWX export) as text an agent designs
 * from: structure, and per task the exact binding an import writes. Secrets by name only.
 */
export async function sourceOutlineTool(
  io: FlowIO,
  input: { path?: string; focus?: string; flow?: string; page?: number },
): Promise<ToolResult> {
  const path = input.path?.trim();
  if (!path)
    return fail(
      'path: a playbook, a folder, a role folder or an AWX export (.json), relative to the workspace',
    );
  const at = io.source?.(path);
  if (!at) return fail('Reading playbooks is not available here');
  const flow =
    input.flow && at.prefix && input.flow.startsWith(at.prefix)
      ? input.flow.slice(at.prefix.length)
      : input.flow;
  try {
    return {
      text: await sourceOutline(at.io, {
        path: at.path,
        ...(input.focus ? { focus: input.focus } : {}),
        ...(flow ? { flow } : {}),
        ...(input.page ? { page: input.page } : {}),
        ...(io.resolveModule ? { resolveModule: io.resolveModule } : {}),
      }),
    };
  } catch (e) {
    return fail((e as Error).message);
  }
}

/**
 * AFD-27: the as-is import (AFD-26) as a tool: a playbook, or a template of an AWX export, becomes a
 * new flow, one step per task. For an exact copy; an intent-based design is built with flow_new and
 * flow_edit from source_outline instead.
 */
export async function flowImport(
  io: FlowIO,
  input: { source?: string; path?: string; template?: string; name?: string },
): Promise<ToolResult> {
  const given = input.source?.trim().replace(/^\.\//, '');
  if (!given)
    return fail('source: a playbook (.yml) or an AWX export (.json), relative to the workspace');
  const at = io.source?.(given);
  if (!at) return fail('Reading playbooks is not available here');
  const src = at.io;
  const source = at.path;
  const stem = slugify(
    (input.template ?? source.split('/').pop() ?? '').replace(/\.(ya?ml|json)$/, ''),
    'imported',
  );
  const path = input.path?.trim() || `${at.prefix}flows/${stem}/${stem}.flow.yaml`;
  if (!path.endsWith('.flow.yaml')) return fail('path must end with .flow.yaml');
  const base =
    path
      .split('/')
      .pop()
      ?.replace(/\.flow\.yaml$/, '') ?? '';
  const key = SLUG.test(base) ? base : stem;
  const newId = io.ops(path).newId;
  let result: ImportResult;
  if (source.endsWith('.json')) {
    let data: unknown;
    try {
      data = JSON.parse((await src.read(source)) ?? '');
    } catch {
      return fail(`${source} is not readable JSON`);
    }
    const names = exportTemplates(data);
    if (typeof names === 'string') return fail(`${source}: ${names}`);
    const all = [...names.workflows, ...names.jobs];
    const template = input.template ?? (all.length === 1 ? all[0] : undefined);
    if (!template || !all.includes(template))
      return fail(`template: one of ${all.map((n) => `"${n}"`).join(', ')}`);
    const job = !names.workflows.includes(template);
    const wf = job
      ? jobTemplateFromExport(data as AwxExport, template)
      : workflowFromExport(data as AwxExport, template);
    const present = new Set<string>();
    const playbooks = new Map<string, PlaybookForm>();
    for (const ref of playbooksOf(wf)) {
      const read = await readPlaybook(src, ref.replace(/^\.?\//, ''));
      if (!read.playbook) continue;
      present.add(ref);
      if (read.playbook.plays.length) playbooks.set(ref, read.playbook);
    }
    result = importWorkflow(wf, {
      key,
      newId,
      hasPlaybook: (r) => present.has(r),
      playbooks,
      kind: job ? 'awx_job_template' : 'awx_workflow',
    });
  } else {
    const read = await readPlaybook(
      src,
      source,
      io.resolveModule ? { resolveModule: io.resolveModule } : {},
    );
    if (!read.playbook?.plays.length)
      return fail(
        read.notes.join(' ') || `${source} has no plays: import the playbook that uses it`,
      );
    result = importPlaybook(
      read.playbook,
      {
        key,
        newId,
        generatedDir: generatedDirOf(
          path.startsWith(at.prefix) ? path.slice(at.prefix.length) : path,
          key,
        ),
        ...(input.name ? { name: input.name } : {}),
      },
      read.notes,
    );
  }
  let created: { text: string; notes: string[] };
  try {
    created = await io.create(path, flowText(result.doc));
  } catch (e) {
    return fail((e as Error).message);
  }
  const checked = check(created.text, io.schema);
  if (typeof checked === 'string') return fail(checked);
  const c = result.counts;
  return {
    text: [
      `Created ${path} from ${source}${input.template ? ` (${input.template})` : ''}: ${c.steps} step(s), ${c.implemented} ready to run, ${c.drafts} to check (the notes say why). One step per task, as the source has them.`,
      ...created.notes,
      ...(result.notes.length
        ? ['What did not map one to one:', ...result.notes.map((n) => `- ${n}`)]
        : []),
      describeFlow(checked.model, checked.findings, revisionOf(created.text)),
    ].join('\n'),
  };
}

/** Runs a tool by name: the adapters' single entry point. */
export async function runTool(io: FlowIO, name: string, input: unknown): Promise<ToolResult> {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, never>;
  switch (name) {
    case 'flow_list':
      return flowList(io);
    case 'flow_describe':
      return flowDescribe(io, args);
    case 'flow_validate':
      return flowValidate(io, args);
    case 'flow_reference':
      return flowReference(args);
    case 'flow_edit':
      return flowEdit(io, args);
    case 'flow_new':
      return flowNew(io, args);
    case 'flow_complete_ids':
      return flowCompleteIds(io, args);
    case 'flow_export':
      return flowExport(io, args);
    case 'source_outline':
      return sourceOutlineTool(io, args);
    case 'flow_import':
      return flowImport(io, args);
  }
  return fail(`Unknown tool ${name}`);
}
