// A flow described for AI tools (AFD-19): compact, by key, one line per node and wire, with the
// open fail ports and the problems. IDs never appear.
import { LAYOUT_FIX, type LayoutProblem } from '../export/layoutCheck';
import { registerName } from '../flow/dataNames';
import { liftOf } from '../flow/dataRefs';
import { acceptedAll } from '../flow/decisions';
import { FINDING_CODES } from '../flow/findingCodes';
import { purposeOf } from '../flow/format';
import { type FlowModel, ROOT } from '../flow/model';
import { openFailPorts } from '../flow/openPorts';
import { defaultPortNames, portsFor } from '../flow/ports';
import type { Annotation, ContractField, FlowNode, Position } from '../flow/types';
import { acceptKey, type Finding } from '../flow/validate';
import { plainText } from '../view/markdown';
import { keyPath, levelName, withoutIds } from './refs';
import { LAYOUT_RULES } from './specs';

function fields(contract: Record<string, ContractField> | undefined, node?: FlowNode): string {
  return Object.entries(contract ?? {})
    .map(([name, f]) => {
      if (f?.from) return `${name}<-${f.from}`;
      // A subflow output without from lifts the inner output of the same name (AFD-21).
      const lift = node?.type === 'subflow' ? liftOf(node, name) : undefined;
      return lift && 'inner' in lift ? `${name}<-${lift.inner.key}.${name} (same name)` : name;
    })
    .join(', ');
}

/** Where the canvas shows nodes (AFD-24): stored positions and auto ones. */
export interface ShownLayout {
  stored: Partial<Record<string, Position>>;
  auto: Partial<Record<string, Position>>;
}

function placeOf(node: FlowNode, layout: ShownLayout | undefined): string {
  if (!layout) return '';
  const at = layout.stored[node.id];
  if (at) return `at ${at.x},${at.y}`;
  const auto = layout.auto[node.id];
  return auto ? `auto ${auto.x},${auto.y}` : '';
}

/** Task keywords (AFD-26), each value on one line and cut short. */
function keywordsText(node: FlowNode): string {
  const kw = Object.entries(node.impl?.keywords ?? {});
  if (!kw.length) return '';
  const short = (v: unknown) => {
    const s = (typeof v === 'string' ? v : JSON.stringify(v)).replaceAll(/\s+/g, ' ');
    return s.length > 60 ? `${s.slice(0, 59)}…` : s;
  };
  return `keywords: ${kw.map(([k, v]) => `${k}=${short(v)}`).join(', ')}`;
}

function nodeLine(node: FlowNode, layout?: ShownLayout): string {
  const extra = portsFor(node)
    .map((p) => p.name)
    .filter((p) => !defaultPortNames(node).includes(p));
  const parts = [
    `${node.key} (${node.type}${node.status ? `, ${node.status}` : ''}) "${node.title}"`,
    node.disabled ? 'DISABLED (hosts pass through, nothing is generated)' : '',
    node.intent ? `intent: ${node.intent}` : '',
    node.condition ? `condition: ${node.condition}` : '',
    node.outcome ? `outcome: ${node.outcome}` : '',
    purposeOf(node) ? `purpose: ${purposeOf(node)}` : '',
    node.type === 'parallel' && node.branches ? `branches: ${node.branches}` : '',
    node.join_mode ? `join: ${node.join_mode}` : '',
    extra.length ? `ports +${extra.join(' +')}` : '',
    node.impl ? `impl: ${node.impl.kind} ${node.impl.ref}` : '',
    // until reads the registered result by name (AFD-21).
    node.impl?.kind === 'module' &&
    (node.impl.register || node.settings?.retries || node.settings?.until)
      ? `register: ${registerName(node)}`
      : '',
    keywordsText(node),
    fields(node.inputs) ? `inputs: ${fields(node.inputs)}` : '',
    fields(node.outputs) ? `outputs: ${fields(node.outputs, node)}` : '',
    placeOf(node, layout),
    node.settings && Object.keys(node.settings).length
      ? `settings: ${Object.entries(node.settings)
          .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`)
          .join(', ')}`
      : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

/** AFD-189: one line per node, for large flows (key, type, status, title, binding). */
function briefLine(node: FlowNode): string {
  return `${node.key} (${node.type}${node.status ? `, ${node.status}` : ''}) "${node.title}"${node.impl ? ` · ${node.impl.ref}` : ''}${node.type === 'subflow' ? ` · ${node.subflow?.nodes?.length ?? 0} step(s)` : ''}`;
}

/** AFD-189: how much of a flow describeFlow shows. */
export interface DescribeView {
  /** One short line per node. */
  brief?: boolean;
  /** Only nodes whose key path starts with one of these, and the wires touching them. */
  nodes?: string[];
  /** With layout: only the layout check, no nodes or wires. */
  onlyProblems?: boolean;
}

/**
 * AFD-189: problems grouped by code (count, the nodes with most of them, the fix once), so a flow
 * with hundreds of warnings fits in one answer.
 */
export function summarizeFindings(model: FlowModel, findings: readonly Finding[]): string {
  if (findings.length === 0) return 'No problems.';
  const order = { error: 0, warning: 1, info: 2 } as const;
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const k = `${f.severity} ${f.code}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const lines: string[] = [];
  for (const [k, fs] of [...groups.entries()].sort(
    (a, b) =>
      order[a[1][0]?.severity ?? 'info'] - order[b[1][0]?.severity ?? 'info'] ||
      b[1].length - a[1].length,
  )) {
    const byNode = new Map<string, number>();
    for (const f of fs) {
      const where = f.node ? keyPath(model, f.node) : f.path.join('.') || 'flow';
      byNode.set(where, (byNode.get(where) ?? 0) + 1);
    }
    const top = [...byNode.entries()].sort((a, b) => b[1] - a[1]);
    const subjects = [...new Set(fs.map((f) => f.subject).filter(Boolean))];
    const fix = FINDING_CODES[fs[0]?.code ?? '']?.fix;
    lines.push(
      `- ${k} ×${fs.length} at ${byNode.size} place(s): ${top
        .slice(0, 8)
        .map(([w, n]) => (n > 1 ? `${w} (${n})` : w))
        .join(
          ', ',
        )}${top.length > 8 ? ', …' : ''}${subjects.length ? `; about: ${subjects.slice(0, 12).join(', ')}${subjects.length > 12 ? ', …' : ''}` : ''}${fix ? ` Fix: ${fix}` : ''}`,
    );
  }
  return lines.join('\n');
}

