// Top bar (04 §1): breadcrumb, key and version, mode and lens toggles, primary actions. Only
// Design mode and no lens exist in M1; the rest is shown disabled with the milestone that adds it.
import { send } from '../bus';
import { useUi } from '../store';

const MODES = [
  { id: 'design', label: 'Design' },
  { id: 'implementation', label: 'Implementation', soon: 'M6' },
  { id: 'run', label: 'Run', soon: 'M7' },
];
const LENSES = ['None', 'Inventory', 'Data', 'Code', 'Access', 'Timing'];

export function TopBar() {
  const flow = useUi((s) => s.snapshot?.doc?.flow);
  return (
    <header className="afd-topbar">
      <nav className="afd-breadcrumb" aria-label="Breadcrumb">
        <span className="muted">Flows</span>
        <span className="muted">/</span>
        <span className="afd-flow-name">{flow?.name ?? 'Untitled flow'}</span>
        {flow ? (
          <span className="afd-chip mono" title="Flow key and version">
            {flow.key} · v{flow.version}
          </span>
        ) : null}
      </nav>
      <fieldset className="afd-segmented" aria-label="Mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={m.id === 'design' ? 'active' : ''}
            aria-pressed={m.id === 'design'}
            disabled={!!m.soon}
            title={m.soon ? `${m.label} mode arrives in ${m.soon}` : undefined}
          >
            {m.label}
          </button>
        ))}
      </fieldset>
      <fieldset className="afd-segmented" aria-label="Lens">
        {LENSES.map((l) => (
          <button
            key={l}
            type="button"
            className={l === 'None' ? 'active' : ''}
            aria-pressed={l === 'None'}
            disabled={l !== 'None'}
            title={l === 'None' ? 'No lens' : `${l} lens arrives in M8`}
          >
            {l}
          </button>
        ))}
      </fieldset>
      <div className="afd-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => send({ type: 'tidyUp' })}
          title="Auto-layout the whole level"
        >
          <span className="codicon codicon-layout" aria-hidden="true" /> Tidy up
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => send({ type: 'openText' })}
          title="Open the flow file as text"
        >
          <span className="codicon codicon-go-to-file" aria-hidden="true" /> Text
        </button>
        <button type="button" disabled title="Run as walking skeleton arrives in M3">
          <span className="codicon codicon-play" aria-hidden="true" /> Run as skeleton
        </button>
        <button type="button" onClick={() => send({ type: 'validate' })}>
          <span className="codicon codicon-check-all" aria-hidden="true" /> Validate design
        </button>
      </div>
    </header>
  );
}
