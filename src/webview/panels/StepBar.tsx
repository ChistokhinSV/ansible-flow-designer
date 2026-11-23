// Step-by-step runs on the canvas (AFD-346, ADR-0039): Step, Continue, Pause and Stop while such a
// run goes, where it waits and which hosts wait there, and, once it ended, where it was stopped.
// Shown only where the host runs flows step by step (VS Code; a server's pages, AFS-177).
import { useEffect, useState } from 'react';
import { modelOf } from '../../core/flow/model';
import type { Ulid } from '../../core/flow/types';
import type { RunView } from '../../core/protocol';
import { pausedLine, runningLine, type StepCommand, stepPath } from '../../core/run/step';
import { stepRun } from '../runActions';
import { useUi } from '../store';
import { inVsCode } from '../transport';

/**
 * AFS-205: a node of the flow shown by its path from the top level ("Pre-checks › Read device
 * status"), or its id.
 */
export function useTitle(id: Ulid | undefined): string {
  const doc = useUi((s) => s.snapshot?.doc);
  if (!id) return '';
  return doc ? stepPath(modelOf(doc), id) : id;
}

/** The step-by-step run going, when this host drives it. */
export function useStepping(): RunView | undefined {
  const run = useUi((s) => s.run);
  const stepRuns = useUi((s) => s.stepRuns);
  return stepRuns && run?.state === 'running' && run.step && !run.past ? run : undefined;
}

/**
 * AFS-205: the keys of Step, Continue, Pause and Stop. VS Code's are its debugger's (its own key
 * bindings run them). A web page cannot take F5 (it reloads the page): there F10 steps and F8
 * goes on or pauses, as a browser's developer tools do; Stop has no key there.
 */
export function stepKeys(web = !inVsCode()): Partial<Record<StepCommand, string>> {
  return web
    ? { step: 'F10', continue: 'F8', pause: 'F8' }
    : { step: 'F10', continue: 'F5', pause: 'F6', stop: 'Shift+F5' };
}

/** "Step (F10), Continue (F5), Stop (Shift+F5)": what goes on from a pause, with the keys. */
export function stepKeysLine(web = !inVsCode()): string {
  const keys = stepKeys(web);
  const named = (label: string, key: string | undefined) => (key ? `${label} (${key})` : label);
  return `${named('Step', keys.step)}, ${named('Continue', keys.continue)}, ${named('Stop', keys.stop)}`;
}

/**
 * AFS-205: the command a key gives a step-by-step run in a web page; none for other keys. VS Code
 * runs its own key bindings, so there this answers none.
 */
export function stepKeyCommand(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  paused: boolean,
  web = !inVsCode(),
): StepCommand | undefined {
  if (!web || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return undefined;
  if (e.key === 'F10') return paused ? 'step' : undefined;
  if (e.key === 'F8') return paused ? 'continue' : 'pause';
  return undefined;
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
  const keys = stepKeys();
  const button = (
    command: StepCommand,
    icon: string,
    label: string,
    title: string,
    disabled?: string,
  ) => {
    const key = keys[command];
    const named = key ? `${label} (${key})` : label;
    return (
      <button
        type="button"
        className={`secondary afd-step-button${compact ? ' icon' : ''}`}
        data-step-command={command}
        aria-disabled={disabled ? true : undefined}
        aria-label={compact ? named : undefined}
        title={key ? `${disabled ?? title} (${key})` : (disabled ?? title)}
        onClick={() => !disabled && stepRun(command)}
      >
        <span className={`codicon codicon-${icon}`} aria-hidden="true" />
        {compact ? null : ` ${label}`}
      </button>
    );
  };
  const going = paused ? undefined : 'The run is going: it pauses before its next step';
  // AFS-205: Continue and Pause share one place (one button), so the focus stays on it when one
  // turns into the other; Step stays, waiting for the next pause.
  const goOrPause = paused
    ? button('continue', 'debug-continue', 'Continue', 'Run on to the next pause point or the end')
    : button('pause', 'debug-pause', 'Pause', 'Pause before the next step');
  return (
    <fieldset className="afd-step-buttons" aria-label="Step-by-step run">
      {button('step', 'debug-step-over', 'Step', 'Run this step, then pause', going)}
      {goOrPause}
      {stop
        ? button(
            'stop',
            'debug-stop',
            'Stop',
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
  const runningTitle = useTitle(step?.running?.node ?? run.summary?.running);
  const stoppedTitle = useTitle(step?.stopped?.node);
  if (!step) return null;
  const reveal = (id: Ulid) => useUi.getState().reveal(id);
  const pausePoint = !!step.paused && step.points.includes(step.paused.node);
  return (
    <section className="afd-section afd-step-section" data-step-run={going ? 'going' : 'ended'}>
      <h3>Step by step</h3>
      {/* AFS-205: said to a screen reader as it changes (paused, running, stopped). */}
      <div aria-live="polite">
        {going && step.paused ? (
          <>
            <p data-step-paused={step.paused.node}>
              <span className="codicon codicon-debug-pause" aria-hidden="true" />{' '}
              {pausedLine(step.paused, pausedTitle, now)}
              {pausePoint ? ' · a pause point' : ''}{' '}
              <button
                type="button"
                className="link"
                onClick={() => reveal(step.paused?.node ?? '')}
              >
                Show
              </button>
            </p>
            <p className="muted">Waiting there: {step.paused.hosts.join(', ') || 'no host'}</p>
          </>
        ) : going ? (
          <p className="muted" data-step-going>
            {runningLine(runningTitle || undefined, step.every)}{' '}
            {step.every
              ? 'The run pauses before the next step.'
              : 'The run pauses at the next pause point.'}
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
      </div>
      {going && stepRuns ? <StepButtons /> : null}
      {/* AFS-205: a reader who may not go on is told who may. */}
      {going && !stepRuns && step.paused && step.who ? (
        <p className="muted" data-step-who>
          Waiting for {step.who} to go on.
        </p>
      ) : null}
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
