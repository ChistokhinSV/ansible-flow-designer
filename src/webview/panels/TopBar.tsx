// Top bar (04 §1): breadcrumb, key and version, mode and lens toggles, primary actions. Only
// Design mode and no lens exist so far; the rest is shown disabled with the milestone that adds it.
// Run as skeleton (M3) runs the generated code in check mode; the run status sits next to it.

import type { RunView } from '../../core/protocol';
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
  const run = useUi((s) => s.run);
  const running = run?.state === 'running';
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
        <RunStatus run={run} />
        <button
          type="button"
          className="secondary"
          disabled={running}
          onClick={() => send({ type: 'run', mode: 'real' })}
          title="Run for real (not check mode), after a confirmation naming inventory and hosts"
          aria-label="Run for real"
        >
          <span className="codicon codicon-debug-alt" aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled={running}
          onClick={() => send({ type: 'run', mode: 'check' })}
          title="Generate the playbook and run it in check mode in the Ansible environment"
        >
          <span
            className={`codicon ${running ? 'codicon-loading codicon-modifier-spin' : 'codicon-play'}`}
            aria-hidden="true"
          />{' '}
          {running ? 'Running…' : 'Run as skeleton'}
        </button>
        <button type="button" onClick={() => send({ type: 'validate' })}>
          <span className="codicon codicon-check-all" aria-hidden="true" /> Validate design
        </button>
      </div>
    </header>
  );
}

/** Outcome of the last run: exit code, hosts, failures; a click shows the terminal. */
function RunStatus({ run }: { run: RunView | null }) {
  if (!run || run.state === 'running') return null;
  if (run.state === 'error')
    return (
      <span className="afd-run-status error" title={run.error} data-run-state="error">
        <span className="codicon codicon-error" aria-hidden="true" /> Run not started
      </span>
    );
  const s = run.summary;
  const failed = s ? Object.keys(s.outcome).length + s.failures.length : 0;
  const ok = run.rc === 0 && failed === 0;
  const label = s?.stoppedEarly
    ? `Stopped early · exit ${run.rc}`
    : `${s?.hosts.length ?? 0} hosts · ${failed} failed · exit ${run.rc}`;
  return (
    <button
      type="button"
      className={`afd-run-status ${ok ? 'ok' : 'warn'}`}
      data-run-state={run.state}
      onClick={() => send({ type: 'showRunOutput' })}
      title={`${run.mode === 'check' ? 'Skeleton run (check mode)' : 'Real run'} at ${run.finishedAt ?? run.startedAt} in ${run.environment ?? 'the environment'}. Show the terminal.`}
    >
      <span className={`codicon ${ok ? 'codicon-pass' : 'codicon-warning'}`} aria-hidden="true" />{' '}
      {label}
    </button>
  );
}
