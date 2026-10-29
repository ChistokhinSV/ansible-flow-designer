// Top bar (04 §1): breadcrumb, key and version, mode and lens toggles, primary actions. Design and
// Implementation (M6) exist; Run mode and the lenses are shown disabled with their milestone.
// Run as skeleton (M3) runs the generated code in check mode; Re-sync from git (M6) compiles the
// code for Implementation mode.

import { ROOT } from '../../core/flow/model';
import type { RunView } from '../../core/protocol';
import { send } from '../bus';
import { useUi } from '../store';
import { inheritedContext, levelTrail } from '../viewModel';

const MODES = [
  { id: 'design', label: 'Design' },
  { id: 'implementation', label: 'Implementation' },
  { id: 'run', label: 'Run', soon: 'M7' },
];
const LENSES = ['None', 'Inventory', 'Data', 'Code', 'Access', 'Timing'];

export function TopBar() {
  const doc = useUi((s) => s.snapshot?.doc);
  const flow = doc?.flow;
  const level = useUi((s) => s.level);
  const setLevel = useUi((s) => s.setLevel);
  const trail = doc ? levelTrail(doc, level) : [];
  const chips = doc ? inheritedContext(doc, level) : [];
  const run = useUi((s) => s.run);
  const running = run?.state === 'running';
  const mode = useUi((s) => s.mode);
  const sync = useUi((s) => s.sync);
  const choose = (id: string) => {
    if (id !== 'design' && id !== 'implementation') return;
    useUi.getState().setMode(id);
    // The first visit compiles the code; later ones show the last scan (Re-sync refreshes it).
    if (id === 'implementation' && sync.state === 'idle') send({ type: 'sync' });
  };
  return (
    <header className="afd-topbar">
      <nav className="afd-breadcrumb" aria-label="Breadcrumb">
        {level !== ROOT ? (
          <button
            type="button"
            className="secondary afd-back"
            onClick={() => setLevel(trail.at(-2)?.id ?? ROOT)}
            title="Back to the enclosing level"
          >
            <span className="codicon codicon-arrow-left" aria-hidden="true" /> Back
          </button>
        ) : null}
        <span className="muted">Flows</span>
        {trail.map((t, i) => (
          <span key={t.id} className="afd-crumb">
            <span className="muted">/</span>
            {i < trail.length - 1 ? (
              <button type="button" className="link" onClick={() => setLevel(t.id)}>
                {i === 0 ? (flow?.name ?? 'Untitled flow') : t.title}
              </button>
            ) : (
              <span className="afd-flow-name" aria-current="location">
                {i === 0 ? (flow?.name ?? 'Untitled flow') : t.title}
              </span>
            )}
          </span>
        ))}
        {chips.map((c) => (
          <span key={c.label} className="afd-chip afd-context" title={c.title}>
            {c.label}
          </span>
        ))}
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
            className={m.id === mode ? 'active' : ''}
            aria-pressed={m.id === mode}
            disabled={!!m.soon}
            onClick={() => choose(m.id)}
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
          onClick={() => send({ type: 'tidyUp', level })}
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
        {mode === 'implementation' ? (
          <button
            type="button"
            disabled={sync.state === 'syncing'}
            onClick={() => send({ type: 'sync' })}
            title="Compile the generated code and the bound roles and playbooks in the environment, and compare them with the design"
          >
            <span
              className={`codicon ${sync.state === 'syncing' ? 'codicon-loading codicon-modifier-spin' : 'codicon-sync'}`}
              aria-hidden="true"
            />{' '}
            {sync.state === 'syncing' ? 'Syncing…' : 'Re-sync from git'}
          </button>
        ) : null}
        <RunStatus run={run} />
        {mode === 'design' ? <DesignActions running={running} /> : null}
      </div>
    </header>
  );
}

/** Design mode's primary actions (04 §1): run as skeleton or for real, validate. */
function DesignActions({ running }: { running: boolean }) {
  return (
    <>
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
    </>
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
