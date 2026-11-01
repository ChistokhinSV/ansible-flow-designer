// Flow format versions (AFD-49, ADR-0025): `schema_version` 1 stays readable forever, and an
// explicit upgrade moves a file to the current format. Nothing is written on open; the upgrade
// runs only when someone asks for it (Upgrade Flow Format, the `upgrade_format` op), as one YAML
// transaction, so it is one edit and one undo step and the bytes outside the changed nodes stay.
// Each step takes a file from one version to the next; tickets that change the format add theirs.
import { deleteKey, removeItem, setIn } from '../yaml/ops';
import type { YamlTransaction } from '../yaml/transaction';
import { awxLift } from './awxSettings';
import { acceptedAll, upgradedItem } from './decisions';
import { CURRENT_FORMAT, FormatError, formatOf, keysAfter } from './format';
import { buildModel } from './model';
import { contentStatus, hasStatus, lowest } from './status';
import type { FlowDocument, FlowNode, NodeStatus, TestedRecord, Ulid } from './types';
import { walkNodes } from './walk';

export { CURRENT_FORMAT, FormatError, formatOf, requireFormat } from './format';

export interface MigrationStep {
  /** The version this step reads; it leaves the file at `from + 1`. */
  from: number;
  /** What the step changes in this document, in a few words each; empty when nothing. */
  notes(doc: FlowDocument): string[];
  /** The step's own edits; the version number is set by `migrate` after it. */
  apply(tx: YamlTransaction): void;
}

/** The AFD-44 record of `tested` by hand in format 1. */
const testedFinding = (node: Ulid) => `status:tested|${node}`;

interface StatusPlan {
  /** Nodes whose status changes, with the new one. */
  statuses: Map<Ulid, NodeStatus>;
  /** Tested nodes and the record they keep. */
  records: Map<Ulid, TestedRecord>;
  /** Format 1 decisions that become records (their finding ids). */
  decisions: Set<string>;
}

/**
 * AFD-50: what format 2 makes of format 1 statuses. Each node takes the status its content gives,
 * deepest first, so a subflow sees its steps' new statuses. A tested node stays tested when its
 * content is implemented and keeps why: the reason given by hand (AFD-44), else a note that it
 * was tested before runs were recorded.
 */
function planStatuses(doc: FlowDocument): StatusPlan {
  const plan: StatusPlan = { statuses: new Map(), records: new Map(), decisions: new Set() };
  const byHand = new Map(
    (doc.decisions ?? [])
      .filter((d) => d?.kind === 'finding_accepted')
      .map((d) => [(d as { finding: string }).finding, d as { reason?: string; by?: string }]),
  );
  // Deepest first: walkNodes lists a subflow before its steps, so go backwards over levels.
  const work = structuredClone(doc.nodes);
  const nodes = [...walkNodes(work)].reverse();
  for (const node of nodes) {
    // A file written by key gets its IDs first (Complete IDs); the upgrade needs them.
    if (!hasStatus(node) || !node.id) continue;
    const steps = (node.subflow?.nodes ?? []).filter((n): n is FlowNode => !!n && hasStatus(n));
    const content =
      steps.length > 0 ? lowest(steps.map((n) => n.status ?? 'draft')) : contentStatus(node);
    const was = node.status ?? 'draft';
    const want =
      was === 'tested' && content === 'implemented' && steps.length === 0 ? 'tested' : content;
    if (want !== was) plan.statuses.set(node.id, want);
    node.status = want;
    if (want === 'tested') {
      const hand = byHand.get(testedFinding(node.id));
      plan.records.set(
        node.id,
        hand
          ? { reason: hand.reason ?? 'Marked tested by hand', ...(hand.by ? { by: hand.by } : {}) }
          : {
              reason: 'Tested in flow format 1, before runs were recorded',
              flow_version: doc.flow.version,
            },
      );
    }
    if (byHand.has(testedFinding(node.id))) plan.decisions.add(testedFinding(node.id));
  }
  return plan;
}

