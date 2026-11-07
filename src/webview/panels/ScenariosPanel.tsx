// The Scenarios tab (AFD-116): every scenario of the flow with its simulated verdict as the flow
// changes, the last verdict from Ansible and whether it still holds, and the actions that write the
// scenarios file for you: New Scenario (expectations from the simulation), Show on Canvas to plant
// outcomes with a step's menu, Accept New Ends, Verify in Ansible, Rename, Duplicate, Delete, Undo.
import { type FormEvent, useState } from 'react';
import {
  newHosts,
  newScenario,
  nextScenarioName,
  scenarioRows,
} from '../../core/scenario/authoring';
import type { ScenarioRequest } from '../../core/scenario/edit';
import { blocking } from '../../core/scenario/scenarios';
import { scenarioRequest, scenarioUndo, send } from '../bus';
import { useUi } from '../store';
import { HelpLink } from './HelpLink';

async function ask(req: ScenarioRequest): Promise<boolean> {
  const ack = await scenarioRequest(req);
  if (!ack.ok) useUi.getState().setError(ack.error ?? 'The scenarios file did not change');
  return ack.ok;
}

/** "5 min ago", for when a run in Ansible ran. */
function ago(at: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
  if (!Number.isFinite(s)) return at;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

function NewScenario({ close }: { close(): void }) {
  const check = useUi((s) => s.scenarioCheck);
  const doc = useUi((s) => s.snapshot?.doc);
  const edit = useUi((s) => s.editScenario);
  const [name, setName] = useState(() => nextScenarioName(check));
  const [count, setCount] = useState(3);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || !doc) return;
    // Expectations left out: the host writes where the simulation sends each host.
    const ok = await ask({ kind: 'add', scenario: newScenario(doc, n, count) });
    if (ok) {
      close();
      edit(n);
    }
  };
  return (
    <form className="afd-section afd-scenario-new" onSubmit={submit} data-scenario-new>
      <h3>New Scenario</h3>
      <div className="afd-field">
        <label htmlFor="afd-scenario-name">Name</label>
        <input
          id="afd-scenario-name"
          className="afd-input"
          value={name}
          // biome-ignore lint/a11y/noAutofocus: the form opens for this field
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="afd-field">
        <label htmlFor="afd-scenario-hosts">Hosts</label>
        <input
          id="afd-scenario-hosts"
          className="afd-input"
          type="number"
          min={1}
          max={50}
          value={count}
          onChange={(e) => setCount(Number(e.target.value) || 1)}
        />
        <p className="muted">
          {newHosts(count).join(', ')}: names only, they run on this machine with every step as its
          stub.
        </p>
      </div>
      <p className="muted">
        It starts with every host where the flow sends it now. Then plant failures: right-click a
        step on the canvas.
      </p>
      <div className="afd-modal-actions">
        <button type="button" className="secondary" onClick={close}>
          Cancel
        </button>
        <button type="submit" disabled={!name.trim()}>
          Add Scenario
        </button>
      </div>
    </form>
  );
}

function Rename({ name, close }: { name: string; close(): void }) {
  const [to, setTo] = useState(name);
  const edit = useUi((s) => s.editScenario);
  const editing = useUi((s) => s.scenarioEditing);
  return (
    <form
      className="afd-inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!to.trim() || to === name) return close();
        if (await ask({ kind: 'rename', name, to: to.trim() })) {
          if (editing === name) edit(to.trim());
          close();
        }
      }}
    >
      <input
        className="afd-input"
        aria-label={`New name for ${name}`}
        value={to}
        // biome-ignore lint/a11y/noAutofocus: the field opens on Rename
        autoFocus
        onChange={(e) => setTo(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
      />
      <button type="submit">Rename</button>
    </form>
  );
}

