// The sections of a node's Details (AFD-43): General (identity, lifecycle, what the type adds, the
// last run), Inputs and outputs, Ports with their resolutions, Execution with task keywords. Fields
// save as you go, each one command (one undo step); only the binding is staged (Details.tsx).
import { useId, useMemo, useRef } from 'react';
import { registerName } from '../../core/flow/dataNames';
import { acceptedAll } from '../../core/flow/decisions';
import { formatOf, purposeOf } from '../../core/flow/format';
import { SLUG } from '../../core/flow/ids';
import { keywordProblem } from '../../core/flow/keywords';
import type { FlowModel } from '../../core/flow/model';
import { modelOf } from '../../core/flow/model';
import { portMenu } from '../../core/flow/portMenu';
import { diffFlows } from '../../core/flow/semanticDiff';
import { canMarkTested, contentStatus, nextStep } from '../../core/flow/status';
import type { FlowNode, HandlerKind, NodeStatus, TestedRecord } from '../../core/flow/types';
import { becomeStandsOut } from '../../core/lens/access';
import { fieldLabel } from '../../core/lens/changes';
import { fieldProblem, type NodeProblem } from '../../core/view/nodeProblems';
import { changeWords } from '../../core/view/outsideChanges';
import { portHint } from '../../core/view/portHints';
import {
  appliesTo,
  EXECUTION_SETTINGS,
  SETTING_GROUPS,
  type SettingGroup,
  type SettingKey,
  settingProblem,
  settingText,
  settingValue,
  timingText,
} from '../../core/view/settings';
import { run } from '../actions';
import { useCatalog } from '../catalog';
import { STATE_LABEL, TYPE_LABEL } from '../constants';
import { ContractEditor } from '../panels/ContractEditor';
import { Fold } from '../panels/Fold';
import { CommitField, ReadOnly } from '../panels/fields';
import { runPortItem } from '../portActions';
import { YamlField, type YamlFieldHandle } from '../properties/YamlField';
import { useUi } from '../store';
import type { PortView } from '../viewModel';
import { levelView, nextRequirement, STATUS_ORDER } from '../viewModel';

const HANDLERS: (HandlerKind | '')[] = ['', 'rollback', 'notify', 'retry', 'exclude'];

/** Identity, lifecycle and what the node's type adds; `context` when its level is the open one. */
const shortValue = (v: unknown): string => {
  if (v === undefined || v === null) return '(none)';
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
};

/** AFD-104 (round 3: R9): what an outside change did to this step, in words. */
function OutsideChange({ id }: { id: string }) {
  const change = useUi((s) => s.outside?.changes?.find((c) => c.id === id));
  if (!change || change.kind === 'removed') return null;
  return (
    <p className="afd-outside-step" data-outside-change={change.kind}>
      <span className="afd-swatch outside" aria-hidden="true" /> Changed outside the designer:{' '}
      {changeWords(change)}
    </p>
  );
}