/** Problems by key, with the fix for each code. */
export function formatFindings(model: FlowModel, findings: readonly Finding[], max = 60): string {
  if (findings.length === 0) return 'No problems.';
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const lines = sorted.slice(0, max).map((f) => {
    const where = f.node ? keyPath(model, f.node) : f.path.join('.');
    const fix = FINDING_CODES[f.code]?.fix;
    // AFD-184: the exact finding an accept op takes, so a wrong key is never guessed.
    const key =
      f.severity === 'warning' && f.node && f.code !== 'open-fail-port' ? acceptKey(f) : '';
    return `- ${f.severity} ${f.code}${where ? ` at ${where}` : ''}: ${withoutIds(model, f.message)}${fix ? ` Fix: ${fix}` : ''}${key ? ` [accept: ${key}]` : ''}`;
  });
  if (sorted.length > max) lines.push(`- … ${sorted.length - max} more`);
  return lines.join('\n');
}

export function countFindings(findings: readonly Finding[]): string {
  const n = (s: Finding['severity']) => findings.filter((f) => f.severity === s).length;
  return `${n('error')} error(s), ${n('warning')} warning(s), ${n('info')} info`;
}

/** `note-1 (note on precheck, green, at 232,0 from it): "first line…"`, without IDs. */
function annotationLine(model: FlowModel, a: Annotation, layout?: ShownLayout): string {
  const kind = a.kind ?? 'note';
  const first = plainText(a.text).split('\n')[0] ?? '';
  const words = first.length > 80 ? `${first.slice(0, 79)}…` : first;
  const lines = a.text.split('\n').length;
  const on = a.on && model.nodes.has(a.on) ? ` on ${keyPath(model, a.on)}` : '';
  const look = [a.color, a.size].filter(Boolean).join(', ');
  const at = layout ? `, at ${a.x},${a.y}${on ? ' from it' : ''}` : '';
  return `${a.key} (${kind}${on}${look ? `, ${look}` : ''}${at}): "${words}"${lines > 1 ? ` (+${lines - 1} line(s))` : ''}`;
}

/** The flow by key: header, then each level's nodes, wires, boundary and open fail ports. */
/** The layout check over every level, in one line. */
function layoutTotal(layoutIssues: ReadonlyMap<string, readonly LayoutProblem[]>): string {
  const n = [...layoutIssues.values()].reduce((sum, l) => sum + l.length, 0);
  return n
    ? `Layout check: ${n} problem(s), listed per level. ${LAYOUT_FIX}`
    : 'Layout check: no problems (no overlap, no wire through a box, no label on a box or another label, no crossing).';
}

