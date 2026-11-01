// Top bar (04 §1): breadcrumb, key and version, mode toggle, lens, primary actions. Design,
// Implementation (M6) and Run (M7) modes; the lens (M8, D-18) is picked independently of mode.
// Run as skeleton (M3) runs the generated code in check mode; Re-sync from git (M6) compiles the
// code for Implementation mode; Launch in AWX (M7) runs the flow's job template. Since AFD-18 the
// lens is one dropdown, Run for real sits under Run as skeleton, and rarer actions (Tidy up, text,
// Validate design, the shortcuts) are in the "…" menu: fewer controls, every action still here.

import { ROOT } from '../../core/flow/model';
import { LENSES } from '../../core/lens/types';
import type { RunView } from '../../core/protocol';
import { runVerdict } from '../../core/run/view';
import { chooseMode } from '../actions';
import { send } from '../bus';
import type { UiMenuEntry } from '../menu/Menu';
import { MenuButton } from '../menu/MenuButton';
import { keysOf } from '../shortcuts';
import { type Mode, useUi } from '../store';
import { inheritedContext, levelTrail } from '../viewModel';

const MODES = [
  { id: 'design', label: 'Design' },
  { id: 'code', label: 'Code' },
  { id: 'run', label: 'Run' },
] as { id: Mode; label: string; soon?: string }[];

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
      </nav>
      <fieldset className="afd-segmented" aria-label="Mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={m.id === mode ? 'active' : ''}
            aria-pressed={m.id === mode}
            disabled={!!m.soon}
            onClick={() => chooseMode(m.id)}
            title={m.soon ? `${m.label} mode arrives in ${m.soon}` : undefined}
          >
            {m.label}
          </button>
        ))}
      </fieldset>
      <LensPick lens={lens} pick={pickLens} />
      <div className="afd-actions">
        <RunStatus run={run} />
        <RunActions running={running} />
        <ActionButton
          icon="debug-stop"
          label="Stop"
          title="Stop the run: end the local run, or cancel the job or workflow in AWX"
          unavailable={running ? undefined : 'No run is going'}
          onClick={() => send({ type: 'stopRun' })}
        />
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
        <MenuButton
          label="Export"
          className="secondary"
          title="Export the flow as a diagram"
          items={() => exportActions(level)}
        >
          <span className="codicon codicon-export" aria-hidden="true" /> Export{' '}
          <span className="codicon codicon-chevron-down" aria-hidden="true" />
        </MenuButton>
        <MenuButton
          label="More actions"
          className="secondary icon"
          title="More actions"
          items={() => moreActions(mode, level)}
        >
          <span className="codicon codicon-ellipsis" aria-hidden="true" />
        </MenuButton>
      </div>
    </header>
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
              title: `${l.label} lens: chips, wires and findings across the flow`,
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
  if (mode !== 'design') return [panel];
  return [
    {
      type: 'item',
      label: ui.paletteCollapsed ? 'Expand Palette' : 'Collapse Palette',
      icon: 'layout-sidebar-left',
      onSelect: () => ui.setPaletteCollapsed(!ui.paletteCollapsed),
    },
    panel,
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

/** Run ▾ in every mode (AFD-45): a skeleton run up front; a real run and AWX in its menu. */
function RunActions({ running }: { running: boolean }) {
  const busy = running ? 'A run is going: stop it first' : undefined;
  return (
    <div className="afd-split">
      <button
        type="button"
        aria-disabled={busy ? true : undefined}
        onClick={() => !busy && send({ type: 'run', mode: 'check' })}
        title={
          busy ?? 'Generate the code and run it in check mode in the local Ansible environment'
        }
      >
        <span
          className={`codicon ${running ? 'codicon-loading codicon-modifier-spin' : 'codicon-play'}`}
          aria-hidden="true"
        />{' '}
        {running ? 'Running…' : 'Run as Skeleton'}
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
            onSelect: () => send({ type: 'run', mode: 'real' }),
          },
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
        ]}
      >
        <span className="codicon codicon-chevron-down" aria-hidden="true" />
      </MenuButton>
    </div>
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
  if (!run || run.state === 'running') return null;
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
