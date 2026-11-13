// Top bar (04 §1): breadcrumb, key and version, mode toggle, lens, primary actions. Design,
// Implementation (M6) and Run (M7) modes; the lens (M8, D-18) is picked independently of mode.
// Run as skeleton (M3) runs the generated code in check mode; Re-sync from git (M6) compiles the
// code for Implementation mode; Launch in AWX (M7) runs the flow's job template. Since AFD-18 the
// lens is one dropdown, Run for real sits under Run as skeleton, and rarer actions (Tidy up, text,
// Validate design, the shortcuts) are in the "…" menu: fewer controls, every action still here.

import { modelOf, ROOT } from '../../core/flow/model';
import { LENSES } from '../../core/lens/types';
import type { RunView } from '../../core/protocol';
import { runVerdict } from '../../core/run/view';
import { scenarioChip } from '../../core/scenario/authoring';
import { chooseMode } from '../actions';
import { send } from '../bus';
import type { UiMenuEntry } from '../menu/Menu';
import { MenuButton } from '../menu/MenuButton';
import { MODES } from '../modes';
import { startRun } from '../runActions';
import { IS_MAC, keysOf } from '../shortcuts';
import { type Mode, useUi } from '../store';
import { inheritedContext, levelTrail } from '../viewModel';

export function TopBar() {
  const doc = useUi((s) => s.snapshot?.doc);
  const flow = doc?.flow;
  const level = useUi((s) => s.level);
  const setLevel = useUi((s) => s.setLevel);
  const trail = doc ? levelTrail(doc, level) : [];
  const chips = doc ? inheritedContext(doc, level) : [];
  const run = useUi((s) => s.run);
  const running = run?.state === 'running';
  const errors = useUi(
    (s) => s.snapshot?.findings.filter((f) => f.severity === 'error').length ?? 0,
  );
  const mode = useUi((s) => s.mode);
  // AFD-270: a viewer shows the flow and runs it; what changes the flow or its files is not there.
  const viewer = useUi((s) => s.viewer);
  const lens = useUi((s) => s.lens);
  const setLens = useUi((s) => s.setLens);
  const pickLens = (id: (typeof LENSES)[number]['id'] | null) => {
    setLens(id);
    send({ type: 'lens', lens: id });
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
        {/* The flow is the root of the trail (AFD-30): no "Flows" label that goes nowhere. */}
        {trail.map((t, i) => (
          <span key={t.id} className="afd-crumb">
            {i > 0 ? <span className="muted">/</span> : null}
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
          <span
            key={c.label}
            className={`afd-chip afd-context${c.applied ? '' : ' muted'}`}
            title={c.title}
            data-applied={c.applied}
          >
            {c.label}
          </span>
        ))}
        {flow ? (
          <span className="afd-chip mono" title="Flow key and version">
            {flow.key} · v{flow.version}
          </span>
        ) : null}
        {viewer ? null : <ScenarioChip />}
      </nav>
      <fieldset
        className="afd-segmented"
        aria-label="Mode"
        // AFD-270: a viewer stays in Run mode. The stylesheet sets `display`, so `hidden` alone
        // would not hide it.
        style={viewer ? { display: 'none' } : undefined}
      >
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={m.id === mode ? 'active' : ''}
            aria-pressed={m.id === mode}
            disabled={!!m.soon}
            onClick={() => chooseMode(m.id)}
            title={
              m.soon
                ? `${m.label} mode arrives in ${m.soon}`
                : `${m.hint} (${IS_MAC ? '⌥' : 'Alt+'}${MODES.indexOf(m) + 1})`
            }
          >
            {m.label}
          </button>
        ))}
      </fieldset>
      {/* AFD-72: lenses show facts about steps; a flow with none has nothing to show. */}
      {viewer ? null : lens || doc?.nodes?.some((n) => n?.type !== 'start' && n?.type !== 'end') ? (
        <LensPick lens={lens} pick={pickLens} />
      ) : null}
      <div className="afd-actions">
        <RunStatus run={run} />
        <RunActions running={running} viewer={viewer} />
        {viewer ? null : (
          <ActionButton
            icon="file-code"
            label="Generate Code"
            title="Write the playbooks in generated/ now"
            unavailable={
              errors > 0
                ? `Fix the ${errors} error${errors === 1 ? '' : 's'} first (see Problems)`
                : undefined
            }
            onClick={() => send({ type: 'generate' })}
          />
        )}
        <MenuButton
          label="More actions"
          className="secondary icon"
          title="More actions"
          items={() => (viewer ? viewerActions() : moreActions(mode, level))}
        >
          <span className="codicon codicon-ellipsis" aria-hidden="true" />
        </MenuButton>
      </div>
    </header>
  );
}