/** Changes lens (AFD-57): what changed on this node since the compared version, field by field. */
function NodeChanges({ id }: { id: string }) {
  const on = useUi((s) => s.lens === 'changes');
  const compare = useUi((s) => s.lensFacts.compare);
  const doc = useUi((s) => s.snapshot?.doc);
  const change = useMemo(
    () =>
      on && compare?.state === 'ready' && compare.base && doc
        ? diffFlows(compare.base, doc).nodes.find((n) => n.id === id)
        : undefined,
    [on, compare, doc, id],
  );
  if (!change || !compare) return null;
  return (
    <section className="afd-section afd-node-changes" data-node-changes={change.kind}>
      <h3>Since {compare.label}</h3>
      {change.kind === 'added' ? (
        <p className="muted">Added</p>
      ) : (
        <dl>
          {change.fields.map((f) => (
            <div key={f.field}>
              <dt>{fieldLabel(f)}</dt>
              <dd className="mono">
                {shortValue(f.before)} → {shortValue(f.after)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function GeneralSection({
  node,
  context,
  problems = [],
}: {
  node: FlowNode;
  context?: boolean;
  problems?: readonly NodeProblem[];
}) {
  const patch = (p: Record<string, unknown>) => void updatePatch(node.id, p);
  const designable = node.type !== 'start' && node.type !== 'end';
  return (
    <div className="afd-details-page">
      <NodeChanges id={node.id} />
      <OutsideChange id={node.id} />
      {context ? (
        <p className="muted" data-level-context={node.id}>
          You are inside this subflow. Select a step to edit it; the subflow itself is described
          here.
        </p>
      ) : null}
      <CommitField
        label="Title"
        focusKey="title"
        value={node.title}
        problem={fieldProblem(problems, 'title')}
        onCommit={(v) => patch({ title: v })}
        validate={(v) => (v.trim() ? undefined : 'Required')}
      />
      <CommitField
        label="Key"
        value={node.key}
        mono
        problem={fieldProblem(problems, 'key')}
        onCommit={(v) => patch({ key: v })}
        validate={(v) => (SLUG.test(v) ? undefined : 'Lowercase words joined by dashes')}
      />
      {designable ? (
        <CommitField
          label="Intent"
          value={node.intent ?? ''}
          multiline
          onCommit={(v) => patch({ intent: v.trim() ? v : null })}
        />
      ) : null}
      {designable ? (
        <Lifecycle
          node={node}
          onSet={(status) =>
            // `tested` by hand takes a reason (AFD-44); a passing run sets it by itself.
            status === 'tested' ? useUi.getState().setTestedReason(node.id) : patch({ status })
          }
        />
      ) : null}
      <TypeFields node={node} patch={patch} />
      {node.type === 'subflow' && !context ? (
        <section className="afd-section">
          <h3>Inner steps</h3>
          <p className="muted">
            {node.subflow?.nodes?.length
              ? `${node.subflow.nodes.length} step(s) inside.`
              : 'No inner steps yet: open it and add the first one.'}
          </p>
          <button type="button" onClick={() => useUi.getState().setLevel(node.id)}>
            <span className="codicon codicon-arrow-right" aria-hidden="true" /> Open Subflow
          </button>
        </section>
      ) : null}
      {/* AFD-72: the ID matters to tools and hand-written YAML, not to a first flow. */}
      <Fold id="node-details" summary="More details: the ID">
        <ReadOnly label="ID (fixed)" value={node.id} mono />
      </Fold>
      <LastRun id={node.id} />
    </div>
  );
}

/** Inputs and outputs, with where each input comes from. */
export function IoSection({ node }: { node: FlowNode }) {
  return (
    <div className="afd-details-page">
      <ContractEditor
        title="Inputs"
        target={node.id}
        side="inputs"
        contract={node.inputs}
        withFrom
      />
      <ContractEditor
        title="Outputs"
        target={node.id}
        side="outputs"
        contract={node.outputs}
        withFrom
      />
    </div>
  );
}

/** Hosts the last run sent through each port of this node (M3; Run mode in M7). */
function LastRun({ id }: { id: string }) {
  const run = useUi((s) => s.run);
  const ports = run?.summary?.nodes[id];
  const failures = run?.summary?.failures.filter((f) => f.node === id) ?? [];
  if (run?.state !== 'done' || (!ports && failures.length === 0)) return null;
  return (
    <section className="afd-section" data-last-run={id}>
      <h3>Last {run.mode === 'check' ? 'skeleton run' : 'run'}</h3>
      <ul className="afd-run-ports">
        {Object.entries(ports ?? {}).map(([port, hosts]) => (
          <li key={port} title={hosts.join(', ')}>
            <span className="mono">{port}</span> <span className="afd-chip">{hosts.length}</span>{' '}
            <span className="muted">
              {hosts.slice(0, 4).join(', ')}
              {hosts.length > 4 ? ', …' : ''}
            </span>
          </li>
        ))}
        {failures.map((f) => (
          <li key={`${f.host}|${f.task}`} className="afd-run-failure">
            <span className="codicon codicon-error" aria-hidden="true" /> {f.host}:{' '}
            {f.msg ?? f.task}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function updatePatch(id: string, p: Record<string, unknown>) {
  return run({ kind: 'updateNode', id, patch: p });
}

/** What a format 2 tested record says (AFD-50). */
export function testedText(r: TestedRecord): string {
  if (r.run)
    return `Tested by run ${r.run}${r.flow_version !== undefined ? ` of flow version ${r.flow_version}` : ''}${r.commit ? ` at ${r.commit.slice(0, 10)}` : ''}`;
  const who = [r.by, r.at].filter(Boolean).join(', ');
  return `Tested by hand: ${r.reason ?? ''}${who ? ` (${who})` : ''}`;
}

/**
 * The lifecycle stepper. Format 1 sets a status by hand. Format 2 (AFD-50) shows the status the
 * content gives, the tested record, and the two things set by hand: Mark Tested… and Clear Tested.
 */
export function Lifecycle({ node, onSet }: { node: FlowNode; onSet(s: NodeStatus): void }) {
  const doc = useUi((s) => s.snapshot?.doc);
  const v2 = !!doc && formatOf(doc) >= 2;
  const status = node.status ?? 'draft';
  const current = STATUS_ORDER.indexOf(status);
  const next = v2 && doc ? nextStep(doc, node) : nextRequirement(node);
  return (
    <section className="afd-section" data-lifecycle={v2 ? 'derived' : 'manual'}>
      <h3>Lifecycle</h3>
      <ol className={`afd-stepper${v2 ? ' read' : ''}`}>
        {STATUS_ORDER.map((s, i) => (
          <li key={s} className={i < current ? 'done' : i === current ? 'current' : ''}>
            {v2 ? (
              <span aria-current={i === current ? 'step' : undefined}>{s}</span>
            ) : (
              <button
                type="button"
                onClick={() => onSet(s)}
                aria-current={i === current ? 'step' : undefined}
                title={`Set status to ${s}`}
              >
                {s}
              </button>
            )}
          </li>
        ))}
      </ol>
      {v2 && node.tested ? (
        <p className="muted" data-tested-record>
          {testedText(node.tested)}
        </p>
      ) : null}
      {next ? <p className="muted">Next: {next}</p> : null}
      {v2 && doc && (status === 'tested' || canMarkTested(doc, node)) ? (
        <div className="afd-inline-actions">
          {status === 'tested' ? (
            <button type="button" className="secondary" onClick={() => onSet(contentStatus(node))}>
              Clear Tested
            </button>
          ) : (
            <button type="button" className="secondary" onClick={() => onSet('tested')}>
              <span className="codicon codicon-verified" aria-hidden="true" /> Mark Tested…
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function TypeFields({
  node,
  patch,
}: {
  node: FlowNode;
  patch(p: Record<string, unknown>): void;
}) {
  switch (node.type) {
    case 'decision':
      return (
        <CommitField
          label="Condition (evaluated per host)"
          value={node.condition ?? ''}
          mono
          onCommit={(v) => patch({ condition: v.trim() ? v : null })}
        />
      );
    case 'end':
      return (
        <div className="afd-field">
          <label htmlFor="afd-outcome">Outcome</label>
          <select
            id="afd-outcome"
            value={node.outcome ?? 'success'}
            onChange={(e) => patch({ outcome: e.target.value })}
          >
            <option value="success">success</option>
            <option value="failed">failed</option>
          </select>
        </div>
      );
    case 'join':
      return (
        <div className="afd-field">
          <label htmlFor="afd-join">Join mode (per host)</label>
          <select
            id="afd-join"
            value={node.join_mode ?? 'all'}
            onChange={(e) => patch({ join_mode: e.target.value })}
          >
            <option value="all">all: every branch delivered the host</option>
            <option value="any">any: at least one branch</option>
          </select>
        </div>
      );
    case 'parallel':
      return (
        <CommitField
          label="Branches"
          value={String(node.branches ?? 2)}
          onCommit={(v) => patch({ branches: Number(v) })}
          validate={(v) => (/^[0-9]+$/.test(v) && Number(v) >= 2 ? undefined : 'At least 2')}
        />
      );
    case 'task':
    case 'subflow':
      return (
        <div className="afd-field">
          <label htmlFor="afd-purpose">Purpose in failure handling</label>
          <select
            id="afd-purpose"
            value={purposeOf(node) ?? ''}
            onChange={(e) => patch({ purpose: e.target.value || null })}
          >
            {HANDLERS.map((h) => (
              <option key={h} value={h}>
                {h || 'none'}
              </option>
            ))}
          </select>
        </div>
      );
    default:
      return null;
  }
}

/** One port: state, where it leads, a menu button, and quick resolutions for open fail ports. */
export function PortRow({
  model,
  node,
  port,
  target,
  reason,
}: {
  model: FlowModel;
  node: string;
  port: PortView;
  target: string;
  reason?: string;
}) {
  const openPortMenu = useUi((s) => s.openPortMenu);
  const ref = { node, port: port.name };
  const wired = port.state === 'connected' && port.direction === 'out';
  let text: string = STATE_LABEL[port.state];
  if (wired) text = `→ ${target}`;
  else if (reason) text = `${STATE_LABEL[port.state]}: ${reason}`;
  else if (port.state === 'open-fail') text = 'open: wire it to a handler, or Accept with Reason…';
  // Mockup 03: the first suggestions inline, plus Accept with Reason….
  const quick =
    port.state === 'open-fail'
      ? (portMenu(model, ref)?.items ?? []).filter(
          (i, n) => (i.kind === 'pattern' && n < 2) || i.kind === 'decide',
        )
      : [];
  return (
    <li className={`state-${port.state}`} data-port-row={port.name}>
      <span
        className={`afd-swatch port state-${port.state} tone-${port.tone}`}
        aria-hidden="true"
      />
      <span className="mono" title={portHint(port.name, model.nodes.get(node)?.node.type)}>
        {port.name}
      </span>
      <span className="muted">{text}</span>
      <button
        type="button"
        className="icon"
        aria-label={`Options for port ${port.name}`}
        title="Options"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openPortMenu({ ref, x: r.left - 230, y: r.bottom + 4 });
        }}
      >
        <span className="codicon codicon-ellipsis" aria-hidden="true" />
      </button>
      {quick.length > 0 ? (
        <span className="afd-port-quick">
          {quick.map((item) => (
            <button
              key={item.label}
              type="button"
              className="link"
              onClick={() => void runPortItem(item, ref)}
            >
              {item.label}
            </button>
          ))}
        </span>
      ) : null}
    </li>
  );
}

export function PortsSection({ id }: { id: string }) {
  const snapshot = useUi((s) => s.snapshot);
  if (!snapshot?.doc) return null;
  const model = modelOf(snapshot.doc);
  const entry = model.nodes.get(id);
  if (!entry) return null;
  const view = levelView(snapshot, {}, entry.level).nodes.find((n) => n.node.id === id);
  const edges = model.levels.get(entry.level)?.edges ?? [];
  const decisions = snapshot.doc.decisions ?? [];
  return (
    <div className="afd-details-page">
      <ul className="afd-ports">
        {view?.ports.map((p) => (
          <PortRow
            key={p.name}
            model={model}
            node={id}
            port={p}
            target={
              model.nodes.get(
                edges.find((e) => e?.from?.node === id && e.from.port === p.name)?.to.node ?? '',
              )?.node.title ?? ''
            }
            reason={decisions.find((d) => d?.node === id && d.port === p.name)?.reason}
          />
        ))}
      </ul>
    </div>
  );
}

/** A label as it reads inside a sentence: "Max fail percentage" → "max fail percentage". */
const inline = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

/**
 * A fold's summary: what it holds and how much is set (AFD-103, round 3: R1). The participant did
 * not find Timing behind four closed folds that said only their group names.
 */
function groupSummary(group: string, names: readonly string[], set: number): string {
  const only = names.length === 1 && names[0]?.toLowerCase() === group.toLowerCase();
  return `${group}${only ? '' : `: ${names.join(', ')}`}${set ? ` · ${set} set` : ''}`;
}

export function ExecutionSection({
  node,
  problems = [],
}: {
  node: FlowNode;
  problems?: readonly NodeProblem[];
}) {
  const set = (key: SettingKey, value: unknown) =>
    void updatePatch(node.id, { settings: { [key]: value } });
  const settings = node.settings ?? {};
  const format = useUi((s) => (s.snapshot?.doc ? formatOf(s.snapshot.doc) : 1));
  // AFD-71: task keywords go on the task a binding generates.
  const keywords =
    node.type === 'task' || (node.type === 'subflow' && !node.subflow?.nodes?.length);
  // AFD-44: grouped as an operator reads a play: where it runs, as whom, when, and its tags.
  // AFD-71: only what the code uses on this node, and anything already set (to clear it).
  const fields = (group: SettingGroup) =>
    EXECUTION_SETTINGS.filter(
      (s) =>
        s.group === group &&
        (s.format ?? 1) <= format &&
        format <= (s.formatMax ?? format) &&
        (appliesTo(s, node) || settings[s.key] !== undefined),
    );
  const groups = SETTING_GROUPS.filter((g) => fields(g).length > 0);
  const setIn = (group: SettingGroup) =>
    fields(group).filter((s) => settings[s.key] !== undefined).length;
  // AFD-103 (round 3: R2): Until offers the result's fields, from the module's returns.
  const module = node.impl?.kind === 'module' && node.impl.ref ? node.impl.ref : undefined;
  const doc = useCatalog(module ? { op: 'doc', fqcn: module } : null, `doc:module:${module}`);
  const result = registerName(node);
  const returns = Object.keys(doc.data?.returns ?? {});
  const untilChoices = [`${result} is succeeded`, ...returns.map((r) => `${result}.${r}`)];
  const untilExample = returns.includes('stdout')
    ? `'ready' in ${result}.stdout`
    : returns.includes('rc')
      ? `${result}.rc == 0`
      : `${result} is succeeded`;
  const timing = timingText(settings, result);
  const flowDoc = useUi((s) => s.snapshot?.doc);
  // AFD-106: what the Access lens would flag, asked here with the lens off too.
  const becomeFlagged = useMemo(
    () =>
      !!flowDoc &&
      becomeStandsOut(modelOf(flowDoc), node) &&
      !acceptedAll(flowDoc).some((a) => a.area === 'lens' && a.what === `access:become:${node.id}`),
    [flowDoc, node],
  );
  return (
    <div className="afd-details-page">
      {groups.map((group) => (
        <section className="afd-section" key={group} data-setting-group={group}>
          <Fold
            id={`execution-${group}`}
            // AFD-72: each group folded with what is set in it; open while it has a value or a
            // problem. AFD-103: Timing is open on a module step until the person closes it.
            open={
              groups.length === 1 ||
              setIn(group) > 0 ||
              fields(group).some((s) => fieldProblem(problems, `settings.${s.key}`))
            }
            defaultOpen={group === 'Timing' && !!module}
            summary={groupSummary(
              group,
              fields(group).map((s) => inline(s.label)),
              setIn(group),
            )}
          >
            {fields(group).map((s) => {
              const value = settings[s.key];
              const unused = appliesTo(s, node) ? undefined : (
                <p className="muted" data-setting-unused={s.key}>
                  Not used on a {TYPE_LABEL[node.type].toLowerCase()} node: clear it.
                </p>
              );
              if (s.kind === 'bool')
                return (
                  <div key={s.key}>
                    <label className="afd-check">
                      <input
                        type="checkbox"
                        checked={value === true}
                        onChange={(e) => set(s.key, e.target.checked ? true : null)}
                      />
                      {s.label} <span className="muted">{s.help}</span>
                    </label>
                    {unused}
                  </div>
                );
              const until = s.key === 'until';
              return (
                <div key={s.key}>
                  <CommitField
                    label={`${s.label} · ${until ? `${s.help}; it reads ${result} (the result) and the inputs` : s.key === 'timeout' && node.type === 'approval' ? 'How long the AWX approval waits before its hosts take the timeout port (30m, 4h)' : s.help}`}
                    value={settingText(value, s)}
                    mono
                    placeholder={until ? untilExample : undefined}
                    suggestions={until ? untilChoices : undefined}
                    problem={fieldProblem(problems, `settings.${s.key}`)}
                    validate={(v) => settingProblem(s, v)}
                    onCommit={(v) => set(s.key, settingValue(s, v))}
                  />
                  {unused}
                </div>
              );
            })}
            {/* AFD-106 (round 3: R10): keeping a become the Access lens flags needs a reason. */}
            {group === 'Privilege' && becomeFlagged ? (
              <p className="muted" data-become-flagged>
                The Access lens flags this step's Become: none of the steps wired to it run as root.
                If it needs root, accept the finding with a reason, so others know why.{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    useUi.getState().setAccept({
                      id: `access:become:${node.id}`,
                      node: node.id,
                      title: `${node.title} escalates privileges, unlike its neighbours`,
                    })
                  }
                >
                  Accept with Reason…
                </button>
              </p>
            ) : null}
            {/* AFD-103 (round 3: R2): how the fields combine, as the generated task runs. */}
            {group === 'Timing' && timing ? (
              <p className="muted afd-timing-text" data-timing-text>
                {timing}
              </p>
            ) : null}
          </Fold>
        </section>
      ))}
      {keywords ? <TaskKeywords node={node} /> : null}
    </div>
  );
}

/**
 * The common task keywords, one click each (AFD-103, round 3: R3). A complete line is saved at
 * once; one that needs a value puts the caret there (or selects the value to replace).
 */
const KEYWORD_CHIPS: readonly {
  key: string;
  line: string;
  help: string;
  commit?: boolean;
  select?: number;
}[] = [
  { key: 'when', line: 'when: ', help: 'Run only on hosts where this test holds (no braces)' },
  {
    key: 'loop',
    line: 'loop:\n  - ',
    help: 'Run once for each item of a list: parameters read the item as {{ item }}',
  },
  {
    key: 'no_log',
    line: 'no_log: true',
    help: 'Keep what the step reads and returns out of logs and run output',
    commit: true,
  },
  {
    key: 'ignore_errors',
    line: 'ignore_errors: true',
    help: 'A failure does not stop the host: it goes on through ok_hosts',
    commit: true,
  },
  {
    key: 'delegate_to',
    line: 'delegate_to: localhost',
    help: 'Run the task on another host (like localhost), once for each host that arrives',
    select: 'localhost'.length,
  },
  {
    key: 'run_once',
    line: 'run_once: true',
    help: 'Run the task on one host only, for all of them',
    commit: true,
  },
  {
    key: 'changed_when',
    line: 'changed_when: false',
    help: 'When the step counts as changed (false: never, for a step that only reads)',
    select: 'false'.length,
  },
];

/**
 * Ansible task keywords on the binding (AFD-26): when, loop, ignore_errors and the like, written on
 * the generated task as they are. What the flow models itself is refused with where it goes.
 * AFD-103 (round 3: R3): a fold of their own, out of Tags, named by what they hold.
 */
function TaskKeywords({ node }: { node: FlowNode }) {
  const id = useId();
  const box = useRef<YamlFieldHandle>(null);
  const impl = node.impl;
  const present = Object.keys(impl?.keywords ?? {});
  // AFD-44: shown, disabled, with why, rather than missing.
  const blocked = !impl?.ref
    ? 'Bind a module or role first: task keywords go on the task the binding generates.'
    : impl.kind === 'playbook'
      ? 'A playbook binding takes no task keywords (import_playbook has none).'
      : undefined;
  return (
    <section className="afd-section" data-keywords>
      <Fold
        id="execution-keywords"
        open={present.length > 0}
        summary={`Task keywords: when, loop, no_log…${present.length ? ` · ${present.length} set` : ''}`}
      >
        {blocked || !impl ? (
          <div className="afd-field" data-keywords-blocked>
            <label htmlFor={id}>Task keywords</label>
            <textarea
              id={id}
              className="afd-input mono"
              rows={2}
              disabled
              aria-describedby={`${id}-why`}
            />
            <p id={`${id}-why`} className="muted">
              {blocked}
            </p>
          </div>
        ) : (
          <div className="afd-field">
            <label htmlFor={id}>
              Task keywords · <span className="muted">YAML written on the generated task</span>
            </label>
            <fieldset className="afd-keyword-chips">
              <legend className="afd-sr-only">Add a task keyword</legend>
              {KEYWORD_CHIPS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className="chip-button mono"
                  title={c.help}
                  data-keyword-chip={c.key}
                  disabled={present.includes(c.key)}
                  onClick={() => box.current?.add(c.line, { commit: c.commit, select: c.select })}
                >
                  + {c.key}
                </button>
              ))}
            </fieldset>
            <YamlField
              ref={box}
              // Remount when the file changes underneath (undo, another editor).
              key={JSON.stringify(impl.keywords ?? null)}
              id={id}
              rows={4}
              value={impl.keywords}
              placeholder={`when: version_check.stdout is version("17.9", "<")\nloop: "{{ interfaces }}"`}
              validate={(v) => {
                if (v === null || v === undefined) return undefined;
                if (typeof v !== 'object' || Array.isArray(v)) return 'A map of keyword: value';
                for (const k of Object.keys(v)) {
                  const problem = keywordProblem(k);
                  if (problem) return problem;
                }
                return undefined;
              }}
              onChange={(v) => void updatePatch(node.id, { keywords: v ?? null })}
            />
          </div>
        )}
      </Fold>
    </section>
  );
}
