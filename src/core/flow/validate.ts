// Semantic checks on a flow document. Findings carry YAML paths; the host maps them to ranges.

import type { Path } from '../yaml/parse';
import { fedByBubbling, levelTaken, untaken } from './bubbling';
import { idGaps, withIds } from './completeIds';
import { outputVar, registerName } from './dataNames';
import { enclosing, liftOf, resolveFrom, upstreamNodes } from './dataRefs';
import { acceptedAll, acceptedOf, checkWhat } from './decisions';
import { durationSeconds } from './duration';
import { conditionHasBraces, exprRefs, refsIn, singleRef, templated } from './jinja';
import { keywordReads } from './keywords';
import { formatOf } from './migrate';
import { buildModel, type FlowModel, ROOT } from './model';
import { openFailPorts } from './openPorts';
import { isRollback } from './patterns';
import { isFailPort, isPortLegal, LEGACY_PORTS, portDirection, portsFor } from './ports';
import { refDesign } from './refs';
import { rollingObstacles } from './rolling';
import type { SchemaIssue } from './schema';
import { planSegments } from './segments';
import { hasStatus, runtimeKind, statusFor } from './status';
import type { FlowDocument, FlowNode, PortRef, Ulid } from './types';
import { comparesWholeResult } from './until';
import { varNameProblem } from './varNames';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  path: Path;
  node?: Ulid;
  port?: string;
  edge?: Ulid;
  /** What the finding is about when a node can have several (a variable name): with the code and
   * the node, what an accepted problem names (AFD-51). */
  subject?: string;
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
  // A file written by hand may lack IDs (AFD-19): each gap is an error, and every other check runs
  // on the flow with the gaps filled, so the rest of the design is checked as usual.
  const gaps = idGaps(doc);
  const checked = gaps.length > 0 ? withIds(doc) : doc;
  const model = buildModel(checked);
  const findings: Finding[] = schemaIssues.map((i) => ({
    code: i.code ?? 'schema',
    severity: 'error',
    message: i.code ? i.message : `Schema: ${i.message}`,
    path: pointerToPath(i.pointer),
  }));
  const add = (f: Finding) => findings.push(f);
  for (const gap of gaps)
    add({
      code: gap.unresolved ? 'unknown-key' : 'missing-id',
      severity: 'error',
      message: gap.unresolved ? gap.message : `${gap.message}: Complete IDs adds it`,
      path: gap.path,
    });

  checkIdentity(model, add);
  checkEdges(model, add);
  checkNodes(model, add);
  checkReferences(model, add);
  checkDecisions(model, add);
  checkUnreachableRollback(model, add);
  checkTargets(model, add);
  checkAnnotations(model, add);
  checkVarNames(model, add);

  for (const open of openFailPorts(model)) {
    const entry = model.nodes.get(open.node);
    add({
      code: 'open-fail-port',
      severity: 'warning',
      // AFD-72: what happens to the hosts, and the two ways out, in plain words.
      message: `Open fail port: ${label(entry?.node)} · ${open.port} has nowhere to go, so its hosts fail the run. Wire a failure pattern to it, or Accept with Reason… to keep it open`,
      path: entry?.path ?? [],
      node: open.node,
      port: open.port,
    });
  }

  const ids = new Set(model.nodes.keys());
  for (const id of Object.keys(checked.layout ?? {})) {
    if (!ids.has(id)) {
      add({
        code: 'layout-orphan',
        severity: 'info',
        message: `Layout entry for a node that does not exist: ${id}`,
        path: ['layout', id],
      });
    }
  }
  // AFD-51: warnings accepted with a reason (format 2) stay out of the problems.
  const checks = acceptedAll(checked).filter((a) => a.area === 'check');
  const kept = checks.length
    ? findings.filter(
        (f) =>
          f.severity !== 'warning' ||
          !checks.some((a) => a.node === f.node && a.what === checkWhat(f.code, f.subject)),
      )
    : findings;
  return { model, findings: kept };
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
    // AFD-64: annotations share the ID space (the canvas draws them all), keys are per level.
    const annotationKeys = new Set<string>();
    level.annotations.forEach((a, i) => {
      if (!a) return;
      claim(a.id, [...level.annotationsPath, i, 'id']);
      if (!a.key) return;
      if (annotationKeys.has(a.key))
        add({
          code: 'duplicate-key',
          severity: 'error',
          message: `Duplicate annotation key "${a.key}" in this level`,
          path: [...level.annotationsPath, i, 'key'],
        });
      annotationKeys.add(a.key);
    });
  }
}

