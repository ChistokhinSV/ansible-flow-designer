// Right panel with nothing selected (04 §1): flow identity, goal, typed inputs, owner, runtime and
// readiness counters.
import { SLUG } from '../../core/flow/ids';
import { run } from '../actions';
import { useUi } from '../store';
import { bannerCount, readiness, STATUS_ORDER } from '../viewModel';
import { ContractEditor } from './ContractEditor';
import { CommitField, ReadOnly } from './fields';

export function FlowDescription() {
  const snapshot = useUi((s) => s.snapshot);
  const doc = snapshot?.doc;
  if (!doc?.flow) return <p className="muted">No flow loaded.</p>;
  const { flow } = doc;
  const ready = readiness(doc);
  const update = (patch: Record<string, string | null>) => run({ kind: 'updateFlow', patch });
  return (
    <div className="afd-panel-body">
      <h2>Flow</h2>
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
          flow.runtime
            ? [flow.runtime.kind, flow.runtime.template].filter(Boolean).join(' · ')
            : 'not set'
        }
      />
      <ContractEditor title="Inputs" target="flow" side="inputs" contract={flow.inputs} />
      <section className="afd-section">
        <h3>Readiness</h3>
        <ul className="afd-readiness">
          {STATUS_ORDER.map((s) => (
            <li key={s}>
              <span className={`afd-dot status-${s}`} aria-hidden="true" />
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