/**
 * AFD-116: the way in to scenarios: how they stand in the simulation, or an offer to add some.
 * A flow with no step yet has nothing to test, so it shows nothing.
 */
function ScenarioChip() {
  const check = useUi((s) => s.scenarioCheck);
  const open = useUi((s) => s.openScenarios);
  const steps = useUi((s) =>
    s.snapshot?.doc?.nodes?.some((n) => n?.type !== 'start' && n?.type !== 'end'),
  );
  if (!steps && !check?.file) return null;
  const chip = scenarioChip(check);
  return (
    <button
      type="button"
      className={`afd-chip afd-scenario-chip tone-${chip.tone}`}
      title={chip.title}
      data-scenario-chip={chip.tone}
      onClick={open}
    >
      <span className="codicon codicon-beaker" aria-hidden="true" /> {chip.label}
    </button>
  );
}

/** The lens as one dropdown (M8 lenses), with a quick way back to none. */
function LensPick({
  lens,
  pick,
}: {
  lens: (typeof LENSES)[number]['id'] | null;
  pick: (id: (typeof LENSES)[number]['id'] | null) => void;
}) {
  const current = LENSES.find((l) => l.id === lens);
  return (
    <div className="afd-lens-pick">
      <MenuButton
        label={current ? `Lens: ${current.label}` : 'Lens: none'}
        className={`secondary${current ? ' afd-lens-on' : ''}`}
        title="Lenses show chips, wires and findings across the flow"
        items={() => [
          {
            type: 'item',
            label: 'None',
            checked: lens === null,
            title: 'No lens: the mode decides what nodes show',
            onSelect: () => pick(null),
          },
          { type: 'separator' },
          ...LENSES.map(
            (l): UiMenuEntry => ({
              type: 'item',
              label: l.label,
              checked: l.id === lens,
              title: l.hint,
              onSelect: () => pick(l.id),
            }),
          ),
        ]}
      >
        <span className="codicon codicon-eye" aria-hidden="true" />{' '}
        {current ? `Lens: ${current.label}` : 'Lens'}{' '}
        <span className="codicon codicon-chevron-down" aria-hidden="true" />
      </MenuButton>
      {current ? (
        <button
          type="button"
          className="icon"
          aria-label="Clear lens"
          title="Clear lens"
          onClick={() => pick(null)}
        >
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** What the graph cannot do in a mode, or undefined in Design (AFD-45). */
export function readOnlyReason(mode: Mode): string | undefined {
  return mode === 'run'
    ? 'Run mode only reads: switch to Design to change the flow'
    : mode === 'code'
      ? 'The graph is read-only in Code mode (bindings stay editable): switch to Design'
      : undefined;
}

/** Actions used now and then: in the "…" menu instead of on the bar. */
/** Fold the palette and the side panel away for room, and back (AFD-48). */
function panelActions(mode: Mode): UiMenuEntry[] {
  const ui = useUi.getState();
  const panel: UiMenuEntry = {
    type: 'item',
    label: ui.panelCollapsed ? 'Show Side Panel' : 'Hide Side Panel',
    icon: 'layout-sidebar-right',
    onSelect: () => ui.setPanelCollapsed(!ui.panelCollapsed),
  };
  // AFD-65: this viewer's choice; the flow file keeps its annotations.
  const notes: UiMenuEntry = {
    type: 'item',
    label: ui.annotationsHidden ? 'Show Annotations' : 'Hide Annotations',
    icon: 'note',
    title: 'Notes, sections and text on the canvas',
    onSelect: () => ui.setAnnotationsHidden(!ui.annotationsHidden),
  };
  if (mode !== 'design') return [panel, notes];
  // AFD-73: the first-flow checklist, hidden for good from its card, comes back from here.
  const hidden = ui.firstFlow?.hidden ?? false;
  const checklist: UiMenuEntry = {
    type: 'item',
    label: hidden ? 'Show First-Flow Checklist' : 'Hide First-Flow Checklist',
    icon: 'checklist',
    title: 'Four things that make a first flow, on flows with one to five steps',
    onSelect: () => send({ type: 'firstFlow', hidden: !hidden }),
  };
  return [
    {
      type: 'item',
      label: ui.paletteCollapsed ? 'Expand Palette' : 'Collapse Palette',
      icon: 'layout-sidebar-left',
      onSelect: () => ui.setPaletteCollapsed(!ui.paletteCollapsed),
    },
    panel,
    notes,
    checklist,
  ];
}

function moreActions(mode: Mode, level: string): UiMenuEntry[] {
  return [
    {
      type: 'item',
      label: 'Tidy Up',
      icon: 'layout',
      title: 'Lay out the whole level again',
      disabled: readOnlyReason(mode),
      onSelect: () => send({ type: 'tidyUp', level }),
    },
    {
      type: 'item',
      label: 'Open in Text Editor',
      icon: 'go-to-file',
      title: 'Open the flow file in the text editor',
      onSelect: () => send({ type: 'openText' }),
    },
    {
      type: 'item',
      label: 'Check Flow',
      icon: 'check-all',
      title: 'Check the design, then the generated code in the Ansible environment',
      onSelect: () => send({ type: 'validate' }),
    },
    {
      type: 'item',
      label: 'Find Node…',
      icon: 'search',
      shortcut: keysOf('find'),
      title: 'Find a node on any level by title, key or binding',
      onSelect: () => useUi.getState().openFind(true),
    },
    // AFD-72: Export lives here, off the bar a newcomer reads.
    ...exportActions(level),
    { type: 'separator' },
    ...panelActions(mode),
    { type: 'separator' },
    {
      type: 'item',
      label: 'Keyboard Shortcuts',
      icon: 'keyboard',
      shortcut: '?',
      onSelect: () => useUi.getState().showCheatSheet(true),
    },
    {
      type: 'item',
      label: 'User Guide',
      icon: 'book',
      title: 'Tutorials and how-to pages, in a Markdown preview',
      onSelect: () => send({ type: 'openGuide' }),
    },
    {
      type: 'item',
      label: 'Send Feedback…',
      icon: 'feedback',
      title: 'A short form: what works, what is missing (opens in the browser)',
      onSelect: () => send({ type: 'sendFeedback' }),
    },
  ];
}

/** AFD-270: the "…" menu of a viewer: finding a node and arranging the view. */
function viewerActions(): UiMenuEntry[] {
  return [
    {
      type: 'item',
      label: 'Find Node…',
      icon: 'search',
      shortcut: keysOf('find'),
      title: 'Find a node on any level by title, key or binding',
      onSelect: () => useUi.getState().openFind(true),
    },
    { type: 'separator' },
    ...panelActions('run'),
    { type: 'separator' },
    {
      type: 'item',
      label: 'Keyboard Shortcuts',
      icon: 'keyboard',
      shortcut: '?',
      onSelect: () => useUi.getState().showCheatSheet(true),
    },
  ];
}

function exportActions(level: string): UiMenuEntry[] {
  return [
    {
      type: 'item',
      label: 'Export as draw.io Diagram…',
      icon: 'export',
      title: 'Every level as a page of a draw.io diagram, with the node details as shape data',
      onSelect: () => send({ type: 'export', format: 'drawio', level }),
    },
    {
      type: 'item',
      label: 'Export as Image…',
      icon: 'file-media',
      title: 'This level as an SVG or PNG image that draw.io also opens as a diagram',
      onSelect: () => send({ type: 'export', format: 'image', level }),
    },
  ];
}

/**
 * A toolbar button that stays in place when it cannot run (AFD-45): aria-disabled keeps its
 * tooltip, which says why (a disabled button shows none).
 */
function ActionButton({
  icon,
  label,
  title,
  unavailable,
  onClick,
}: {
  icon: string;
  label: string;
  title: string;
  unavailable?: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="secondary"
      aria-disabled={unavailable ? true : undefined}
      title={unavailable ?? title}
      onClick={() => !unavailable && onClick()}
    >
      <span className={`codicon codicon-${icon}`} aria-hidden="true" /> {label}
    </button>
  );
}

/**
 * Run ▾ in every mode (AFD-45): a skeleton run up front; a real run and AWX in its menu. While a
 * run is going the button is Stop (AFD-72), so there is no greyed Stop beside it the rest of the time.
 */
function RunActions({ running, viewer }: { running: boolean; viewer: boolean }) {
  const busy = running ? 'A run is going: stop it first' : undefined;
  return (
    <div className="afd-split">
      <button
        type="button"
        onClick={() => (running ? send({ type: 'stopRun' }) : startRun('check'))}
        title={
          running
            ? 'Stop the run: end the local run, or cancel the job or workflow in AWX'
            : viewer
              ? 'Run the flow in check mode: bound steps report what they would change'
              : 'Generate the code and run it in check mode in the local Ansible environment'
        }
      >
        <span
          className={`codicon ${running ? 'codicon-debug-stop' : 'codicon-play'}`}
          aria-hidden="true"
        />{' '}
        {running ? 'Stop' : 'Run as Skeleton'}
      </button>
      <MenuButton
        label="More run options"
        title="More run options"
        items={() => [
          {
            type: 'item',
            label: 'Run for Real…',
            icon: 'debug-alt',
            title: 'Run for real (not check mode), after a confirmation naming inventory and hosts',
            disabled: busy,
            onSelect: () => startRun('real'),
          },
          // AFD-270: a viewer's host runs the flow itself; scenarios and AWX are the editor's.
          ...(viewer
            ? []
            : ([
                {
                  type: 'item',
                  label: 'Run Scenarios',
                  icon: 'beaker',
                  title:
                    'Run the scenario tests next to the flow: every step as its stub on local hosts, then where each host ended',
                  disabled: busy,
                  onSelect: () => send({ type: 'runScenarios' }),
                },
                {
                  type: 'item',
                  label: 'Launch in AWX',
                  icon: 'rocket',
                  title:
                    "Launch the flow's AWX job template (the pushed commit of the AWX project) and follow its job events",
                  disabled: busy,
                  onSelect: () => send({ type: 'launchAwx' }),
                },
              ] as UiMenuEntry[])),
        ]}
      >
        <span className="codicon codicon-chevron-down" aria-hidden="true" />
      </MenuButton>
    </div>
  );
}

/**
 * A local run going (AFD-81): the step it is in, or that it has gone quiet (the terminal may wait
 * for input); a click shows the run's terminal.
 */
function LiveRun({ run }: { run: RunView }) {
  const doc = useUi((s) => s.snapshot?.doc);
  const at = run.summary?.running;
  const step = at && doc ? modelOf(doc).nodes.get(at)?.node.title : undefined;
  return (
    <button
      type="button"
      className={`afd-run-status${run.quiet ? ' warn' : ''}`}
      data-run-state="running"
      data-run-quiet={run.quiet ? 'true' : undefined}
      onClick={() => send({ type: 'showRunOutput' })}
      title={
        run.quiet
          ? 'No new events from the run for 20 s: a step may be slow, or waiting for input. Show the terminal.'
          : 'Show the terminal of the run.'
      }
    >
      <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />{' '}
      {run.quiet
        ? 'No new events for 20 s · Show Terminal'
        : step
          ? `Running: ${step}`
          : 'Running…'}
    </button>
  );
}

/** Outcome of the last run: exit code, hosts, failures; a click shows the terminal or the AWX job. */
function RunStatus({ run }: { run: RunView | null }) {
  if (run?.state === 'running' && run.awx)
    return (
      <button
        type="button"
        className="afd-run-status"
        data-run-state="running"
        onClick={() => send({ type: 'showRunOutput' })}
        title={`AWX ${run.awx.workflow ? 'workflow' : 'job'} ${run.awx.jobId} (${run.awx.status}). Open it in AWX.`}
      >
        <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" /> AWX{' '}
        {run.awx.workflow ? 'workflow' : 'job'} #{run.awx.jobId}
        {Object.values(run.awx.approvals ?? {}).some((a) => a.status === 'waiting')
          ? ' · waiting for approval'
          : ''}
      </button>
    );
  if (run?.state === 'running') return <LiveRun run={run} />;
  if (!run) return null;
  // AFD-84: a scenario on the canvas says which one and how it went.
  if (run.scenario)
    return (
      <span
        className={`afd-run-status ${run.scenario.passed ? 'ok' : 'warn'}`}
        data-run-state="scenario"
      >
        <span
          className={`codicon ${run.scenario.passed ? 'codicon-pass' : 'codicon-warning'}`}
          aria-hidden="true"
        />{' '}
        Scenario: {run.scenario.name} · {run.scenario.passed ? 'passed' : 'failed'}
      </span>
    );
  if (run.state === 'error')
    return (
      <span className="afd-run-status error" title={run.error} data-run-state="error">
        <span className="codicon codicon-error" aria-hidden="true" />{' '}
        {run.awx || run.summary ? 'Run interrupted' : 'Run not started'}
      </span>
    );
  const s = run.summary;
  // The same verdict as the run panel (AFD-30).
  const { ok, failed } = runVerdict(run);
  const where = run.awx ? `AWX #${run.awx.jobId} · ` : '';
  const label = s?.stoppedEarly
    ? `${where}Stopped early · exit ${run.rc}`
    : `${where}${s?.hosts.length ?? 0} hosts · ${failed} failed · exit ${run.rc}`;
  return (
    <button
      type="button"
      className={`afd-run-status ${ok ? 'ok' : 'warn'}`}
      data-run-state={run.state}
      onClick={() => send({ type: 'showRunOutput' })}
      title={`${run.mode === 'check' ? 'Skeleton run (check mode)' : 'Real run'} at ${run.finishedAt ?? run.startedAt} in ${run.environment ?? 'the environment'}. ${run.awx ? 'Open the job in AWX.' : 'Show the terminal.'}`}
    >
      <span className={`codicon ${ok ? 'codicon-pass' : 'codicon-warning'}`} aria-hidden="true" />{' '}
      {label}
    </button>
  );
}
