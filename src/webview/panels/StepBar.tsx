// Step-by-step runs on the canvas (AFD-346, ADR-0039): Step, Continue, Pause and Stop while such a
// run goes, where it waits and which hosts wait there, and, once it ended, where it was stopped.
// Shown only where the host runs flows step by step (VS Code; a server's pages later, AFS-177).
import { useEffect, useState } from 'react';
import { modelOf } from '../../core/flow/model';
import type { Ulid } from '../../core/flow/types';
import type { RunView } from '../../core/protocol';
import { pausedLine } from '../../core/run/step';
import { stepRun } from '../runActions';
import { useUi } from '../store';

/** The title of a node of the flow shown, or its id. */
export function useTitle(id: Ulid | undefined): string {
  const doc = useUi((s) => s.snapshot?.doc);
  if (!id) return '';
  return (doc && modelOf(doc).nodes.get(id)?.node.title) || id;
}

/** The step-by-step run going, when this host drives it. */
export function useStepping(): RunView | undefined {
  const run = useUi((s) => s.run);
  const stepRuns = useUi((s) => s.stepRuns);
  return stepRuns && run?.state === 'running' && run.step && !run.past ? run : undefined;
}

/** A clock for "stops by itself in", once a minute is enough but seconds read better near 0. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** Step, Continue, Pause and Stop, with their keys. */
export function StepButtons({ compact, stop = true }: { compact?: boolean; stop?: boolean }) {
  const run = useStepping();
  if (!run?.step) return null;
  const paused = !!run.step.paused;
  const button = (
    command: 'step' | 'continue' | 'pause' | 'stop',
    icon: string,
    label: string,
    key: string,
    title: string,
    disabled?: string,
  ) => (
    <button
      type="button"
      className={`secondary afd-step-button${compact ? ' icon' : ''}`}
      data-step-command={command}
      aria-disabled={disabled ? true : undefined}
      aria-label={compact ? `${label} (${key})` : undefined}
      title={`${disabled ?? title} (${key})`}
      onClick={() => !disabled && stepRun(command)}
    >
      <span className={`codicon codicon-${icon}`} aria-hidden="true" />
      {compact ? null : ` ${label}`}
    </button>
  );
  const going = paused ? undefined : 'The run is going: it pauses before its next step';
  return (
    <fieldset className="afd-step-buttons" aria-label="Step-by-step run">
      {button('step', 'debug-step-over', 'Step', 'F10', 'Run this step, then pause', going)}
      {button(
        'continue',
        'debug-continue',
        'Continue',
        'F5',
        'Run on to the next pause point or the end',
        going,
      )}
      {paused ? null : button('pause', 'debug-pause', 'Pause', 'F6', 'Pause before the next step')}
      {stop
        ? button(
            'stop',
            'debug-stop',
            'Stop',
            'Shift+F5',
            paused
              ? 'End the run here: the hosts stop before this step'
              : 'End the run now (the step going is cut off)',
          )
        : null}
    </fieldset>
  );
}

/** The Run panel's part of a step-by-step run: where it waits, the hosts there, the buttons. */
export function StepSection({ run }: { run: RunView }) {
  const step = run.step;
  const stepRuns = useUi((s) => s.stepRuns);
  const points = useUi((s) => s.pausePoints);
  const going = run.state === 'running';
  const now = useNow(going && !!step?.paused);
  const pausedTitle = useTitle(step?.paused?.node);
  const stoppedTitle = useTitle(step?.stopped?.node);
  if (!step) return null;
  const reveal = (id: Ulid) => useUi.getState().reveal(id);
  return (
    <section className="afd-section afd-step-section" data-step-run={going ? 'going' : 'ended'}>
      <h3>Step by step</h3>
      {going && step.paused ? (
        <>
          <p data-step-paused={step.paused.node}>
            <span className="codicon codicon-debug-pause" aria-hidden="true" />{' '}
            {pausedLine(step.paused, pausedTitle, now)}{' '}
            <button type="button" className="link" onClick={() => reveal(step.paused?.node ?? '')}>
              Show
            </button>
          </p>
          <p className="muted">Waiting there: {step.paused.hosts.join(', ') || 'no host'}</p>
        </>
      ) : going ? (
        <p className="muted" data-step-going>
          {step.every
            ? 'Running a step; the run pauses before the next one.'
            : 'Running on to the next pause point.'}
        </p>
      ) : step.stopped ? (
        <>
          <p data-step-stopped={step.stopped.node}>
            {step.stopped.reason === 'timeout' ? (run.error ?? 'Stopped') : 'Stopped'}
            {step.stopped.reason === 'timeout' ? '' : ` before ${stoppedTitle}`}
          </p>
          <ul className="afd-run-hosts" data-step-stopped-hosts={step.stopped.hosts.length}>
            {step.stopped.hosts.map((h) => (
              <li key={h}>
                <span className="mono">{h}</span>{' '}
                <span className="muted">stopped before {stoppedTitle}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">
          Ran step by step: paused {step.pauses} time{step.pauses === 1 ? '' : 's'}.
        </p>
      )}
      {going && stepRuns ? <StepButtons /> : null}
      {stepRuns ? (
        <p className="muted" data-pause-points={points.length}>
          {points.length
            ? `${points.length} pause point${points.length === 1 ? '' : 's'}: Continue runs on to the next one.`
            : 'No pause point: Continue runs to the end. Right-click a step to add one.'}
        </p>
      ) : null}
    </section>
  );
}
