// The AI tools themselves (AFD-19), independent of who calls them: Copilot through the extension
// host, Claude Code, Codex and Gemini through the MCP server. Each adapter supplies a FlowIO (how
// files are found, read and written there); every answer is plain text by key, never with IDs.
import { checksum } from '../engine/util';
import { completeIds } from '../flow/completeIds';
import { parseFlow } from '../flow/document';
import { SLUG, slugify } from '../flow/ids';
import { type FlowModel, ROOT } from '../flow/model';
import type { SchemaValidator } from '../flow/schema';
import { newFlowText } from '../flow/template';
import { type Finding, validateFlow } from '../flow/validate';
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
  input: { path?: string; level?: string },
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
  return { text: `${l.path}\n${describeFlow(l.model, l.findings, revisionOf(l.text), level)}` };
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
function problemKeys(model: FlowModel, findings: Finding[]): Map<string, Finding> {
  return new Map(
    findings.map((f) => {
      const edge = f.edge ? model.edges.get(f.edge)?.edge : undefined;
      const about = [
        f.code,
        f.node ? keyPath(model, f.node) : '',
        f.port ?? '',
        edge ? `${keyPath(model, edge.from.node)}.${edge.from.port}` : '',
        f.path.filter((p) => typeof p === 'string').join('.'),
        f.node || edge ? '' : withoutIds(model, f.message),
      ];
      return [about.join('|'), f] as [string, Finding];
    }),
  );
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
    const added = [...after.entries()].filter(([k]) => !before.has(k)).map(([, f]) => f);
    const solved = [...before.keys()].filter((k) => !after.has(k)).length;
    return [
      ...(result.created.length ? [`Created: ${result.created.join(', ')}`] : []),
      ...(result.dropped.length
        ? [`Back to implemented (design changed after a passing run): ${result.dropped.join(', ')}`]
        : []),
      ...result.notes,
      ...notes,
      `Problems: ${countFindings(findings)}${solved ? `; ${solved} solved by this edit` : ''}`,
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
  }
  return fail(`Unknown tool ${name}`);
}
