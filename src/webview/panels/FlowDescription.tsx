// Right panel with nothing selected (04 §1): flow identity, goal, typed inputs, owner, runtime,
// maintenance window (Timing lens, M8) and readiness counters.
import { SLUG } from '../../core/flow/ids';
import { modelOf } from '../../core/flow/model';
import { runtimeKind } from '../../core/flow/status';
import type { FlowHeader } from '../../core/flow/types';
import { run } from '../actions';
import { StatusIcon } from '../canvas/StatusIcon';
import { useEditable } from '../editActions';
import { useUi } from '../store';
import { bannerCount, readiness, STATUS_ORDER } from '../viewModel';
import { ContractEditor } from './ContractEditor';
import { CommitField, ReadOnly } from './fields';

export function FlowDescription() {
  const snapshot = useUi((s) => s.snapshot);
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
      <fieldset className="afd-editable" disabled={!editable}>
        <CommitField
          label="Name"
          value={flow.name ?? ''}
          onCommit={(v) => void update({ name: v })}
          validate={(v) => (v.trim() ? undefined : 'Required')}
        />
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
          label="Goal"
          value={flow.goal ?? ''}
          multiline
          onCommit={(v) => void update({ goal: v.trim() ? v : null })}
        />
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
        <ContractEditor title="Inputs" target="flow" side="inputs" contract={flow.inputs} />
      </fieldset>
      <section className="afd-section">
        <h3>Readiness</h3>
        <ul className="afd-readiness">
          {STATUS_ORDER.map((s) => (
            <li key={s}>
              <StatusIcon status={s} label={false} />
              {s}
              <strong>{ready.counts[s]}</strong>
            </li>
          ))}
          <li>
            <span className="codicon codicon-warning" aria-hidden="true" />
            open fail ports
            <strong>{snapshot ? bannerCount(snapshot.openPorts) : 0}</strong>
          </li>
        </ul>
      </section>
    </div>
  );
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
