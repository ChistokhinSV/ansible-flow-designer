// Inventory lens (04 §7, mockup 09): what each node targets in the inventory and how many hosts
// that is. Generated plays run on the hosts that arrive (ADR-0004), except where a node declares
// `settings.inventory_target`: its work then runs on that target instead (AFD-14). The `hosts:` of
// an imported playbook are shown as declared too.
import { type FlowModel, modelOf } from '../flow/model';
import { isFailPort } from '../flow/ports';
import type { FlowDocument, FlowNode, Ulid } from '../flow/types';
import type { RunView } from '../protocol';
import type { RunSummary } from '../run/events';
import { arrivals, edgeHosts, nodeHosts } from '../run/view';
import { incoming, isWork, joinTitles, plural, targetsInput, title } from './common';
import type {
  CodeFacts,
  InventoryState,
  LensChip,
  LensFinding,
  LensItem,
  LensView,
  PatternFacts,
} from './types';

const REF = /\{\{\s*(?:flow\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Groups and host names of a pattern, without exclusions and intersections. */
export function patternParts(pattern: string): string[] {
  return pattern
    .split(/[,:]/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('!') && !p.startsWith('&'));
}

export interface DeclaredTarget {
  pattern: string;
  source: 'inventory_target' | 'playbook';
  /** A Jinja reference that is not the flow targets input. */
  unresolved: boolean;
}

/** A node's declared target: `settings.inventory_target`, else an imported playbook's `hosts:`. */
export function declaredTarget(
  doc: FlowDocument,
  node: FlowNode,
  targets: string,
  code?: CodeFacts,
): DeclaredTarget | undefined {
  const raw = node.settings?.inventory_target?.trim();
  if (raw) {
    const name = targetsInput(doc);
    const pattern = raw.replaceAll(REF, (m, ref: string) =>
      ref === name && targets ? targets : m,
    );
    return { pattern, source: 'inventory_target', unresolved: pattern.includes('{{') };
  }
  const hosts = code?.nodes[node.id]?.hosts;
  if (hosts && hosts.length > 0)
    return {
      pattern: hosts.join(','),
      source: 'playbook',
      unresolved: hosts.join('').includes('{{'),
    };
  return undefined;
}

/** Every pattern the lens needs counted: the flow targets, declared targets and their parts. */
export function inventoryPatterns(doc: FlowDocument, targets: string, code?: CodeFacts): string[] {
  const out = new Set<string>();
  if (targets) {
    out.add(targets);
    for (const p of patternParts(targets)) out.add(p);
  }
  for (const { node } of modelOf(doc).nodes.values()) {
    const d = declaredTarget(doc, node, targets, code);
    if (!d || d.unresolved) continue;
    out.add(d.pattern);
    for (const p of patternParts(d.pattern)) out.add(p);
  }
  return [...out];
}

/** Hosts at a node in the last run: those that left it, or for an end node those that arrived. */
function ranAt(model: FlowModel, s: RunSummary, node: FlowNode): number {
  if (node.type === 'start') return s.hosts.length;
  if (node.type === 'end') return arrivals(model, s, node.id).length;
  return nodeHosts(s, node.id).length;
}

/** A flow host_list input already names this group (its default), so approvers see it. */
function isFlowInput(doc: FlowDocument, group: string): boolean {
  return Object.values(doc.flow.inputs ?? {}).some((f) => {
    if (f?.type !== 'host_list') return false;
    const d = f.default;
    const names = Array.isArray(d) ? d.map(String) : typeof d === 'string' ? patternParts(d) : [];
    return names.includes(group);
  });
}

function varName(group: string): string {
  const v = group.toLowerCase().replaceAll(/[^a-z0-9_]/g, '_');
  return /^[a-z_]/.test(v) ? v : `g_${v}`;
}

export function inventoryLens(
  doc: FlowDocument,
  inv: InventoryState | undefined,
  run: RunView | null,
  code?: CodeFacts,
): LensView {
  const model = modelOf(doc);
  const facts = inv?.state === 'ready' ? inv.facts : undefined;
  const targets = facts?.targets ?? inv?.targets ?? '';
  const name = targetsInput(doc) ?? 'targets';
  const s = run?.summary;
  const pf = (p: string): PatternFacts | undefined => facts?.patterns[p];
  const count = (p: string) => pf(p)?.count;
  const chips: Record<Ulid, LensChip[]> = {};
  const findings: LensFinding[] = [];
  /** group → nodes using it, whether it comes from the flow targets. */
  const usage = new Map<string, { nodes: Set<Ulid>; input: boolean }>();
  const use = (group: string, node: Ulid, input: boolean) => {
    const u = usage.get(group) ?? { nodes: new Set(), input };
    u.nodes.add(node);
    u.input ||= input;
    usage.set(group, u);
  };
  const declaredNodes: { node: FlowNode; d: DeclaredTarget }[] = [];

  for (const { node } of model.nodes.values()) {
    const ran = s ? ranAt(model, s, node) : undefined;
    const d = isWork(node) ? declaredTarget(doc, node, targets, code) : undefined;
    if (node.type === 'start') {
      chips[node.id] = targets
        ? [{ text: `${targets} · ${count(targets) ?? '?'}`, title: `flow input ${name}` }]
        : [
            {
              text: `${name}: not set`,
              tone: 'muted',
              title: 'Enter the flow targets in the side panel',
            },
          ];
      for (const p of patternParts(targets)) use(p, node.id, true);
      continue;
    }
    if (node.type === 'end') {
      chips[node.id] =
        ran !== undefined ? [{ text: `· ${ran}`, title: 'hosts that ended here' }] : [];
      continue;
    }
    if (d) {
      declaredNodes.push({ node, d });
      const parts = patternParts(d.pattern);
      const list: LensChip[] = parts.map((p) => {
        const f = pf(p);
        if (d.unresolved || !f) return { text: p, title: `declared target (${d.source})` };
        if (f.outside === 0) return { text: `${p} · ${ran ?? f.count}` };
        return {
          text: `+ ${p} · ${f.count}`,
          tone: 'warn',
          title: `${f.outside} of these hosts are outside the flow targets`,
        };
      });
      chips[node.id] =
        list.length > 2
          ? [list[0] as LensChip, { text: `+${list.length - 1} more`, title: d.pattern }]
          : list;
      for (const p of parts) use(p, node.id, false);
      continue;
    }
    if (!targets) {
      chips[node.id] = [];
      continue;
    }
    const n = ran ?? count(targets);
    chips[node.id] = [
      {
        text: `${targets} · ${n ?? '?'}`,
        title:
          ran !== undefined
            ? 'hosts at this node in the last run'
            : 'at most this many hosts arrive (no run yet)',
      },
    ];
    for (const p of patternParts(targets)) use(p, node.id, true);
  }

  // Wires: the hosts that took each wire in the last run (mockup 09 "ok · 47").
  const wires: Record<string, string> = {};
  if (s)
    for (const e of model.edges.values())
      wires[e.edge.id] = `${e.edge.from.port} · ${edgeHosts(model, s, e.edge).length}`;

  // Findings.
  const broad = new Set<Ulid>();
  for (const { node, d } of declaredNodes) {
    if (d.unresolved || !facts) continue;
    const f = pf(d.pattern);
    if (!f) continue;
    for (const p of patternParts(d.pattern))
      if (count(p) === 0)
        findings.push({
          id: `inventory:no-match:${node.id}:${p}`,
          lens: 'inventory',
          severity: 'warning',
          title: `${node.title}: ${p} matches no host`,
          detail: `The declared target ${d.pattern} names ${p}, which is not a group or host of the inventory (${facts.sources.join(', ')}).`,
          node: node.id,
          nodes: [node.id],
          fixes: [],
        });
    const from = incoming(model, node.id);
    const onFailPath = from.length > 0 && from.every((i) => isFailPort(i.port));
    if (f.outside === 0 || !(node.handler || onFailPath)) continue;
    broad.add(node.id);
    const ports = [...new Set(from.map((i) => i.port))].join(', ') || 'its wires';
    findings.push({
      id: `inventory:broad-target:${node.id}`,
      lens: 'inventory',
      severity: 'warning',
      title: `${node.title} targets ${d.pattern} (${f.count})`,
      detail: `It receives hosts from ${ports}, but its ${d.source === 'playbook' ? 'playbook runs on' : 'target is'} ${d.pattern}: ${plural(f.outside, 'host')} outside the flow targets${f.sample.length ? ` (${f.sample.join(', ')}${f.outside > f.sample.length ? ', …' : ''})` : ''}. One wrong condition could touch every one of them.`,
      node: node.id,
      nodes: [node.id],
      fixes:
        d.source === 'inventory_target'
          ? [
              {
                label: 'Limit to Arriving Hosts',
                command: {
                  kind: 'updateNode',
                  id: node.id,
                  patch: { settings: { inventory_target: null } },
                },
              },
            ]
          : [],
    });
  }
  if (facts) {
    const extra = new Map<string, Set<Ulid>>();
    for (const { node, d } of declaredNodes) {
      if (d.unresolved || broad.has(node.id)) continue;
      for (const p of patternParts(d.pattern)) {
        const f = pf(p);
        if (!f || f.outside === 0 || f.count === 0 || isFlowInput(doc, p)) continue;
        extra.set(p, (extra.get(p) ?? new Set()).add(node.id));
      }
    }
    for (const [group, ids] of extra) {
      const f = pf(group) as PatternFacts;
      const nodes = [...ids];
      findings.push({
        id: `inventory:group-not-input:${group}`,
        lens: 'inventory',
        severity: 'warning',
        title: `${group} is not a flow input`,
        detail: `${joinTitles(nodes.map((id) => title(model, id)))} ${nodes.length === 1 ? 'touches' : 'touch'} ${plural(f.count, 'host')} in ${group} that the flow targets (${targets || name}) do not include. Approvers only see the flow targets.`,
        nodes,
        fixes: [
          {
            label: 'Add to Flow Inputs',
            command: {
              kind: 'setContractField',
              target: 'flow',
              side: 'inputs',
              name: varName(group),
              field: { type: 'host_list', default: group },
            },
          },
        ],
      });
    }
    const prod = facts.prod_groups.filter((g) => facts.scope.groups[g]);
    if (prod.length > 0)
      findings.push({
        id: 'inventory:prod',
        lens: 'inventory',
        severity: 'info',
        title: `The flow touches production groups: ${prod.join(', ')}`,
        detail: `${prod.map((g) => `${g}: ${plural(facts.scope.groups[g] ?? 0, 'host')}`).join(', ')} in scope, in groups whose names look like production. Real runs ask for confirmation.`,
        nodes: [],
        fixes: [],
      });
  }
  // Side panel.
  const groups: LensItem[] = [...usage.entries()]
    .map(([group, u]) => {
      const f = pf(group);
      const parts = [plural(u.nodes.size, 'node')];
      if (u.input) parts.push('flow input');
      if (f?.outside) parts.push(`${f.outside} outside the targets`);
      return {
        key: `group:${group}`,
        label: group,
        value: f ? String(f.count) : undefined,
        detail: parts.join(' · '),
        nodes: [...u.nodes],
        tone: f?.outside ? ('warn' as const) : undefined,
      };
    })
    .sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0) || a.label.localeCompare(b.label));
  const excluded: LensItem[] = [];
  if (s) {
    const seen = new Set<string>();
    for (const [node, ports] of Object.entries(s.nodes))
      for (const [port, hosts] of Object.entries(ports)) {
        if (!isFailPort(port)) continue;
        for (const h of hosts) {
          if (seen.has(h)) continue;
          seen.add(h);
          excluded.push({
            key: `host:${h}`,
            label: h,
            detail: `${title(model, node)} · ${port}`,
            nodes: [node],
          });
        }
      }
  }
  const notes: string[] = [];
  if (!inv || inv.state === 'idle') notes.push('The inventory has not been read yet.');
  else if (inv.state === 'loading') notes.push('Reading the inventory…');
  else if (inv.state === 'error') notes.push(`The inventory could not be read: ${inv.error}`);
  if (!targets) notes.push(`Enter the flow targets (${name}) to count hosts per node.`);
  const runtime = doc.flow.runtime;
  if (runtime?.kind === 'awx_job' || runtime?.kind === 'awx_workflow')
    notes.push(
      `This flow runs in AWX${runtime.template ? ` (${runtime.template})` : ''}; AWX may use another inventory than the local one.`,
    );
  if (facts?.dynamic.length)
    notes.push(`Dynamic sources read on demand: ${facts.dynamic.join(', ')}.`);

  return {
    lens: 'inventory',
    chips,
    wires: s ? wires : undefined,
    stats: facts
      ? [
          { label: 'groups touched', value: String(Object.keys(facts.scope.groups).length) },
          { label: 'hosts in scope', value: String(facts.scope.count) },
          { label: 'inventory', value: plural(facts.total, 'host') },
        ]
      : [],
    sections: [
      { title: 'Groups used by this flow', items: groups, empty: 'No targets yet.' },
      ...(s
        ? [
            {
              title: 'Excluded last run',
              items: excluded,
              empty: 'No host left through a fail port.',
            },
          ]
        : []),
    ],
    findings,
    notes,
  };
}
