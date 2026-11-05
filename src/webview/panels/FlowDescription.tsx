// Right panel with nothing selected (04 §1): flow identity, goal, typed inputs, owner, runtime,
// maintenance window (Timing lens, M8) and readiness counters. AFD-72: what a newcomer needs first
// (name, goal, inputs); the rest under More details; readiness once there is a step to count.
import { SLUG } from '../../core/flow/ids';
import { modelOf } from '../../core/flow/model';
import { runtimeKind } from '../../core/flow/status';
import type { FlowHeader } from '../../core/flow/types';
import { needsLook, type RepoState, repoLine } from '../../core/view/flowFacts';
import { run } from '../actions';
import { send } from '../bus';
import { StatusIcon } from '../canvas/StatusIcon';
import { useEditable } from '../editActions';
import { SHORTCUTS } from '../shortcuts';
import { useUi } from '../store';
import { bannerCount, readiness, STATUS_ORDER } from '../viewModel';
import { ContractEditor } from './ContractEditor';
import { Fold } from './Fold';
import { CommitField, ReadOnly } from './fields';

/**
 * AFD-93: the workspace's flows in a line, with the way to them (round 2: S8, T7 given up again).
 * Before the index has read them, the line says what the Flows view holds.
 */
function RepoLine({ repo, hook }: { repo: RepoState | null; hook: string }) {
  return (
    <p className="muted" {...{ [hook]: '' }}>
      {repo
        ? `${repoLine(repo)}: `
        : 'Other flows of this workspace, with their problems and code state: '}
      <button type="button" className="link" onClick={() => send({ type: 'showFlows' })}>
        Flows View
      </button>
    </p>
  );
}

export function FlowDescription() {
  const snapshot = useUi((s) => s.snapshot);
  const repo = useUi((s) => s.repo);
  const editable = useEditable();
  const doc = snapshot?.doc;
  if (!doc?.flow) return <p className="muted">No flow loaded.</p>;
  const { flow } = doc;
  const model = modelOf(doc);
  const ready = readiness(doc);
  const update = (patch: Record<string, string | null>) => run({ kind: 'updateFlow', patch });
  return (
    <div className="afd-panel-body">
      <h2>Flow</h2>
      {/* X2: a flow that needs a look elsewhere is said at the top, not only under Readiness. */}
      {repo && needsLook(repo) ? <RepoLine repo={repo} hook="data-repo-line" /> : null}
      <fieldset className="afd-editable" disabled={!editable}>
        <CommitField
          label="Name"
          value={flow.name ?? ''}
          onCommit={(v) => void update({ name: v })}
          validate={(v) => (v.trim() ? undefined : 'Required')}
        />
        <CommitField
          label="Goal"
          value={flow.goal ?? ''}
          multiline
          placeholder="What this flow achieves, in one sentence"
          onCommit={(v) => void update({ goal: v.trim() ? v : null })}
        />
        <ContractEditor
          title="Inputs"
          target="flow"
          side="inputs"
          contract={flow.inputs}
          hint="What the flow asks for when it runs. devices: the hosts it runs on."
        />
        <Fold
          id="flow-details"
          open={!SLUG.test(flow.key ?? '')}
          summary={`More details: ${flow.key} · version ${flow.version}${flow.owner ? ` · owner ${flow.owner}` : ''}`}
        >
          <CommitField
            label="Key"
            value={flow.key ?? ''}
            mono
            onCommit={(v) => void update({ key: v })}
            validate={(v) => (SLUG.test(v) ? undefined : 'Lowercase words joined by dashes')}
          />
          <ReadOnly label="ID (fixed)" value={flow.id} mono />
          <ReadOnly label="Version" value={String(flow.version)} />
          <CommitField
            label="Owner"
            value={flow.owner ?? ''}
            onCommit={(v) => void update({ owner: v.trim() ? v : null })}
          />
          <ReadOnly
            label="Runtime"
            value={
              flow.runtime && model
                ? [
                    runtimeKind(model),
                    flow.runtime.template,
                    flow.runtime.credentials?.length
                      ? `credentials ${flow.runtime.credentials.join(', ')}`
                      : '',
                    flow.runtime.execution_environment
                      ? `EE ${flow.runtime.execution_environment}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'not set'
            }
          />
          {flow.imported_from && (
            <ReadOnly label="Imported from" value={importedFromText(flow.imported_from)} />
          )}
          <CommitField
            label="Maintenance window"
            value={flow.maintenance_window ?? ''}
            mono
            placeholder="e.g. 4h or 2h30m"
            onCommit={(v) => void update({ maintenance_window: v.trim() ? v : null })}
            validate={(v) =>
              !v.trim() || /^([0-9]+[smhd])+$/.test(v.trim().toLowerCase().replaceAll(/\s+/g, ''))
                ? undefined
                : 'A duration like 4h, 90m or 2h30m'
            }
          />
        </Fold>
      </fieldset>
      {ready.total > 0 ? (
        <section className="afd-section">
          <h3>Readiness</h3>
          {/* AFD-86: each count lists its steps with Find, across every level (round 1: P9). */}
          <ul className="afd-readiness">
            {STATUS_ORDER.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  className="afd-readiness-link"
                  data-find-filter={`status:${s}`}
                  title={`List the ${s} steps on every level (Find status:${s})`}
                  onClick={() => findWith(`status:${s}`)}
                >
                  <StatusIcon status={s} label={false} />
                  {s}
                  <strong>{ready.counts[s]}</strong>
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className="afd-readiness-link"
                data-find-filter="open:fail"
                title="List the steps with an open fail port (Find open:fail)"
                onClick={() => findWith('open:fail')}
              >
                <span className="codicon codicon-warning" aria-hidden="true" />
                open fail ports
                <strong>{snapshot ? bannerCount(snapshot.openPorts) : 0}</strong>
              </button>
            </li>
          </ul>
          {/* AFD-88: how to pick several steps, which nothing said (round 1: P20). */}
          {ready.total >= 2 ? (
            <p className="muted" data-select-hint>
              To work on several steps at once, select them with{' '}
              {SHORTCUTS.find((s) => s.id === 'select')?.keys}: then line them up, space them
              evenly, copy them or make them a subflow.
            </p>
          ) : null}
          {/* AFD-89: the way to the other flows and their health (round 1: P16, T7 given up); with
            the Readiness counts, so a new flow's first screen keeps its 35 controls. */}
          <RepoLine repo={repo} hook="data-flows-link" />
        </section>
      ) : null}
    </div>
  );
}

/** Opens Find with a filter (AFD-86). */
function findWith(query: string) {
  const ui = useUi.getState();
  ui.openFind(true);
  ui.setFindQuery(query);
}

const IMPORT_KIND: Record<string, string> = {
  awx_workflow: 'AWX workflow',
  awx_job_template: 'AWX job template',
  playbook: 'Playbook',
};

function importedFromText(from: NonNullable<FlowHeader['imported_from']>): string {
  const what = from.template ? `"${from.template}"` : (from.path ?? '');
  const id = from.id !== undefined ? ` (id ${from.id})` : '';
  const path = from.template && from.path ? ` · ${from.path}` : '';
  return `${IMPORT_KIND[from.kind] ?? from.kind} ${what}${id}${path}`.trim();
}
