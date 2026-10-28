// Semantic checks on a flow document. Findings carry YAML paths; the host maps them to ranges.
import type { Path } from '../yaml/parse';
import { buildModel, type FlowModel, keyScope, ROOT } from './model';
import { openFailPorts } from './openPorts';
import { isPortLegal, portDirection, portsFor } from './ports';
import type { SchemaIssue } from './schema';
import type { FlowDocument, FlowNode, Ulid } from './types';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  path: Path;
  node?: Ulid;
  port?: string;
  edge?: Ulid;
}

export function pointerToPath(pointer: string): Path {
  if (pointer === '/' || pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((s) => (/^[0-9]+$/.test(s) ? Number(s) : s));
}

function label(node: FlowNode | undefined): string {
  return node ? `"${node.title ?? node.key}"` : 'unknown node';
}

export interface ValidationResult {
  model: FlowModel;
  findings: Finding[];
}

export function validateFlow(
  doc: FlowDocument,
  schemaIssues: SchemaIssue[] = [],
): ValidationResult {
  const model = buildModel(doc);
  const findings: Finding[] = schemaIssues.map((i) => ({
    code: 'schema',
    severity: 'error',
    message: `Schema: ${i.message}`,
    path: pointerToPath(i.pointer),
  }));
  const add = (f: Finding) => findings.push(f);

  checkIdentity(model, add);
  checkEdges(model, add);
  checkNodes(model, add);
  checkReferences(model, add);
  checkDecisions(model, add);

  for (const open of openFailPorts(model)) {
    const entry = model.nodes.get(open.node);
    add({
      code: 'open-fail-port',
      severity: 'warning',
      message: `Open fail port: ${label(entry?.node)} · ${open.port} is not wired and not marked open on purpose`,
      path: entry?.path ?? [],
      node: open.node,
      port: open.port,
    });
  }

  const ids = new Set(model.nodes.keys());
  for (const id of Object.keys(doc.layout ?? {})) {
    if (!ids.has(id)) {
      add({
        code: 'layout-orphan',
        severity: 'info',
        message: `Layout entry for a node that does not exist: ${id}`,
        path: ['layout', id],
      });
    }
  }
  return { model, findings };
}

function checkIdentity(model: FlowModel, add: (f: Finding) => void): void {
  const seen = new Map<string, string>();
  const claim = (id: string | undefined, path: Path) => {
    if (!id) return;
    const where = path.join('.');
    const first = seen.get(id);
    if (first !== undefined) {
      add({
        code: 'duplicate-id',
        severity: 'error',
        message: `Duplicate ID ${id} (also at ${first})`,
        path,
      });
    } else {
      seen.set(id, where);
    }
  };
  claim(model.doc.flow?.id, ['flow', 'id']);
  for (const level of model.levels.values()) {
    const keys = new Map<string, number>();
    level.nodes.forEach((n, i) => {
      if (!n) return;
      claim(n.id, [...level.nodesPath, i, 'id']);
      if (keys.has(n.key)) {
        add({
          code: 'duplicate-key',
          severity: 'error',
          message: `Duplicate key "${n.key}" in this level`,
          path: [...level.nodesPath, i, 'key'],
          node: n.id,
        });
      } else {
        keys.set(n.key, i);
      }
    });
    level.edges.forEach((e, i) => {
      claim(e?.id, [...level.edgesPath, i, 'id']);
    });
  }
}

function checkEdges(model: FlowModel, add: (f: Finding) => void): void {
  for (const level of model.levels.values()) {
    const used = new Map<string, Ulid>();
    level.edges.forEach((edge, i) => {
      if (!edge?.from || !edge.to) return;
      const path = [...level.edgesPath, i];
      for (const [end, ref] of [
        ['from', edge.from],
        ['to', edge.to],
      ] as const) {
        const target = model.nodes.get(ref.node);
        if (!target) {
          add({
            code: 'edge-missing-node',
            severity: 'error',
            message: `Edge ${end} refers to a node that does not exist: ${ref.node}`,
            path: [...path, end, 'node'],
            edge: edge.id,
          });
          continue;
        }
        if (target.level !== level.id) {
          add({
            code: 'edge-cross-level',
            severity: 'error',
            message: `Edge ${end} ${label(target.node)} is in another level; use the subflow boundary`,
            path: [...path, end, 'node'],
            edge: edge.id,
          });
          continue;
        }
        const expected = end === 'from' ? 'out' : 'in';
        if (!isPortLegal(target.node, ref.port)) {
          add({
            code: 'edge-bad-port',
            severity: 'error',
            message: `${label(target.node)} (${target.node.type}) has no port "${ref.port}"`,
            path: [...path, end, 'port'],
            edge: edge.id,
          });
        } else if (portDirection(ref.port) !== expected) {
          add({
            code: 'edge-direction',
            severity: 'error',
            message: `Edge ${end} uses ${ref.port}, which is an ${portDirection(ref.port)}put port`,
            path: [...path, end, 'port'],
            edge: edge.id,
          });
        } else if (!portsFor(target.node).some((p) => p.name === ref.port)) {
          add({
            code: 'edge-port-not-enabled',
            severity: 'warning',
            message: `Port ${ref.port} of ${label(target.node)} is used but not enabled in ports:`,
            path: [...path, end, 'port'],
            edge: edge.id,
          });
        }
        if (end === 'from' && ref.port === 'cancelled') {
          add({
            code: 'port-not-routable',
            severity: 'warning',
            message:
              'The compiled engine cannot route "cancelled" (the job is killed); it shows in Run mode only',
            path: [...path, 'from', 'port'],
            edge: edge.id,
          });
        }
      }
      const fromKey = `${edge.from.node}|${edge.from.port}`;
      if (used.has(fromKey)) {
        add({
          code: 'port-multiple-edges',
          severity: 'error',
          message: `Output port ${edge.from.port} has more than one edge; use a parallel node to fan out`,
          path,
          edge: edge.id,
        });
      } else {
        used.set(fromKey, edge.id);
      }
    });
  }
}

function checkNodes(model: FlowModel, add: (f: Finding) => void): void {
  for (const { node, path, level } of model.nodes.values()) {
    for (const p of node.ports ?? []) {
      if (!isPortLegal(node, p)) {
        add({
          code: 'port-not-supported',
          severity: 'warning',
          message: `${label(node)} (${node.type}) does not support port "${p}"`,
          path: [...path, 'ports'],
          node: node.id,
        });
      }
    }
    if (node.ports?.includes('undo') && !node.undo) {
      add({
        code: 'undo-unbound',
        severity: 'warning',
        message: `${label(node)} enables the undo port but has no undo binding`,
        path: [...path, 'ports'],
        node: node.id,
      });
    }
    const hasInner = (node.subflow?.nodes?.length ?? 0) > 0;
    if ((node.status === 'implemented' || node.status === 'tested') && !node.impl && !hasInner) {
      add({
        code: 'status-overclaim',
        severity: 'warning',
        message: `${label(node)} is ${node.status} but has no implementation binding`,
        path: [...path, 'status'],
        node: node.id,
      });
    }
    if (
      node.status === 'specified' &&
      Object.keys(node.inputs ?? {}).length + Object.keys(node.outputs ?? {}).length === 0
    ) {
      add({
        code: 'status-overclaim',
        severity: 'warning',
        message: `${label(node)} is specified but declares no inputs or outputs`,
        path: [...path, 'status'],
        node: node.id,
      });
    }
    for (const [name, field] of Object.entries(node.inputs ?? {})) {
      if (field?.type === 'host_list') {
        add({
          code: 'host-list-input',
          severity: 'info',
          message: `Input "${name}" of ${label(node)}: the hosts arriving on "in" are the targets; this host_list is informational`,
          path: [...path, 'inputs', name],
          node: node.id,
        });
      }
    }
    if (node.type === 'approval') checkApprovalSplit(model, node, level, path, add);
  }
}

function checkApprovalSplit(
  model: FlowModel,
  node: FlowNode,
  levelId: string,
  path: Path,
  add: (f: Finding) => void,
): void {
  const edges = model.levels.get(levelId)?.edges ?? [];
  const target = (port: string) =>
    edges.find((e) => e?.from?.node === node.id && e.from.port === port)?.to.node;
  const rejected = target('rejected');
  const timeout = target('timeout');
  if (rejected && timeout && rejected !== timeout) {
    add({
      code: 'approval-split',
      severity: 'warning',
      message: `${label(node)}: AWX cannot tell rejected from timeout; both follow one failure path`,
      path,
      node: node.id,
    });
  }
}

function checkReferences(model: FlowModel, add: (f: Finding) => void): void {
  const flowInputs = new Set(Object.keys(model.doc.flow?.inputs ?? {}));
  for (const { node, path, level } of model.nodes.values()) {
    const scope = keyScope(model, level);
    for (const side of ['inputs', 'outputs'] as const) {
      for (const [name, field] of Object.entries(node[side] ?? {})) {
        const from = field?.from;
        if (!from) continue;
        const [head, rest] = [from.split('.')[0] ?? '', from.split('.').slice(1).join('.')];
        let ok = true;
        if (head === 'flow') ok = flowInputs.has(rest);
        else if (head === 'impl') ok = true;
        else {
          const ref = scope.get(head);
          const target = ref ? model.nodes.get(ref)?.node : undefined;
          ok = !!target && (rest === '' || rest in (target.outputs ?? {}));
        }
        if (!ok) {
          add({
            code: 'from-unresolved',
            severity: 'warning',
            message: `${label(node)} ${side}.${name}: "${from}" does not resolve to a flow input or an upstream output`,
            path: [...path, side, name, 'from'],
            node: node.id,
          });
        }
      }
    }
  }
  const runtime = model.doc.flow?.runtime?.kind;
  if (runtime && runtime !== 'ansible_playbook') {
    const approvals = [...model.nodes.values()].some((n) => n.node.type === 'approval');
    const inferred = approvals ? 'awx_workflow' : 'awx_job';
    if (runtime !== inferred) {
      add({
        code: 'runtime-kind',
        severity: 'info',
        message: `runtime.kind is ${runtime}, but the compiled engine produces ${inferred} for this flow`,
        path: ['flow', 'runtime', 'kind'],
      });
    }
  }
  for (const level of model.levels.values()) {
    if (level.id === ROOT) continue;
    const parent = model.nodes.get(level.parent ?? '')?.node;
    const boundary = parent?.subflow?.boundary;
    if (!parent || !boundary) continue;
    const base = model.nodes.get(parent.id)?.path ?? [];
    const inner = new Set(level.nodes.map((n) => n?.id));
    if (boundary.in && !inner.has(boundary.in)) {
      add({
        code: 'boundary-ref',
        severity: 'warning',
        message: `Subflow ${label(parent)}: boundary.in is not an inner node`,
        path: [...base, 'subflow', 'boundary', 'in'],
        node: parent.id,
      });
    }
    const parentPorts = new Set(portsFor(parent).map((p) => p.name));
    for (const [port, refs] of Object.entries(boundary.outputs ?? {})) {
      if (!parentPorts.has(port)) {
        add({
          code: 'boundary-ref',
          severity: 'warning',
          message: `Subflow ${label(parent)}: boundary output "${port}" is not a port of the subflow node`,
          path: [...base, 'subflow', 'boundary', 'outputs', port],
          node: parent.id,
        });
      }
      for (const ref of refs ?? []) {
        if (!inner.has(ref.node)) {
          add({
            code: 'boundary-ref',
            severity: 'warning',
            message: `Subflow ${label(parent)}: boundary output "${port}" refers to a node outside the subflow`,
            path: [...base, 'subflow', 'boundary', 'outputs', port],
            node: parent.id,
          });
        }
      }
    }
  }
}

function checkDecisions(model: FlowModel, add: (f: Finding) => void): void {
  (model.doc.decisions ?? []).forEach((d, i) => {
    if (!d) return;
    const entry = model.nodes.get(d.node);
    if (!entry || !portsFor(entry.node).some((p) => p.name === d.port)) {
      add({
        code: 'stale-decision',
        severity: 'warning',
        message: `Decision refers to a port that does not exist: ${d.node} · ${d.port}`,
        path: ['decisions', i],
      });
      return;
    }
    if (!d.reason?.trim()) {
      add({
        code: 'decision-no-reason',
        severity: 'warning',
        message: `Open-on-purpose decision for ${label(entry.node)} · ${d.port} has no reason`,
        path: ['decisions', i],
        node: d.node,
      });
    }
    const edges = model.levels.get(entry.level)?.edges ?? [];
    if (edges.some((e) => e?.from?.node === d.node && e.from.port === d.port)) {
      add({
        code: 'decision-on-connected',
        severity: 'info',
        message: `${label(entry.node)} · ${d.port} is wired; its open-on-purpose decision has no effect`,
        path: ['decisions', i],
        node: d.node,
      });
    }
  });
}
