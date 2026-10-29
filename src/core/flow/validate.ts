// Semantic checks on a flow document. Findings carry YAML paths; the host maps them to ranges.
import type { Path } from '../yaml/parse';
import { refsIn } from './jinja';
import { buildModel, type FlowModel, keyScope, ROOT } from './model';
import { openFailPorts } from './openPorts';
import { isRollback } from './patterns';
import { isFailPort, isPortLegal, portDirection, portsFor } from './ports';
import type { SchemaIssue } from './schema';
import type { FlowDocument, FlowNode, PortRef, Ulid } from './types';

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
  checkUnreachableRollback(model, add);
  checkTargets(model, add);

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
    checkEnginePorts(node, path, hasInner, add);
  }
}

/** Ports the Option A engine cannot drive for this node (ADR-0009, M3 spike). */
function checkEnginePorts(
  node: FlowNode,
  path: Path,
  hasInner: boolean,
  add: (f: Finding) => void,
): void {
  if (node.type !== 'task' && node.type !== 'subflow') return;
  const enabled = new Set(portsFor(node).map((p) => p.name));
  if (node.impl?.kind === 'role' && !hasInner) {
    for (const port of ['unreachable', 'unchanged']) {
      if (!enabled.has(port)) continue;
      add({
        code: 'port-role-unroutable',
        severity: 'warning',
        message:
          port === 'unreachable'
            ? `${label(node)} runs a role: hosts that become unreachable inside it drop out of the run and cannot take "unreachable". Put the connecting step in its own module node or a subflow`
            : `${label(node)} runs a role: Ansible gives no per-host "changed" for a role, so "unchanged" never fires`,
        path: [...path, 'ports'],
        node: node.id,
        port,
      });
    }
  }
  if (enabled.has('timeout') && !hasInner && !node.settings?.timeout) {
    add({
      code: 'timeout-without-setting',
      severity: 'warning',
      message: `${label(node)} enables "timeout" but sets no settings.timeout, so it never fires`,
      path: [...path, 'ports'],
      node: node.id,
      port: 'timeout',
    });
  }
}