const statusStep: MigrationStep = {
  from: 1,
  notes(doc) {
    const plan = planStatuses(doc);
    const notes: string[] = [];
    const titles = [...walkNodes(doc.nodes)]
      .filter((n) => plan.statuses.has(n.id))
      .map((n) => `${n.title} → ${plan.statuses.get(n.id)}`);
    if (titles.length)
      notes.push(
        `${titles.length} status${titles.length === 1 ? '' : 'es'} follow what the nodes have (${titles.slice(0, 3).join(', ')}${titles.length > 3 ? ', …' : ''})`,
      );
    if (plan.records.size)
      notes.push(
        `${plan.records.size} tested node${plan.records.size === 1 ? '' : 's'} keep why on the node`,
      );
    if (doc.flow.runtime?.kind) notes.push('the runtime kind is worked out from the flow');
    return notes;
  },
  apply(tx) {
    const doc = tx.current.doc.toJS() as FlowDocument;
    const plan = planStatuses(doc);
    const pathOf = (id: Ulid) =>
      buildModel(tx.current.doc.toJS() as FlowDocument).nodes.get(id)?.path;
    for (const [id, status] of plan.statuses) {
      const path = pathOf(id);
      if (path)
        tx.apply((f) => setIn(f, [...path, 'status'], status, { before: keysAfter('status') }));
    }
    for (const [id, record] of plan.records) {
      const path = pathOf(id);
      if (path)
        tx.apply((f) =>
          setIn(f, [...path, 'tested'], record as Record<string, string | number>, {
            before: keysAfter('tested'),
          }),
        );
    }
    // The format 1 decisions for tested by hand now live on the nodes.
    const decisions = (tx.current.doc.toJS() as FlowDocument).decisions ?? [];
    const gone = decisions
      .map((d, i) =>
        d?.kind === 'finding_accepted' && plan.decisions.has((d as { finding: string }).finding)
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    if (gone.length === decisions.length && gone.length > 0)
      tx.apply((f) => deleteKey(f, [], 'decisions'));
    else for (const i of gone.reverse()) tx.apply((f) => removeItem(f, ['decisions'], i));
    // The runtime kind follows from the flow in format 2; the template stays.
    const runtime = (tx.current.doc.toJS() as FlowDocument).flow.runtime;
    if (runtime?.kind !== undefined) {
      if (Object.keys(runtime).length === 1) tx.apply((f) => deleteKey(f, ['flow'], 'runtime'));
      else tx.apply((f) => deleteKey(f, ['flow', 'runtime'], 'kind'));
    }
  },
};

/**
 * AFD-51: open_on_purpose, drift_ignored and finding_accepted become `accepted` decisions keyed
 * by what they accept. Runs after the status step, which takes the tested-by-hand ones away.
 */
const decisionStep: MigrationStep = {
  from: 1,
  notes(doc) {
    const old = acceptedAll(doc).filter(
      (a) => (doc.decisions?.[a.index] as { kind?: string } | undefined)?.kind !== 'accepted',
    );
    // The status step moves the tested-by-hand ones onto their nodes first.
    const n = old.filter((a) => !(a.area === 'lens' && a.what.startsWith('status:tested|'))).length;
    return n ? [`${n} decision${n === 1 ? '' : 's'} become one kind: accepted`] : [];
  },
  apply(tx) {
    const doc = tx.current.doc.toJS() as FlowDocument;
    const ops = acceptedAll(doc)
      .filter(
        (a) => (doc.decisions?.[a.index] as { kind?: string } | undefined)?.kind !== 'accepted',
      )
      .map(
        (a) => (f: Parameters<typeof setIn>[0]) =>
          setIn(f, ['decisions', a.index], upgradedItem(a)),
      );
    tx.applyAll(ops);
  },
};

/** Steps inside a subflow that do not set become themselves, so they inherit its setting. */
function inheritors(node: FlowNode): number {
  return (node.subflow?.nodes ?? []).reduce(
    (n, inner) =>
      !inner || !hasStatus(inner)
        ? n
        : inner.type === 'subflow'
          ? n + (inner.settings?.become === undefined ? 1 + inheritors(inner) : 0)
          : n + (inner.settings?.become === undefined ? 1 : 0),
    0,
  );
}

/**
 * AFD-52: become_user moves from task keywords to the Privilege settings, and from now on
 * become (and whom) set on a subflow applies to its steps: the notes say where that changes
 * the generated plays before anyone upgrades.
 */
const privilegeStep: MigrationStep = {
  from: 1,
  notes(doc) {
    const notes: string[] = [];
    const nodes = [...walkNodes(doc.nodes)];
    const moved = nodes.filter((n) => n.impl?.keywords && 'become_user' in n.impl.keywords).length;
    if (moved)
      notes.push(
        `become_user moves from task keywords to the Privilege settings (${moved} node${moved === 1 ? '' : 's'})`,
      );
    for (const n of nodes) {
      const count = n.type === 'subflow' && n.settings?.become ? inheritors(n) : 0;
      if (count)
        notes.push(
          `become on ${n.title} now applies to its ${count} step${count === 1 ? '' : 's'}`,
        );
    }
    return notes;
  },
  apply(tx) {
    const doc = tx.current.doc.toJS() as FlowDocument;
    for (const n of walkNodes(doc.nodes)) {
      const user = n.impl?.keywords?.become_user;
      if (user === undefined) continue;
      const path = buildModel(tx.current.doc.toJS() as FlowDocument).nodes.get(n.id)?.path;
      if (!path) continue;
      if (n.settings) tx.apply((f) => setIn(f, [...path, 'settings', 'become_user'], String(user)));
      else
        tx.apply((f) =>
          setIn(
            f,
            [...path, 'settings'],
            { become_user: String(user) },
            { before: keysAfter('settings') },
          ),
        );
      const left = Object.keys(n.impl?.keywords ?? {}).filter((k) => k !== 'become_user');
      if (left.length) tx.apply((f) => deleteKey(f, [...path, 'impl', 'keywords'], 'become_user'));
      else tx.apply((f) => deleteKey(f, [...path, 'impl'], 'keywords'));
    }
  },
};

/**
 * AFD-52: the credentials and execution environment nodes named (applied nowhere in format 1) go
 * to the flow's runtime, where Set Up AWX Template applies them. Several environments: the first
 * stays, and the notes name the others.
 */
const awxStep: MigrationStep = {
  from: 1,
  notes(doc) {
    const lift = awxLift(doc);
    if (lift.nodes.length === 0) return [];
    const what = [
      lift.credentials.length ? `credentials ${lift.credentials.join(', ')}` : '',
      lift.execution_environment ? `execution environment ${lift.execution_environment}` : '',
    ]
      .filter(Boolean)
      .join(' and ');
    return [
      `${what} move from ${lift.nodes.length} node${lift.nodes.length === 1 ? '' : 's'} to the flow, where Set Up AWX Template applies them`,
      ...(lift.otherEnvironments.length
        ? [
            `execution environment ${lift.otherEnvironments.join(', ')} is dropped (one per template)`,
          ]
        : []),
    ];
  },
  apply(tx) {
    const doc = tx.current.doc.toJS() as FlowDocument;
    const lift = awxLift(doc);
    if (lift.nodes.length === 0) return;
    for (const id of lift.nodes) {
      const entry = buildModel(tx.current.doc.toJS() as FlowDocument).nodes.get(id);
      if (!entry) continue;
      const s = entry.node.settings ?? {};
      const left = Object.keys(s).filter(
        (k) => k !== 'credential' && k !== 'execution_environment',
      );
      if (left.length === 0) tx.apply((f) => deleteKey(f, entry.path, 'settings'));
      else
        for (const k of ['credential', 'execution_environment'] as const)
          if (s[k] !== undefined) tx.apply((f) => deleteKey(f, [...entry.path, 'settings'], k));
    }
    if (lift.credentials.length)
      tx.apply((f) => setIn(f, ['flow', 'runtime', 'credentials'], lift.credentials));
    if (lift.execution_environment) {
      const ee = lift.execution_environment;
      tx.apply((f) => setIn(f, ['flow', 'runtime', 'execution_environment'], ee));
    }
  },
};

/** v1 → v2, in order. Wave 4 tickets add their conversions here (AFD-52, -54). */
export const STEPS: readonly MigrationStep[] = [statusStep, decisionStep, privilegeStep, awxStep];

/**
 * Brings the document in `tx` to `CURRENT_FORMAT`, step by step. Throws when it is already current
 * or newer than this extension reads.
 */
export function migrate(tx: YamlTransaction, steps: readonly MigrationStep[] = STEPS): number {
  const doc = tx.current.doc.toJS() as FlowDocument;
  let version = formatOf(doc);
  if (version > CURRENT_FORMAT) throw newer(version);
  if (version === CURRENT_FORMAT)
    throw new FormatError('format-current', `This flow already uses format ${CURRENT_FORMAT}`);
  while (version < CURRENT_FORMAT) {
    for (const step of steps.filter((s) => s.from === version)) step.apply(tx);
    version += 1;
    tx.apply((f) => setIn(f, ['schema_version'], version));
  }
  return version;
}

/** What upgrading this document changes, for the banner and the result: the steps' notes. */
export function upgradeNotes(doc: FlowDocument, steps: readonly MigrationStep[] = STEPS): string[] {
  const version = formatOf(doc);
  return steps
    .filter((s) => s.from >= version && s.from < CURRENT_FORMAT)
    .flatMap((s) => s.notes(doc));
}

function newer(version: number): FormatError {
  return new FormatError(
    'format-newer',
    `This flow uses format ${version}, newer than this Ansible Flow Designer reads (up to ${CURRENT_FORMAT}): update the extension`,
  );
}