export function describeFlow(
  model: FlowModel,
  findings: readonly Finding[],
  revision: string,
  level?: string,
  layout?: ShownLayout,
  /** AFD-69: the layout check per level, with layout. */
  layoutIssues?: ReadonlyMap<string, readonly LayoutProblem[]>,
  view: DescribeView = {},
): string {
  const { doc } = model;
  const f = doc.flow;
  const out: string[] = [
    `Flow "${f?.name}" (key ${f?.key}, version ${f?.version})`,
    ...(f?.goal ? [`Goal: ${f.goal}`] : []),
    ...(f?.owner ? [`Owner: ${f.owner}`] : []),
    ...(f?.inputs && Object.keys(f.inputs).length
      ? [
          `Inputs: ${Object.entries(f.inputs)
            .map(
              ([k, v]) =>
                `${k} (${[v?.type, v?.required ? 'required' : '', v?.targets ? 'targets' : '']
                  .filter(Boolean)
                  .join(', ')})`,
            )
            .join(', ')}`,
        ]
      : []),
    // AFD-185: what steps may read without an input.
    ...(f?.external_vars && Object.keys(f.external_vars).length
      ? [
          `Set outside the flow: ${Object.entries(f.external_vars)
            .map(([k, v]) => `${k} (${v})`)
            .join(', ')}`,
        ]
      : []),
    `Revision: ${revision} (pass it to flow_edit)`,
    ...(layout ? [`Layout: ${LAYOUT_RULES}`] : []),
    // AFD-213: the total first, so page 1 of a long answer says whether the layout is clean.
    ...(layoutIssues ? [layoutTotal(layoutIssues)] : []),
  ];
  const open = openFailPorts(model);
  const decided = acceptedAll(doc).filter((a) => a.area === 'port' && a.node);
  const picked = (id: string) =>
    !view.nodes?.length ||
    view.nodes.some((p) => {
      const k = keyPath(model, id);
      return k === p || k.startsWith(`${p}/`);
    });
  for (const lv of model.levels.values()) {
    if (level && level !== 'all' && lv.id !== level) continue;
    if (view.nodes?.length && !lv.nodes.some((n) => n?.id && picked(n.id))) continue;
    if (view.onlyProblems && !(layoutIssues?.get(lv.id)?.length ?? 0)) continue;
    const parent = lv.parent ? model.nodes.get(lv.parent)?.node : undefined;
    out.push('', lv.id === ROOT ? 'Top level' : `Subflow ${keyPath(model, lv.id)} (inner level)`);
    if (view.onlyProblems) {
      out.push('  layout problems:');
      for (const p of layoutIssues?.get(lv.id) ?? []) out.push(`    ${p.text}`);
      continue;
    }
    if (parent?.subflow?.boundary) {
      const b = parent.subflow.boundary;
      if (b.in) out.push(`  entry: ${keyPath(model, b.in)}`);
      for (const [port, refs] of Object.entries(b.outputs ?? {}))
        out.push(
          `  exit ${port} <- ${(refs ?? []).map((r) => `${keyPath(model, r.node)}.${r.port}`).join(', ')}`,
        );
    }
    out.push('  nodes:');
    for (const n of lv.nodes)
      if (n?.key && picked(n.id))
        out.push(`    ${view.brief ? briefLine(n) : nodeLine(n, layout)}`);
    out.push('  wires:');
    const wires = lv.edges.filter(
      (e) => e?.from && e.to && (picked(e.from.node) || picked(e.to.node)),
    );
    if (wires.length === 0) out.push('    (none)');
    for (const e of wires)
      out.push(
        `    ${keyPath(model, e.from.node)}.${e.from.port} -> ${keyPath(model, e.to.node)}${e.to.port === 'in' ? '' : `.${e.to.port}`}`,
      );
    // AFD-64: annotations explain the level; they never run.
    const notes = lv.annotations.filter((a) => a?.id && typeof a.text === 'string');
    if (notes.length) {
      out.push('  annotations:');
      for (const a of notes) out.push(`    ${annotationLine(model, a, layout)}`);
    }
    const here = open.filter((o) => o.level === lv.id);
    if (here.length)
      out.push(
        `  open fail ports (wire, apply_pattern or leave_open): ${here.map((o) => `${keyPath(model, o.node)}.${o.port}`).join(', ')}`,
      );
    const kept = decided.filter((d) => model.nodes.get(d.node as string)?.level === lv.id);
    if (kept.length)
      out.push(
        `  left open on purpose: ${kept.map((d) => `${keyPath(model, d.node as string)}.${d.what} (${d.reason ?? 'no reason'})`).join(', ')}`,
      );
    const issues = layoutIssues?.get(lv.id) ?? [];
    if (issues.length) {
      out.push('  layout problems:');
      for (const p of issues) out.push(`    ${p.text}`);
    }
  }
  out.push(
    '',
    `Problems: ${countFindings(findings)}${findings.length ? ' (flow_validate lists them)' : ''}`,
  );
  if (level && level !== 'all' && !model.levels.has(level))
    out.push(`No level ${levelName(model, level)}`);
  return out.join('\n');
}