function checkTargets(model: FlowModel, add: (f: Finding) => void): void {
  const inputs = Object.values(model.doc.flow?.inputs ?? {});
  if (inputs.some((f) => f?.type === 'host_list')) return;
  add({
    code: 'no-targets',
    severity: 'warning',
    message: 'The flow has no host_list input, so start has no hosts and no code can be generated',
    path: ['flow', 'inputs'],
  });
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

/** Variables every task can read: Ansible's magic and connection variables, loop items, omit. */
export const MAGIC_VARS =
  /^(ansible_[a-z0-9_]*|inventory_hostname(_short)?|inventory_dir|inventory_file|hostvars|groups|group_names|play_hosts|playbook_dir|role_path|role_name|omit|item|ansible_loop_var|lookup|query|q|now|range|dict|namespace|loop|afd_[a-z0-9_]*)$/;

/**
 * Binding parameters read node inputs (chips, D-26). A read of anything else works only by luck
 * (a flow extra var, another node's fact), and the design does not show the data dependency.
 */
function checkBindingVars(
  node: FlowNode,
  path: Path,
  flowInputs: Set<string>,
  add: (f: Finding) => void,
): void {
  if (!node.impl?.params) return;
  const inputs = new Set(Object.keys(node.inputs ?? {}));
  for (const name of refsIn(node.impl.params)) {
    if (inputs.has(name) || MAGIC_VARS.test(name)) continue;
    const flow = flowInputs.has(name);
    add({
      code: 'binding-unknown-var',
      severity: flow ? 'info' : 'warning',
      message: flow
        ? `${label(node)} reads flow input "${name}" directly: add it as a node input (from: flow.${name}) to show the dependency`
        : `${label(node)} reads "${name}", which is not an input of this node`,
      path: [...path, 'impl', 'params'],
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
          // `key.output` or a path into it (`key.output.changed`).
          ok = !!target && (rest === '' || (rest.split('.')[0] ?? '') in (target.outputs ?? {}));
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
  for (const { node, path } of model.nodes.values()) checkBindingVars(node, path, flowInputs, add);
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
    if (parent) checkBoundaryFlow(model, parent, level.nodes, level.edges, add);
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
        const from = level.nodes.find((n) => n?.id === ref?.node);
        if (!from) {
          add({
            code: 'boundary-ref',
            severity: 'warning',
            message: `Subflow ${label(parent)}: boundary output "${port}" refers to a node outside the subflow`,
            path: [...base, 'subflow', 'boundary', 'outputs', port],
            node: parent.id,
          });
        } else if (!isPortLegal(from, ref.port) || portDirection(ref.port) !== 'out') {
          add({
            code: 'boundary-ref',
            severity: 'warning',
            message: `Subflow ${label(parent)}: ${label(from)} has no output "${ref.port}" to leave through "${port}"`,
            path: [...base, 'subflow', 'boundary', 'outputs', port],
            node: parent.id,
          });
        } else if (
          level.edges.some((e) => e?.from?.node === ref.node && e.from.port === ref.port)
        ) {
          add({
            code: 'boundary-ref',
            severity: 'warning',
            message: `Subflow ${label(parent)}: ${label(from)} · ${ref.port} is wired inside and also leaves through "${port}"`,
            path: [...base, 'subflow', 'boundary', 'outputs', port],
            node: parent.id,
          });
        }
      }
    }
  }
}

/**
 * 03 "Subflow boundary": hosts must be able to enter the inner graph, every enabled output of the
 * subflow must be fed from inside (an exit, or a fail port that bubbles up), and an inner outcome
 * that neither continues inside nor leaves the subflow strands its hosts (D-23).
 */
function checkBoundaryFlow(
  model: FlowModel,
  parent: FlowNode,
  nodes: FlowNode[],
  edges: { from: PortRef; to: PortRef }[],
  add: (f: Finding) => void,
): void {
  const inner = nodes.filter((n): n is FlowNode => !!n?.id);
  if (inner.length === 0) return;
  const base = model.nodes.get(parent.id)?.path ?? [];
  const boundary = parent.subflow?.boundary;
  if (!boundary?.in) {
    add({
      code: 'boundary-no-entry',
      severity: 'warning',
      message: `Subflow ${label(parent)} has no entry step: hosts reaching it never run its inner steps`,
      path: [...base, 'subflow'],
      node: parent.id,
    });
  }
  const wired = new Set(edges.map((e) => `${e?.from?.node}|${e?.from?.port}`));
  const exits = new Set(
    Object.values(boundary?.outputs ?? {}).flatMap((refs) =>
      (refs ?? []).map((r) => `${r?.node}|${r?.port}`),
    ),
  );
  for (const port of portsFor(parent)) {
    if (port.direction !== 'out' || port.name === 'cancelled') continue;
    const fed =
      (boundary?.outputs?.[port.name] ?? []).length > 0 ||
      (port.fail &&
        inner.some(
          (n) =>
            portsFor(n).some((p) => p.name === port.name) &&
            !wired.has(`${n.id}|${port.name}`) &&
            !exits.has(`${n.id}|${port.name}`),
        ));
    if (!fed) {
      add({
        code: 'boundary-port-unfed',
        severity: 'warning',
        message: `Subflow ${label(parent)} · ${port.name} is never taken: no inner step leaves through it`,
        path: [...base, 'subflow'],
        node: parent.id,
        port: port.name,
      });
    }
  }
  for (const n of inner) {
    for (const p of portsFor(n)) {
      if (p.direction !== 'out' || p.fail || p.name === 'cancelled') continue;
      const id = `${n.id}|${p.name}`;
      if (wired.has(id) || exits.has(id)) continue;
      add({
        code: 'inner-exit-unmapped',
        severity: 'warning',
        message: `${label(n)} · ${p.name} inside ${label(parent)} leads nowhere: its hosts never reach an outer port`,
        path: model.nodes.get(n.id)?.path ?? [],
        node: n.id,
        port: p.name,
      });
    }
  }
}

/** D-09: you cannot roll back a device you cannot reach. */
function checkUnreachableRollback(model: FlowModel, add: (f: Finding) => void): void {
  for (const { edge, path } of model.edges.values()) {
    if (edge?.from?.port !== 'unreachable') continue;
    const target = model.nodes.get(edge.to?.node)?.node;
    if (!isRollback(target)) continue;
    const source = model.nodes.get(edge.from.node)?.node;
    add({
      code: 'rollback-unreachable',
      severity: 'warning',
      message: `${label(source)} · unreachable goes to ${label(target)}: unreachable hosts cannot be rolled back; notify or retry instead`,
      path,
      edge: edge.id,
    });
  }
}

function checkDecisions(model: FlowModel, add: (f: Finding) => void): void {
  const seen = new Set<string>();
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
    const id = `${d.node}|${d.port}`;
    if (seen.has(id)) {
      add({
        code: 'duplicate-decision',
        severity: 'warning',
        message: `${label(entry.node)} · ${d.port} has more than one decision`,
        path: ['decisions', i],
        node: d.node,
      });
    }
    seen.add(id);
    if (!isFailPort(d.port)) {
      add({
        code: 'decision-not-fail',
        severity: 'info',
        message: `${label(entry.node)} · ${d.port} is not a fail port; open on purpose has no effect`,
        path: ['decisions', i],
        node: d.node,
      });
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
