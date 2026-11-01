// The sections of a node's Details (AFD-43): General (identity, lifecycle, what the type adds, the
// last run), Inputs and outputs, Ports with their resolutions, Execution with task keywords. Fields
// save as you go, each one command (one undo step); only the binding is staged (Details.tsx).
import { useId } from 'react';
import { registerName } from '../../core/flow/dataNames';
import { formatOf, purposeOf } from '../../core/flow/format';
import { SLUG } from '../../core/flow/ids';
import { keywordProblem } from '../../core/flow/keywords';
import type { FlowModel } from '../../core/flow/model';
import { modelOf } from '../../core/flow/model';
import { portMenu } from '../../core/flow/portMenu';
import { canMarkTested, contentStatus, nextStep } from '../../core/flow/status';
import type { FlowNode, HandlerKind, NodeStatus, TestedRecord } from '../../core/flow/types';
import { fieldProblem, type NodeProblem } from '../../core/view/nodeProblems';
import {
  EXECUTION_SETTINGS,
  SETTING_GROUPS,
  type SettingKey,
  settingProblem,
  settingText,
  settingValue,
} from '../../core/view/settings';
import { run } from '../actions';
import { STATE_LABEL } from '../constants';
import { ContractEditor } from '../panels/ContractEditor';
import { CommitField, ReadOnly } from '../panels/fields';
import { runPortItem } from '../portActions';
import { YamlField } from '../properties/YamlField';
import { useUi } from '../store';
import type { PortView } from '../viewModel';
import { levelView, nextRequirement, STATUS_ORDER } from '../viewModel';

const HANDLERS: (HandlerKind | '')[] = ['', 'rollback', 'notify', 'retry', 'exclude'];

/** Identity, lifecycle and what the node's type adds; `context` when its level is the open one. */
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
      <ReadOnly label="ID (fixed)" value={node.id} mono />
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
  // Mockup 03: the first suggestions inline, plus "Leave open on purpose…".
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
      <span className="mono">{port.name}</span>
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
  // AFD-44: grouped as an operator reads a play: where it runs, as whom, when, and its tags.
  return (
    <div className="afd-details-page">
      {SETTING_GROUPS.map((group) => (
        <section className="afd-section" key={group} data-setting-group={group}>
          <h3>{group}</h3>
          {EXECUTION_SETTINGS.filter(
            (s) =>
              s.group === group &&
              (s.format ?? 1) <= format &&
              format <= (s.formatMax ?? format) &&
              (!s.types || s.types.includes(node.type)),
          ).map((s) => {
            const value = settings[s.key];
            if (s.kind === 'bool')
              return (
                <label key={s.key} className="afd-check">
                  <input
                    type="checkbox"
                    checked={value === true}
                    onChange={(e) => set(s.key, e.target.checked ? true : null)}
                  />
                  {s.label} <span className="muted">{s.help}</span>
                </label>
              );
            return (
              <div key={s.key}>
                <CommitField
                  label={`${s.label} · ${s.key === 'until' ? `${s.help}; it reads ${registerName(node)} (the result) and the inputs` : s.help}`}
                  value={settingText(value)}
                  mono
                  problem={fieldProblem(problems, `settings.${s.key}`)}
                  validate={(v) => settingProblem(s, v)}
                  onCommit={(v) => set(s.key, settingValue(s, v))}
                />
              </div>
            );
          })}
          {group === 'Tags' ? <TaskKeywords node={node} /> : null}
        </section>
      ))}
    </div>
  );
}

/**
 * Ansible task keywords on the binding (AFD-26): when, loop, ignore_errors and the like, written on
 * the generated task as they are. What the flow models itself is refused with where it goes.
 */
function TaskKeywords({ node }: { node: FlowNode }) {
  const id = useId();
  const impl = node.impl;
  // AFD-44: shown, disabled, with why, rather than missing.
  const blocked = !impl?.ref
    ? 'Bind a module or role first: task keywords go on the task the binding generates.'
    : impl.kind === 'playbook'
      ? 'A playbook binding takes no task keywords (import_playbook has none).'
      : undefined;
  if (blocked || !impl)
    return (
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
    );
  return (
    <div className="afd-field">
      <label htmlFor={id}>
        Task keywords ·{' '}
        <span className="muted">
          YAML map written on the generated task: when, loop, ignore_errors, changed_when,
          delegate_to, run_once, no_log...
        </span>
      </label>
      <YamlField
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
  );
}