/** AFD-64: a Note on a node that is not on its level; annotations in a format 1 file. */
function checkAnnotations(model: FlowModel, add: (f: Finding) => void): void {
  const v2 = formatOf(model.doc) >= 2;
  for (const level of model.levels.values())
    level.annotations.forEach((a, i) => {
      if (!a || typeof a !== 'object') return;
      const path = [...level.annotationsPath, i];
      if (!v2 && i === 0)
        add({
          code: 'annotation-target-missing',
          severity: 'warning',
          message: 'Annotations are format 2: Upgrade Flow Format',
          path: level.annotationsPath,
        });
      if (a.on === undefined) return;
      const target = model.nodes.get(a.on);
      if ((a.kind ?? 'note') !== 'note' || !target || target.level !== level.id)
        add({
          code: 'annotation-target-missing',
          severity: 'warning',
          message:
            (a.kind ?? 'note') !== 'note'
              ? `${a.kind} "${a.key ?? a.id}" is on a node, which only a note can be: Detach it`
              : `Note "${a.key ?? a.id}" is on a node that is not on its level: Detach it, or attach it again`,
          path: [...path, 'on'],
          subject: a.id,
        });
    });
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

/**
 * AFD-160: inputs, outputs and registers become Ansible variables. Only the commands checked
 * their names, so a hand- or AI-written `retry-count` reached a play's vars and Ansible refused the
 * playbook; a host_list named `web-servers` read as `web - servers` in the start pattern.
 */
function checkVarNames(model: FlowModel, add: (f: Finding) => void): void {
  const check = (name: string, path: Path, node?: Ulid) => {
    const problem = varNameProblem(name);
    if (problem) add({ code: 'bad-name', severity: 'error', message: problem, path, node });
  };
  for (const name of Object.keys(model.doc.flow?.inputs ?? {}))
    check(name, ['flow', 'inputs', name]);
  for (const { node, path } of model.nodes.values()) {
    for (const side of ['inputs', 'outputs'] as const)
      for (const name of Object.keys(node[side] ?? {})) check(name, [...path, side, name], node.id);
    const register = node.impl?.register;
    if (typeof register === 'string' && register)
      check(register, [...path, 'impl', 'register'], node.id);
  }
}

function checkNodes(model: FlowModel, add: (f: Finding) => void): void {
  const v2 = formatOf(model.doc) >= 2;
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
    // AFD-54: undo and cancelled were never built; the upgrade removes them and their wires.
    for (const [i, port] of (node.ports ?? []).entries()) {
      if (!LEGACY_PORTS.has(port)) continue;
      add({
        code: 'legacy-port',
        severity: 'warning',
        message: `${label(node)}: the ${port} port was never built (${port === 'undo' ? 'Rollback wires explicit undo steps' : 'a cancelled job routes no host'}); ${formatOf(model.doc) >= 2 ? 'remove it and its wires' : 'Upgrade Flow Format removes it and its wires'}`,
        path: [...path, 'ports', i],
        node: node.id,
        port,
      });
    }
    if (
      node.settings?.inventory_target?.trim() &&
      node.type !== 'task' &&
      node.type !== 'subflow'
    ) {
      add({
        code: 'inventory-target-ignored',
        severity: 'warning',
        message: `${label(node)} (${node.type}) runs on the hosts that arrive: inventory_target applies to tasks and subflows only`,
        path: [...path, 'settings', 'inventory_target'],
        node: node.id,
      });
    }
    const hasInner = (node.subflow?.nodes?.length ?? 0) > 0;
    // Format 2 (AFD-52): the AWX template has one set of credentials and one environment.
    if (v2 && (node.settings?.credential || node.settings?.execution_environment))
      add({
        code: 'setting-on-flow',
        severity: 'warning',
        message: `${label(node)}: credential and execution environment belong to the flow in format 2 (its runtime)`,
        path: [...path, 'settings'],
        node: node.id,
      });
    // AFD-61: Re-import flags the steps whose source task is gone; it never deletes them.
    if (node.origin?.gone)
      add({
        code: 'import-gone',
        severity: 'warning',
        message: `${label(node)}: its task (${node.origin.task}) is no longer in the source: delete the step, or keep it as this flow's own`,
        path: [...path, 'origin'],
        node: node.id,
      });
    // AFD-60: a shared subflow is a copy; edits belong in its source flow.
    if (node.ref && refDesign(node) !== node.ref.design)
      add({
        code: 'shared-edited',
        severity: 'warning',
        message: `${label(node)} was changed here since version ${node.ref.version} of ${node.ref.from}: Update brings the source back over these edits, Unlink keeps them as this flow's own`,
        path: [...path, 'subflow'],
        node: node.id,
      });
    if (node.ref && !v2)
      add({
        code: 'shared-edited',
        severity: 'warning',
        message: `${label(node)}: shared subflows are format 2; Upgrade Flow Format`,
        path: [...path, 'ref'],
        node: node.id,
      });
    // AFD-55: a rolling subflow's steps run in one play; some steps need plays of their own.
    if (node.settings?.rolling !== undefined) {
      if (node.type !== 'subflow')
        add({
          code: 'rolling-unsupported',
          severity: 'warning',
          message: `${label(node)}: rolling batches the steps inside a subflow; on a ${node.type} it does nothing (use serial)`,
          path: [...path, 'settings', 'rolling'],
          node: node.id,
        });
      else
        for (const o of rollingObstacles(model, node))
          add({
            code: 'rolling-unsupported',
            severity: 'error',
            message: `${label(node)} cannot roll: ${label(o.node)}: ${o.why}. Its steps run play by play`,
            path: [...path, 'settings', 'rolling'],
            node: o.node.id,
          });
    }
    // Format 2 (AFD-52): `handler` is called purpose, so it is not read as an Ansible handler.
    if (v2 && node.handler !== undefined)
      add({
        code: 'renamed-field',
        severity: 'warning',
        message: `${label(node)}: handler is called purpose in format 2`,
        path: [...path, 'handler'],
        node: node.id,
      });
    // Format 2 (AFD-52): become_user is a setting, which a subflow passes to its steps.
    if (v2 && node.impl?.keywords && 'become_user' in node.impl.keywords)
      add({
        code: 'keyword-is-setting',
        severity: 'warning',
        message: `${label(node)}: become_user is a setting in format 2 (Execution › Privilege)`,
        path: [...path, 'impl', 'keywords', 'become_user'],
        node: node.id,
      });
    // Format 2 (AFD-50): the status is the one the content gives; a hand edit can still disagree.
    if (v2 && hasStatus(node)) {
      const have = node.status ?? 'draft';
      const want = statusFor(model.doc, node);
      if (have === 'tested' && !node.tested)
        add({
          code: 'tested-without-record',
          severity: 'warning',
          message: `${label(node)} is tested but has no record of the run or the reason`,
          path: [...path, 'status'],
          node: node.id,
        });
      else if (have !== want)
        add({
          code: 'status-out-of-step',
          severity: 'info',
          message: `${label(node)} is ${have}, but what it has makes it ${want}`,
          path: [...path, 'status'],
          node: node.id,
        });
    }
    if (
      !v2 &&
      (node.status === 'implemented' || node.status === 'tested') &&
      !node.impl &&
      !hasInner
    ) {
      add({
        code: 'status-overclaim',
        severity: 'warning',
        message: `${label(node)} is ${node.status} but has no implementation binding`,
        path: [...path, 'status'],
        node: node.id,
      });
    }
    if (
      !v2 &&
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
  // AFD-103: a timeout codegen cannot read is left out of the task without a word. AFD-112: a
  // template is read at run time (an approval's: checkTimingInputs).
  const timeout = node.settings?.timeout;
  if (
    !hasInner &&
    timeout !== undefined &&
    String(timeout).trim() &&
    !templated(timeout) &&
    durationSeconds(timeout) === undefined
  ) {
    add({
      code: 'timeout-unreadable',
      severity: 'warning',
      message: `${label(node)} timeout "${timeout}" is not a duration (30s, 15m, 1h30m), so the step runs without one`,
      path: [...path, 'settings', 'timeout'],
      node: node.id,
    });
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
  // A list default that is a string (default: edge) is joined letter by letter (AFD-27).
  for (const [name, f] of Object.entries(model.doc.flow?.inputs ?? {}))
    if ((f?.type === 'host_list' || f?.type === 'list') && typeof f.default === 'string')
      add({
        code: 'input-default-type',
        severity: 'warning',
        message: `Flow input ${name} is a ${f.type} but its default is the string "${f.default}": write it as a list, [${f.default}]`,
        path: ['flow', 'inputs', name, 'default'],
      });
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

/** Module parameters Ansible evaluates as bare expressions, by module short name. */
const BARE_PARAMS: Record<string, readonly string[]> = { assert: ['that'], debug: ['var'] };

export function bareParams(impl: NonNullable<FlowNode['impl']>): unknown[] {
  if (impl.kind !== 'module') return [];
  const short = impl.ref.replace(/^ansible\.(builtin|legacy)\./, '');
  return (BARE_PARAMS[short] ?? []).map((k) => impl.params?.[k]).filter((v) => v !== undefined);
}

/**
 * Where a name a node reads could come from, as the fix (AFD-21): the enclosing subflow's input, an
 * upstream output, or an output of a step inside an upstream subflow (which the tools lift).
 */
function hintFor(model: FlowModel, node: FlowNode, level: string, name: string): string {
  for (const sub of enclosing(model, level))
    if (sub.inputs && name in sub.inputs)
      return `; subflow ${sub.key} has it as an input: add input ${name} (from: ${sub.key}.${name})`;
  const upstream = upstreamNodes(model, node.id);
  for (const up of upstream)
    if (up.outputs && name in up.outputs) return `; add input ${name} (from: ${up.key}.${name})`;
  const inside = (sub: FlowNode, path: string): string | undefined => {
    for (const step of sub.subflow?.nodes ?? []) {
      if (!step?.key) continue;
      if (step.outputs && name in step.outputs) return `${path}/${step.key}`;
      const deeper = step.subflow ? inside(step, `${path}/${step.key}`) : undefined;
      if (deeper) return deeper;
    }
    return undefined;
  };
  for (const up of upstream) {
    const at = up.type === 'subflow' ? inside(up, up.key) : undefined;
    if (at)
      return `; ${at} sets it: add input ${name} from ${at}.${name} with the AI tools or the @ picker, which lift it to ${up.key}`;
  }
  return '';
}

/**
 * Binding parameters read node inputs (chips, D-26). A read of anything else works only by luck
 * (a flow extra var, another node's fact), and the design does not show the data dependency.
 * Bare expressions (assert `that`) are read too (AFD-21).
 */
function checkBindingVars(
  model: FlowModel,
  node: FlowNode,
  level: string,
  path: Path,
  flowInputs: Set<string>,
  add: (f: Finding) => void,
): void {
  const impl = node.impl;
  if (!impl) return;
  const inputs = new Set(Object.keys(node.inputs ?? {}));
  // Task keywords read inputs too (AFD-26); loop variables and task vars are their own names, and
  // changed_when / failed_when may read the step's result.
  const kw = keywordReads(impl);
  const known = new Set([...kw.own, ...(impl.kind === 'module' ? [registerName(node)] : [])]);
  const reads: [Set<string>, Path][] = [
    [
      new Set([...refsIn(impl.params ?? {}), ...exprRefs(bareParams(impl))]),
      [...path, 'impl', 'params'],
    ],
    [new Set([...kw.templated, ...kw.bare]), [...path, 'impl', 'keywords']],
  ];
  const reported = new Set<string>();
  for (const [read, where] of reads)
    for (const name of read) {
      if (inputs.has(name) || known.has(name) || MAGIC_VARS.test(name) || reported.has(name))
        continue;
      reported.add(name);
      const flow = flowInputs.has(name);
      add({
        code: 'binding-unknown-var',
        severity: flow ? 'info' : 'warning',
        message: flow
          ? `${label(node)} reads flow input "${name}" directly: add it as a node input (from: flow.${name}) to show the dependency`
          : `${label(node)} reads "${name}", which is not an input of this node${hintFor(model, node, level, name)}`,
        path: where,
        node: node.id,
        subject: name,
      });
    }
  const keywords = impl.keywords && typeof impl.keywords === 'object' ? impl.keywords : undefined;
  if (keywords && Object.keys(keywords).length > 0 && impl.kind === 'playbook')
    add({
      code: 'keyword-ignored',
      severity: 'warning',
      message: `${label(node)} runs a playbook: task keywords cannot apply to import_playbook, so they are ignored`,
      path: [...path, 'impl', 'keywords'],
      node: node.id,
    });
  else if (keywords?.vars !== undefined && impl.kind === 'role')
    add({
      code: 'keyword-ignored',
      severity: 'warning',
      message: `${label(node)} runs a role: role variables belong in params, so keywords.vars is ignored`,
      path: [...path, 'impl', 'keywords', 'vars'],
      node: node.id,
    });
}

/** Decision conditions and `until` read node inputs too (AFD-21); `until` also the step's result. */
function checkConditions(
  model: FlowModel,
  node: FlowNode,
  level: string,
  path: Path,
  flowInputs: Set<string>,
  add: (f: Finding) => void,
): void {
  const inputs = new Set(Object.keys(node.inputs ?? {}));
  const check = (expr: string, where: Path, what: string, result?: string) => {
    for (const name of exprRefs(expr)) {
      if (inputs.has(name) || name === result || MAGIC_VARS.test(name)) continue;
      const flow = flowInputs.has(name);
      add({
        code: 'condition-unknown-var',
        severity: flow ? 'info' : 'warning',
        message: flow
          ? `${label(node)} ${what} reads flow input "${name}" directly: add it as a node input (from: flow.${name}) to show the dependency`
          : `${label(node)} ${what} reads "${name}", which is not ${result ? `its result (${result}) or ` : ''}an input of this node${hintFor(model, node, level, name)}`,
        path: where,
        node: node.id,
      });
    }
  };
  if (node.type === 'decision' && typeof node.condition === 'string') {
    check(node.condition, [...path, 'condition'], 'condition');
    // AFD-146: the generator puts the condition inside a Jinja expression of its own.
    if (conditionHasBraces(node.condition))
      add({
        code: 'condition-braces',
        severity: 'error',
        message: `${label(node)} condition has {{ }} or {% %} inside it: write it as a when: is written, without them (x == 1, not {{ x }} == 1)`,
        path: [...path, 'condition'],
        node: node.id,
      });
  }
  const until = node.settings?.until;
  if (typeof until !== 'string' || !until.trim()) return;
  if (node.impl?.kind === 'role' || node.impl?.kind === 'playbook')
    add({
      code: 'until-not-module',
      severity: 'warning',
      message: `${label(node)} runs a ${node.impl.kind}: until applies to a module step only, so it is ignored`,
      path: [...path, 'settings', 'until'],
      node: node.id,
    });
  else {
    const result = registerName(node);
    check(until, [...path, 'settings', 'until'], 'until', result);
    // AFD-103 (round 3: R2): the whole result is a dict, so comparing it with a value never holds.
    if (comparesWholeResult(until, result))
      add({
        code: 'until-whole-result',
        severity: 'warning',
        message: `${label(node)} until compares the whole result ${result} with a value, so it never holds: test a field of it, like ${result}.stdout or ${result}.rc`,
        path: [...path, 'settings', 'until'],
        node: node.id,
      });
  }
}

/** The Timing settings a step may take at run time (AFD-112, round 4: Q4). */
const RUN_TIME_TIMING = ['retries', 'delay', 'timeout'] as const;

/**
 * AFD-112 (round 4: Q4): Retries, Delay and Timeout given at run time read the step's inputs, as
 * Until does: a name that is no input is not there when Ansible renders the template, and an
 * input that holds no number fails the task.
 */
function checkTimingInputs(
  model: FlowModel,
  node: FlowNode,
  level: string,
  path: Path,
  flowInputs: Set<string>,
  add: (f: Finding) => void,
): void {
  if (node.type === 'approval') {
    const timeout = node.settings?.timeout;
    if (templated(timeout))
      add({
        code: 'timeout-unreadable',
        severity: 'warning',
        message: `${label(node)} timeout "${timeout}" is given at run time, but an AWX approval needs a fixed duration (30m, 4h), so it gets none`,
        path: [...path, 'settings', 'timeout'],
        node: node.id,
      });
    return;
  }
  const inputs = node.inputs ?? {};
  for (const key of RUN_TIME_TIMING) {
    const value = node.settings?.[key];
    if (!templated(value)) continue;
    const where = [...path, 'settings', key];
    for (const name of exprRefs(value)) {
      if (name in inputs || MAGIC_VARS.test(name)) continue;
      const flow = flowInputs.has(name);
      add({
        code: 'setting-unknown-var',
        severity: flow ? 'info' : 'warning',
        message: flow
          ? `${label(node)} ${key} reads flow input "${name}" directly: add it as a node input (from: flow.${name}) to show the dependency`
          : `${label(node)} ${key} reads "${name}", which is not an input of this node${hintFor(model, node, level, name)}`,
        path: where,
        node: node.id,
        subject: name,
      });
    }
    const one = singleRef(value);
    const type = one ? inputs[one]?.type : undefined;
    if (type && ['boolean', 'list', 'dict', 'host_list'].includes(type))
      add({
        code: 'setting-input-type',
        severity: 'warning',
        message: `${label(node)} ${key} reads ${one}, a ${type.replace('_', ' ')}: Ansible needs a whole number${key === 'retries' ? '' : ' of seconds'} there, so the task fails`,
        path: where,
        node: node.id,
        subject: one,
      });
  }
}

/**
 * AFD-106 (round 3: R7): a step input that nothing feeds. The participant typed a step's register
 * name into a later step; that step got an input with no `from`, and the flow validated clean while
 * the value never passed the designer's way. A default feeds it; a host list is the targets'; a
 * subflow's input feeds its inner steps.
 */
function checkUnfed(
  model: FlowModel,
  node: FlowNode,
  level: string,
  path: Path,
  name: string,
  flowInputs: Set<string>,
  add: (f: Finding) => void,
): void {
  if (node.type !== 'task' && node.type !== 'approval') return;
  const field = node.inputs?.[name];
  if (!field || field.default !== undefined || field.type === 'host_list') return;
  const flow = flowInputs.has(name);
  const registers = upstreamNodes(model, node.id).find(
    (up) => up.impl?.kind === 'module' && registerName(up) === name,
  );
  const hint = flow
    ? `: flow input "${name}" has the same name: set from: flow.${name}`
    : registers
      ? `: ${label(registers)} registers ${name}: make it an output there (Expose as node output) and pick it with @`
      : hintFor(model, node, level, name);
  add({
    code: 'input-unfed',
    severity: flow ? 'info' : 'warning',
    message: `${label(node)} inputs.${name}: nothing gives it a value (no from, no default)${hint}`,
    path: [...path, 'inputs', name],
    node: node.id,
    subject: name,
  });
}

/** A subflow output without from lifts the inner output of the same name (AFD-21). */
function checkLifts(node: FlowNode, path: Path, add: (f: Finding) => void): void {
  if (node.type !== 'subflow' || !node.subflow?.nodes?.length) return;
  for (const [name, field] of Object.entries(node.outputs ?? {})) {
    if (field?.from) continue;
    const lift = liftOf(node, name);
    if (lift && 'inner' in lift) continue;
    add({
      code: 'subflow-output-unset',
      severity: 'warning',
      message: lift
        ? `Subflow ${label(node)} output ${name}: ${lift.ambiguous.join(' and ')} all have it; name one in from (${lift.ambiguous[0]}.${name})`
        : `Subflow ${label(node)} output ${name}: no inner step has an output ${name}, so nothing sets it; name the inner output it lifts in from (<step>.<output>)`,
      path: [...path, 'outputs', name],
      node: node.id,
    });
  }
}

function checkReferences(model: FlowModel, add: (f: Finding) => void): void {
  const flowInputs = new Set(Object.keys(model.doc.flow?.inputs ?? {}));
  for (const { node, path, level } of model.nodes.values()) {
    for (const side of ['inputs', 'outputs'] as const) {
      for (const [name, field] of Object.entries(node[side] ?? {})) {
        const from = field?.from;
        if (typeof from !== 'string' || !from) {
          if (side === 'inputs') checkUnfed(model, node, level, path, name, flowInputs, add);
          continue;
        }
        const src = resolveFrom(model, node, level, side, from);
        if (src.kind === 'output' && side === 'inputs') {
          const at: Path = [...path, side, name, 'from'];
          checkCollision(model, node, src.node, src.name, from, at, name, add);
          if (field.default === undefined && !guarded(node, name))
            checkProducerRuns(model, node, src.node, from, at, name, add);
        }
        if (src.kind !== 'unresolved') continue;
        add({
          code: 'from-unresolved',
          severity: 'warning',
          message: `${label(node)} ${side}.${name}: "${from}" ${src.why}`,
          path: [...path, side, name, 'from'],
          node: node.id,
        });
      }
    }
    checkLifts(node, path, add);
  }
  checkTopLevelOutcomes(model, add);
  for (const { node, path, level } of model.nodes.values()) {
    checkBindingVars(model, node, level, path, flowInputs, add);
    checkConditions(model, node, level, path, flowInputs, add);
    checkTimingInputs(model, node, level, path, flowInputs, add);
  }
  const runtime = model.doc.flow?.runtime?.kind;
  const v2 = formatOf(model.doc) >= 2;
  // AWX workflows split at top-level approvals (AFD-11, ADR-0016).
  const plan = planSegments(model);
  for (const p of plan?.problems ?? [])
    add({
      code: 'awx-segments',
      severity: runtime === 'awx_workflow' ? 'error' : 'warning',
      message: `${p.message}. Local and skeleton runs approve automatically`,
      path: p.node ? (model.nodes.get(p.node)?.path ?? []) : ['nodes'],
      node: p.node,
    });
  if (v2 && runtime)
    add({
      code: 'runtime-kind',
      severity: 'info',
      message: `In format 2 the flow's runtime is worked out from the flow (it is ${runtimeKind(model)}): runtime.kind can go`,
      path: ['flow', 'runtime', 'kind'],
    });
  else if (runtime && runtime !== 'ansible_playbook') {
    const split = !!plan && plan.problems.length === 0 && plan.segments.length > 0;
    const inferred = split ? 'awx_workflow' : 'awx_job';
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
  const taken = levelTaken(edges, parent);
  for (const port of portsFor(parent)) {
    if (port.direction !== 'out' || port.name === 'cancelled') continue;
    const fed =
      (boundary?.outputs?.[port.name] ?? []).length > 0 ||
      fedByBubbling(parent, port.name, inner, taken);
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
      if (!untaken(n.id, p.name, taken)) continue;
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

/**
 * An outcome on the top level that leads nowhere strands its hosts, as an unmapped inner exit
 * does inside a subflow (AFD-31: warned at every level).
 */
function checkTopLevelOutcomes(model: FlowModel, add: (f: Finding) => void): void {
  const level = model.levels.get(ROOT);
  if (!level) return;
  const wired = new Set(level.edges.map((e) => `${e?.from?.node}|${e?.from?.port}`));
  for (const n of level.nodes) {
    if (!n?.id) continue;
    for (const p of portsFor(n)) {
      if (p.direction !== 'out' || p.fail || p.name === 'cancelled') continue;
      if (wired.has(`${n.id}|${p.name}`)) continue;
      add({
        code: 'success-port-unwired',
        severity: 'warning',
        message: `${label(n)} · ${p.name} leads nowhere: its hosts stop there without reaching an end node`,
        path: model.nodes.get(n.id)?.path ?? [],
        node: n.id,
        port: p.name,
      });
    }
  }
}

/**
 * Every use of an input in the binding goes through `| default(…)`, as the handlers an import
 * writes do (`(x_result | default({})) is changed`): a missing value is expected there.
 */
function guarded(node: FlowNode, input: string): boolean {
  const text = JSON.stringify([node.impl?.params ?? {}, node.impl?.keywords ?? {}]);
  const uses = text.match(new RegExp(`\\b${input}\\b`, 'g'))?.length ?? 0;
  const safe = text.match(new RegExp(`\\b${input}\\s*\\|\\s*default\\b`, 'g'))?.length ?? 0;
  return uses > 0 && uses === safe;
}

/** The step that really sets a node's output: a subflow output follows its lift inward. */
function producerOf(node: FlowNode, output: string, depth = 0): FlowNode {
  if (node.type !== 'subflow' || depth > 16) return node;
  const lift = liftOf(node, output);
  return lift && 'inner' in lift ? producerOf(lift.inner, lift.output, depth + 1) : node;
}

/**
 * The host variables steps write, by step: every module step's register, and the variables
 * outputs land in (a register, or the step's own captured variable, AFD-53).
 */
function hostVariables(model: FlowModel): Map<string, Set<Ulid>> {
  const vars = new Map<string, Set<Ulid>>();
  const add = (root: string, id: Ulid) => vars.set(root, (vars.get(root) ?? new Set()).add(id));
  for (const { node } of model.nodes.values()) {
    if (node.type === 'subflow') continue;
    if (node.impl?.kind === 'module') add(registerName(node), node.id);
    for (const out of Object.keys(node.outputs ?? {}))
      add(outputVar(model, node, out).split('.')[0] ?? out, node.id);
  }
  return vars;
}

const variablesOf = new WeakMap<FlowModel, Map<string, Set<Ulid>>>();

/**
 * `from: a.result` reads a host variable (AFD-31). Outputs other than registers are captured into
 * the step's own variable (AFD-53); a register is named by the flow, so another step registering the
 * same name, or a flow input (an extra var) of that name, changes what the reader gets: an error.
 */
function checkCollision(
  model: FlowModel,
  reader: FlowNode,
  target: FlowNode,
  output: string,
  from: string,
  path: Path,
  input: string,
  add: (f: Finding) => void,
): void {
  const producer = producerOf(target, output);
  const root = outputVar(model, target, output).split('.')[0] ?? output;
  let vars = variablesOf.get(model);
  if (!vars) {
    vars = hostVariables(model);
    variablesOf.set(model, vars);
  }
  const others = [...(vars.get(root) ?? [])]
    .filter((id) => id !== producer.id)
    .map((id) => label(model.nodes.get(id)?.node));
  const flowInput = root in (model.doc.flow?.inputs ?? {});
  if (others.length === 0 && !flowInput) return;
  const who = [...(flowInput ? [`the flow input ${root}`] : []), ...others].join(', ');
  add({
    code: 'register-collision',
    severity: 'error',
    message: `${label(reader)} inputs.${input}: "${from}" reads the register ${root}, which ${who} also set${others.length + (flowInput ? 1 : 0) > 1 ? '' : 's'}: it reads ${flowInput ? 'the flow input' : 'whichever ran last'}`,
    path,
    node: reader.id,
  });
}

/** The nodes reachable on a level from `start` over its wires, never passing `skip`. */
function reachable(edges: { from: PortRef; to: PortRef }[], start: Ulid[], skip?: Ulid): Set<Ulid> {
  const seen = new Set<Ulid>(start.filter((s) => s !== skip));
  const queue = [...seen];
  while (queue.length > 0) {
    const at = queue.shift();
    for (const e of edges) {
      const to = e?.to?.node;
      if (e?.from?.node !== at || !to || to === skip || seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}

/**
 * The step a `from:` reads must have run, and succeeded, for every host that gets here (AFD-31):
 * on its level it lies on every path from the entry to the reader (or the subflow holding it), and
 * no path from its fail ports leads there.
 */
function checkProducerRuns(
  model: FlowModel,
  reader: FlowNode,
  producer: FlowNode,
  from: string,
  path: Path,
  input: string,
  add: (f: Finding) => void,
): void {
  const where = model.nodes.get(producer.id)?.level;
  const level = where ? model.levels.get(where) : undefined;
  if (!level) return;
  // The reader, or the subflow around it, on the producer's level.
  let at = model.nodes.get(reader.id);
  while (at && at.level !== where) at = model.nodes.get(at.level);
  if (!at || at.node.id === producer.id) return;
  const target = at.node.id;
  const parent = level.parent ? model.nodes.get(level.parent)?.node : undefined;
  const entries =
    level.id === ROOT
      ? level.nodes.filter((n) => n?.type === 'start').map((n) => n.id)
      : parent?.subflow?.boundary?.in
        ? [parent.subflow.boundary.in]
        : [];
  const say = (why: string) =>
    add({
      code: 'ref-may-be-undefined',
      severity: 'warning',
      message: `${label(reader)} inputs.${input}: "${from}" ${why}: those hosts arrive without the value`,
      path,
      node: reader.id,
    });
  if (entries.length > 0 && reachable(level.edges, entries, producer.id).has(target)) {
    say(`is set by ${label(producer)}, which some paths to here do not run`);
    return;
  }
  const failed = level.edges
    .filter((e) => e?.from?.node === producer.id && isFailPort(e.from.port))
    .map((e) => e.to.node);
  if (failed.length > 0 && reachable(level.edges, failed).has(target))
    say(`is set by ${label(producer)}, and hosts that fail in it still get here`);
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

/**
 * Decisions in either format (AFD-51): each names something that exists and says why. Ports also
 * get the AFD-15 checks (a fail port, one decision, not wired).
 */
function checkDecisions(model: FlowModel, add: (f: Finding) => void): void {
  const seen = new Set<string>();
  (model.doc.decisions ?? []).forEach((d, i) => {
    const a = acceptedOf(d, i);
    if (!a) return;
    const path: Path = ['decisions', i];
    const entry = a.node ? model.nodes.get(a.node) : undefined;
    const what =
      a.area === 'port'
        ? 'Open-on-purpose decision'
        : a.area === 'drift'
          ? 'Ignored drift item'
          : a.area === 'lens'
            ? `Accepted finding ${a.what}`
            : `Accepted problem ${a.what}`;
    if (a.node && !entry) {
      add({
        code: 'stale-decision',
        severity: 'warning',
        message: `${what} refers to a node that does not exist: ${a.node}`,
        path,
      });
      return;
    }
    if (a.area === 'port') {
      if (!entry || !portsFor(entry.node).some((p) => p.name === a.what)) {
        add({
          code: 'stale-decision',
          severity: 'warning',
          message: `Decision refers to a port that does not exist: ${a.node} · ${a.what}`,
          path,
        });
        return;
      }
      const id = `${a.node}|${a.what}`;
      if (seen.has(id))
        add({
          code: 'duplicate-decision',
          severity: 'warning',
          message: `${label(entry.node)} · ${a.what} has more than one decision`,
          path,
          node: a.node,
        });
      seen.add(id);
      if (!isFailPort(a.what))
        add({
          code: 'decision-not-fail',
          severity: 'info',
          message: `${label(entry.node)} · ${a.what} is not a fail port; open on purpose has no effect`,
          path,
          node: a.node,
        });
      const edges = model.levels.get(entry.level)?.edges ?? [];
      if (edges.some((e) => e?.from?.node === a.node && e.from.port === a.what))
        add({
          code: 'decision-on-connected',
          severity: 'info',
          message: `${label(entry.node)} · ${a.what} is wired; its open-on-purpose decision has no effect`,
          path,
          node: a.node,
        });
    }
    if (!a.reason?.trim())
      add({
        code: 'decision-no-reason',
        severity: 'warning',
        message:
          a.area === 'port' && entry
            ? `Open-on-purpose decision for ${label(entry.node)} · ${a.what} has no reason`
            : `${what}${entry ? ` for ${label(entry.node)}` : ''} has no reason`,
        path,
        ...(a.node ? { node: a.node } : {}),
      });
  });
}
