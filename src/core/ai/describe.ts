// A flow described for AI tools (AFD-19): compact, by key, one line per node and wire, with the
// open fail ports and the problems. IDs never appear.
import { registerName } from '../flow/dataNames';
import { liftOf } from '../flow/dataRefs';
import { FINDING_CODES } from '../flow/findingCodes';
import { type FlowModel, ROOT } from '../flow/model';
import { openFailPorts } from '../flow/openPorts';
import { defaultPortNames, portsFor } from '../flow/ports';
import type { ContractField, FlowNode, Position } from '../flow/types';
import type { Finding } from '../flow/validate';
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
    node.intent ? `intent: ${node.intent}` : '',
    node.condition ? `condition: ${node.condition}` : '',
    node.outcome ? `outcome: ${node.outcome}` : '',
    node.handler ? `handler: ${node.handler}` : '',
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

/** Problems by key, with the fix for each code. */
export function formatFindings(model: FlowModel, findings: readonly Finding[], max = 60): string {
  if (findings.length === 0) return 'No problems.';
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const lines = sorted.slice(0, max).map((f) => {
    const where = f.node ? keyPath(model, f.node) : f.path.join('.');
    const fix = FINDING_CODES[f.code]?.fix;
    return `- ${f.severity} ${f.code}${where ? ` at ${where}` : ''}: ${withoutIds(model, f.message)}${fix ? ` Fix: ${fix}` : ''}`;
  });
  if (sorted.length > max) lines.push(`- … ${sorted.length - max} more`);
  return lines.join('\n');
}

export function countFindings(findings: readonly Finding[]): string {
  const n = (s: Finding['severity']) => findings.filter((f) => f.severity === s).length;
  return `${n('error')} error(s), ${n('warning')} warning(s), ${n('info')} note(s)`;
}

/** The flow by key: header, then each level's nodes, wires, boundary and open fail ports. */
export function describeFlow(
  model: FlowModel,
  findings: readonly Finding[],
  revision: string,
  level?: string,
  layout?: ShownLayout,
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
    `Revision: ${revision} (pass it to flow_edit)`,
    ...(layout ? [`Layout: ${LAYOUT_RULES}`] : []),
  ];
  const open = openFailPorts(model);
  const decided = (doc.decisions ?? []).filter((d) => d?.kind === 'open_on_purpose' && d.node);
  for (const lv of model.levels.values()) {
    if (level && level !== 'all' && lv.id !== level) continue;
    const parent = lv.parent ? model.nodes.get(lv.parent)?.node : undefined;
    out.push('', lv.id === ROOT ? 'Top level' : `Subflow ${keyPath(model, lv.id)} (inner level)`);
    if (parent?.subflow?.boundary) {
      const b = parent.subflow.boundary;
      if (b.in) out.push(`  entry: ${keyPath(model, b.in)}`);
      for (const [port, refs] of Object.entries(b.outputs ?? {}))
        out.push(
          `  exit ${port} <- ${(refs ?? []).map((r) => `${keyPath(model, r.node)}.${r.port}`).join(', ')}`,
        );
    }
    out.push('  nodes:');
    for (const n of lv.nodes) if (n?.key) out.push(`    ${nodeLine(n, layout)}`);
    out.push('  wires:');
    const wires = lv.edges.filter((e) => e?.from && e.to);
    if (wires.length === 0) out.push('    (none)');
    for (const e of wires)
      out.push(
        `    ${keyPath(model, e.from.node)}.${e.from.port} -> ${keyPath(model, e.to.node)}${e.to.port === 'in' ? '' : `.${e.to.port}`}`,
      );
    const here = open.filter((o) => o.level === lv.id);
    if (here.length)
      out.push(
        `  open fail ports (wire, apply_pattern or leave_open): ${here.map((o) => `${keyPath(model, o.node)}.${o.port}`).join(', ')}`,
      );
    const kept = decided.filter((d) => model.nodes.get(d.node as string)?.level === lv.id);
    if (kept.length)
      out.push(
        `  left open on purpose: ${kept.map((d) => `${keyPath(model, d.node as string)}.${d.port} (${d.reason ?? 'no reason'})`).join(', ')}`,
      );
  }
  out.push(
    '',
    `Problems: ${countFindings(findings)}${findings.length ? ' (flow_validate lists them)' : ''}`,
  );
  if (level && level !== 'all' && !model.levels.has(level))
    out.push(`No level ${levelName(model, level)}`);
  return out.join('\n');
}
