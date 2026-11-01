// Node lifecycle (AFD-31, AFD-50): one rule for every writer, applied by planCommand to every node
// a command changes and to the subflows around it. A node's status follows what it has:
// - a step (a task, or a subflow without steps of its own): a binding makes it implemented, inputs
//   or outputs specified, else draft;
// - a control node: implemented once complete (a decision needs its condition; approval, parallel
//   and join compile as they are), else as a step;
// - a subflow with steps: the lowest status of its steps;
// - tested: only on implemented content, set by a passing run or by hand with a reason. Format 2
//   keeps the evidence on the node (`tested: {run, flow_version, commit}` or `{reason, by, at}`);
//   format 1 keeps the status and, by hand, its AFD-44 decision.
// A tested node whose design changes drops back to implemented (decision 15, semantic.ts).
// Format 1 files keep the rule they had (AFD-31): statuses set by hand, bind → implemented, unbind
// → specified; Upgrade Flow Format brings their statuses in line once (AFD-49 step).
import { formatOf } from './format';
import type { FlowModel } from './model';
import { planSegments } from './segments';
import { type FlowDocument, type FlowNode, NODE_STATUSES, type NodeStatus } from './types';

const rank = (s: NodeStatus) => NODE_STATUSES.indexOf(s);

/**
 * Format 1 (AFD-31): the status after a binding change. A bound node is implemented (a tested one
 * keeps its status when the binding did not change); an unbound one goes back to specified.
 */
export function statusAfterBinding(
  current: NodeStatus,
  bound: boolean,
  unchanged: boolean,
): NodeStatus {
  if (bound) return current === 'tested' && unchanged ? 'tested' : 'implemented';
  return current === 'implemented' || current === 'tested' ? 'specified' : current;
}

/** Start and end nodes have no lifecycle. */
export function hasStatus(node: Pick<FlowNode, 'type'>): boolean {
  return node.type !== 'start' && node.type !== 'end';
}

/** The steps of a subflow that count for its status (start and end do not). */
function steps(node: FlowNode): FlowNode[] {
  return (node.subflow?.nodes ?? []).filter(
    (n): n is FlowNode => !!n && typeof n === 'object' && hasStatus(n),
  );
}

/** Whether a control node compiles as it is. */
function complete(node: FlowNode): boolean {
  if (node.type === 'decision') return !!node.condition?.trim();
  return node.type === 'approval' || node.type === 'parallel' || node.type === 'join';
}

/** What the node's content makes it, tested aside. A subflow with steps: their lowest status. */
export function contentStatus(node: FlowNode): NodeStatus {
  const inner = node.type === 'subflow' ? steps(node) : [];
  if (inner.length > 0) return lowest(inner.map((n) => n.status ?? 'draft'));
  if (node.impl || complete(node)) return 'implemented';
  const contract = Object.keys(node.inputs ?? {}).length + Object.keys(node.outputs ?? {}).length;
  return contract > 0 ? 'specified' : 'draft';
}

export function lowest(statuses: readonly NodeStatus[]): NodeStatus {
  return statuses.reduce<NodeStatus>((a, s) => (rank(s) < rank(a) ? s : a), 'tested');
}

/** Whether the node has the evidence `tested` needs in this format. */
export function testedEvidence(doc: Pick<FlowDocument, 'schema_version'>, node: FlowNode): boolean {
  return formatOf(doc) < 2 || !!node.tested;
}

/**
 * The status the rule gives the node now: its content's, or tested when it was tested and the
 * content is implemented (with the record format 2 asks for). A subflow with steps is tested only
 * when all its steps are.
 */
export function statusFor(doc: Pick<FlowDocument, 'schema_version'>, node: FlowNode): NodeStatus {
  const content = contentStatus(node);
  if (steps(node).length > 0) return content;
  return node.status === 'tested' && content === 'implemented' && testedEvidence(doc, node)
    ? 'tested'
    : content;
}

/** Whether Mark Tested… applies: implemented content, not yet tested, not a subflow with steps. */
export function canMarkTested(doc: Pick<FlowDocument, 'schema_version'>, node: FlowNode): boolean {
  return (
    hasStatus(node) &&
    steps(node).length === 0 &&
    contentStatus(node) === 'implemented' &&
    statusFor(doc, node) !== 'tested'
  );
}

/** What the node lacks for its next stage, in the words the Details panel shows. */
export function nextStep(
  doc: Pick<FlowDocument, 'schema_version'>,
  node: FlowNode,
): string | undefined {
  if (!hasStatus(node)) return undefined;
  if (steps(node).length > 0)
    return statusFor(doc, node) === 'tested'
      ? undefined
      : 'A subflow is as far as its least finished step';
  switch (statusFor(doc, node)) {
    case 'draft':
      return node.type === 'decision'
        ? 'Write the condition to make it implemented'
        : 'Define at least one input or output to make it specified';
    case 'specified':
      return node.type === 'decision'
        ? 'Write the condition to make it implemented'
        : 'Bind a module, role or playbook to make it implemented';
    case 'implemented':
      return 'A passing real run of this flow version makes it tested (or Mark Tested… with a reason)';
    default:
      return undefined;
  }
}

/**
 * Where the flow runs (AFD-50): format 1 stores `runtime.kind`; format 2 derives it, AWX when the
 * flow names a template (a workflow when it splits at approvals, else a job), else a playbook run.
 */
export function runtimeKind(
  model: FlowModel,
): 'awx_workflow' | 'awx_job' | 'ansible_playbook' | undefined {
  const runtime = model.doc.flow?.runtime;
  if (formatOf(model.doc) < 2) return runtime?.kind;
  if (!runtime?.template) return 'ansible_playbook';
  const plan = planSegments(model);
  return plan && plan.problems.length === 0 && plan.segments.length > 0
    ? 'awx_workflow'
    : 'awx_job';
}

/**
 * A whole document settled by the rule, deepest first (AFD-50): for writers that build a format 2
 * flow in one go (the importers), so it reads the same as one the designer edited.
 */
export function settleDocument<T extends FlowDocument>(doc: T): T {
  if (formatOf(doc) < 2) return doc;
  const settled = structuredClone(doc);
  const visit = (nodes: FlowNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (!node || typeof node !== 'object') continue;
      visit(node.subflow?.nodes);
      if (!hasStatus(node)) continue;
      const status = statusFor(settled, node);
      if (node.status === status) continue;
      if (node.status !== undefined) node.status = status;
      else {
        // A new key goes where the designer writes it, after the title (NODE_ORDER).
        const entries = Object.entries(node);
        const at = entries.findIndex(([k]) => k === 'title') + 1;
        entries.splice(at, 0, ['status', status]);
        for (const k of Object.keys(node)) delete (node as unknown as Record<string, unknown>)[k];
        Object.assign(node, Object.fromEntries(entries));
      }
    }
  };
  visit(settled.nodes);
  return settled;
}
