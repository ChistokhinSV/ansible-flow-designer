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
import { send } from '../bus';
import type { UiMenuEntry } from '../menu/Menu';
import { MenuButton } from '../menu/MenuButton';
import { type Mode, useUi } from '../store';
import { inheritedContext, levelTrail } from '../viewModel';

const MODES = [
  { id: 'design', label: 'Design' },
  { id: 'implementation', label: 'Implementation' },
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
  const mode = useUi((s) => s.mode);
  const sync = useUi((s) => s.sync);
  const lens = useUi((s) => s.lens);
  const setLens = useUi((s) => s.setLens);
  const pickLens = (id: (typeof LENSES)[number]['id'] | null) => {
    setLens(id);
    send({ type: 'lens', lens: id });
  };
  const choose = (id: Mode) => {
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
      <LensPick lens={lens} pick={pickLens} />
      <div className="afd-actions">
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
        {mode === 'run' ? (
          <button
            type="button"
            className="secondary"
            disabled={running}
            onClick={() => send({ type: 'run', mode: 'check' })}
            title="Generate the playbook and run it in check mode in the local Ansible environment"
          >
            <span className="codicon codicon-play" aria-hidden="true" /> Run as skeleton
          </button>
        ) : null}
        {mode !== 'design' ? <LaunchAwx running={running} /> : null}
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

/** Actions used now and then: in the "…" menu instead of on the bar. */
function moreActions(mode: Mode, level: string): UiMenuEntry[] {
  return [
    {
      type: 'item',
      label: 'Tidy up',
      icon: 'layout',
      title: 'Auto-layout the whole level',
      onSelect: () => send({ type: 'tidyUp', level }),
    },
    {
      type: 'item',
      label: 'Show as text',
      icon: 'go-to-file',
      title: 'Open the flow file as text',
      onSelect: () => send({ type: 'openText' }),
    },
    {
      type: 'item',
      label: 'Export as draw.io…',
      icon: 'export',
      title: 'Every level as a page of a draw.io diagram, with the node details as shape data',
      onSelect: () => send({ type: 'export', format: 'drawio', level }),
    },
    {
      type: 'item',
      label: 'Export as image…',
      icon: 'file-media',
      title: 'This level as an SVG or PNG image that draw.io also opens as a diagram',
      onSelect: () => send({ type: 'export', format: 'image', level }),
    },
    ...(mode === 'design'
      ? [
          {
            type: 'item' as const,
            label: 'Validate design',
            icon: 'check-all',
            title: 'Check the flow again and show the Problems panel',
            onSelect: () => send({ type: 'validate' }),
          },
        ]
      : []),
    { type: 'separator' },
    {
      type: 'item',
      label: 'Keyboard shortcuts',
      icon: 'keyboard',
      shortcut: '?',
      onSelect: () => useUi.getState().showCheatSheet(true),
    },
    {
      type: 'item',
      label: 'User guide',
      icon: 'book',
      title: 'Tutorials and how-to pages, in a Markdown preview',
      onSelect: () => send({ type: 'openGuide' }),
    },
  ];
}

/** Design mode's primary action (04 §1): run as skeleton; running for real is in its menu. */
function DesignActions({ running }: { running: boolean }) {
  return (
    <div className="afd-split">
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
      <MenuButton
        label="More run options"
        title="More run options"
        disabled={running}
        items={() => [
          {
            type: 'item',
            label: 'Run for real…',
            icon: 'debug-alt',
            title: 'Run for real (not check mode), after a confirmation naming inventory and hosts',
            onSelect: () => send({ type: 'run', mode: 'real' }),
          },
        ]}
      >
        <span className="codicon codicon-chevron-down" aria-hidden="true" />
      </MenuButton>
    </div>
  );
}

/** Implementation and Run modes (04 §1): run the flow's AWX job template. */
function LaunchAwx({ running }: { running: boolean }) {
  return (
    <button
      type="button"
      disabled={running}
      onClick={() => send({ type: 'launchAwx' })}
      title="Launch the flow's AWX job template (the pushed commit of the AWX project) and follow its job events"
    >
      <span
        className={`codicon ${running ? 'codicon-loading codicon-modifier-spin' : 'codicon-rocket'}`}
        aria-hidden="true"
      />{' '}
      {running ? 'Running…' : 'Launch in AWX'}
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