export function ScenariosPanel() {
  const doc = useUi((s) => s.snapshot?.doc);
  const check = useUi((s) => s.scenarioCheck);
  const undo = useUi((s) => s.scenarioUndo);
  const editing = useUi((s) => s.scenarioEditing);
  const edit = useUi((s) => s.editScenario);
  const closeTab = useUi((s) => s.closeScenarios);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  if (!doc) return null;
  const rows = check ? scenarioRows(doc, check) : [];
  const errors = check ? blocking(check.problems) : [];
  const failing = rows.filter((r) => r.verdict !== 'pass').length;
  return (
    <div className="afd-panel-body" data-scenarios-panel={rows.length}>
      <h2 className="afd-panel-title">
        Scenarios <HelpLink topic="scenarios" about="scenario tests" />
        <button
          type="button"
          className="icon afd-tab-close"
          aria-label="Close the Scenarios tab"
          title="Close the Scenarios tab (the chip in the top bar opens it again)"
          onClick={closeTab}
        >
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </h2>
      <p className="muted">
        Where each host must end when chosen steps fail. Checked in a simulation as you change the
        flow; Verify in Ansible runs them for real, every step as its stub.
      </p>
      <div className="afd-row-actions">
        <button type="button" onClick={() => setAdding(true)} disabled={adding}>
          <span className="codicon codicon-add" aria-hidden="true" /> New Scenario
        </button>
        {rows.length ? (
          <button
            type="button"
            className="secondary"
            onClick={() => send({ type: 'runScenarios' })}
            title="Run every scenario in the run environment, every step as its stub"
          >
            <span className="codicon codicon-play" aria-hidden="true" /> Verify All in Ansible
          </button>
        ) : null}
        {undo ? (
          <button
            type="button"
            className="secondary"
            data-scenario-undo={undo}
            onClick={async () => {
              const ack = await scenarioUndo();
              if (!ack.ok) useUi.getState().setError(ack.error ?? 'Nothing to undo');
            }}
            title="Take back the last change to the scenarios made here"
          >
            <span className="codicon codicon-discard" aria-hidden="true" /> Undo
          </button>
        ) : null}
        {check?.file ? (
          <button
            type="button"
            className="link"
            onClick={() => send({ type: 'openScenarios' })}
            title="The scenarios file in the text editor"
          >
            Open File
          </button>
        ) : null}
      </div>
      {adding ? <NewScenario close={() => setAdding(false)} /> : null}
      {check?.error || errors.length ? (
        <section className="afd-section tone-error" data-scenarios-errors={errors.length || 1}>
          <h3>The file does not fit the flow</h3>
          <ul>
            {check?.error ? <li>{check.error}</li> : null}
            {errors.map((p) => (
              <li key={`${p.scenario}:${p.path.join('.')}:${p.message}`}>{p.message}</li>
            ))}
          </ul>
          <p className="muted">Fix it in the file (Open File); Problems lists the same.</p>
        </section>
      ) : null}
      {editing ? (
        <p className="afd-scenario-editing" data-scenario-editing={editing}>
          On the canvas: <strong>{editing}</strong>, simulated. Right-click a step to make it fail
          for chosen hosts.{' '}
          <button type="button" className="link" onClick={() => edit(null)}>
            Done
          </button>
        </p>
      ) : null}
      {rows.length === 0 && !adding ? (
        <p className="muted" data-scenarios-empty>
          No scenarios yet. A scenario names some hosts, plants a failure or two, and says where
          each host must end, so a later change to the flow cannot quietly send them elsewhere.
        </p>
      ) : null}
      {rows.length ? (
        <h3 className="afd-subtitle">
          {failing ? `${failing} of ${rows.length} failing` : `All ${rows.length} pass`}{' '}
          <span className="muted">(simulated)</span>
        </h3>
      ) : null}
      <ul className="afd-scenario-list">
        {rows.map((r) => (
          <li
            key={r.name}
            className={`afd-scenario tone-${r.verdict === 'pass' ? 'ok' : r.verdict === 'fail' ? 'warn' : 'error'}${editing === r.name ? ' active' : ''}`}
            data-scenario={r.name}
            data-verdict={r.verdict}
          >
            {renaming === r.name ? (
              <Rename name={r.name} close={() => setRenaming(null)} />
            ) : (
              <div className="afd-scenario-head">
                <span className="afd-scenario-verdict">
                  {r.verdict === 'pass' ? 'pass' : r.verdict === 'fail' ? 'fail' : 'cannot tell'}
                </span>
                <strong>{r.name}</strong>
                <span className="muted"> · {r.hosts.length} hosts</span>
              </div>
            )}
            {r.planted.length ? (
              <p className="muted" data-scenario-planted>
                {r.planted.join('; ')}
              </p>
            ) : null}
            {r.error ? <p className="tone-error">{r.error}</p> : null}
            {r.misses.length ? (
              <ul className="afd-scenario-misses" data-scenario-misses={r.misses.length}>
                {r.misses.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : null}
            {r.bestEffort.length ? (
              <p className="muted" data-scenario-best-effort title={r.bestEffort.join('\n')}>
                Simulated as a best effort: {r.bestEffort[0]}. Verify it in Ansible.
              </p>
            ) : null}
            {r.verified ? (
              <p className="muted" data-scenario-verified={r.verified.stale ? 'stale' : 'current'}>
                Ansible: {r.verified.passed ? 'passed' : 'failed'} {ago(r.verified.at)}
                {r.verified.stale ? ' · out of date: the flow or the scenario changed since' : ''}
              </p>
            ) : null}
            <div className="afd-row-actions">
              <button
                type="button"
                className={editing === r.name ? '' : 'secondary'}
                aria-pressed={editing === r.name}
                onClick={() => edit(editing === r.name ? null : r.name)}
                title="Show this scenario's simulation on the canvas, and plant outcomes there"
              >
                Show on Canvas
              </button>
              {r.verdict === 'fail' ? (
                <button
                  type="button"
                  className="secondary"
                  data-accept-ends
                  onClick={() => void ask({ kind: 'acceptEnds', name: r.name })}
                  title="Expect each host where the flow now sends it"
                >
                  Accept New Ends
                </button>
              ) : null}
              <button
                type="button"
                className="secondary"
                onClick={() => send({ type: 'runScenarios', names: [r.name] })}
                title="Run this scenario in the run environment, every step as its stub"
              >
                Verify in Ansible
              </button>
              <button type="button" className="link" onClick={() => setRenaming(r.name)}>
                Rename
              </button>
              <button
                type="button"
                className="link"
                onClick={() =>
                  void ask({ kind: 'duplicate', name: r.name, to: `${r.name} (copy)` })
                }
              >
                Duplicate
              </button>
              <button
                type="button"
                className="link"
                onClick={async () => {
                  if (await ask({ kind: 'delete', name: r.name }))
                    if (editing === r.name) edit(null);
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
