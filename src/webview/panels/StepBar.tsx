// Step-by-step runs on the canvas (AFD-346, ADR-0039): Step, Continue, Pause and Stop while such a
// run goes, where it waits and which hosts wait there, and, once it ended, where it was stopped.
// Shown only where the host runs flows step by step (VS Code; a server's pages, AFS-177).
import { useEffect, useState } from 'react';
import { modelOf } from '../../core/flow/model';
import type { Ulid } from '../../core/flow/types';
import type { RunView } from '../../core/protocol';
import { failedLines, reasonLine, retryWarning } from '../../core/run/debug';
import {
  pausedLine,
  runningLine,
  type StepCommand,
  type StepPause,
  stepPath,
  stopsIn,
} from '../../core/run/step';
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
/** The hosts that left a step through a failure port (failed or unreachable). */
function failedAt(run: RunView, node: Ulid | undefined): Set<string> {
  const ports = node ? run.summary?.nodes?.[node] : undefined;
  return new Set(
    Object.entries(ports ?? {})
      .filter(([port]) => port.startsWith('failed') || port.startsWith('unreachable'))
      .flatMap(([, hosts]) => hosts),
  );
}

type Stopped = NonNullable<NonNullable<RunView['step']>['stopped']>;

/** "after" a failure pause's step (it ran), "at" a step hosts failed, else "before". */
function stoppedWhere(run: RunView, stopped: Stopped): string {
  if (stopped.after) return 'after';
  return failedAt(run, stopped.node).size ? 'at' : 'before';
}

/**
 * The hosts a stopped run left at its step: those that stopped there and (AFD-379) those that
 * failed the step at a failure pause, which the stop lists apart.
 */
function stoppedHosts(run: RunView, stopped: Stopped): { host: string; failed: boolean }[] {
  const failed = new Set([...(stopped.failed ?? []), ...failedAt(run, stopped.node)]);
  const all = [...new Set([...stopped.hosts, ...(stopped.failed ?? [])])];
  return all.map((host) => ({ host, failed: failed.has(host) }));
}

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
  // ADR-0040 §7 (AFD-372): at a failure pause, Retry first; where it is not offered, its words.
  const failure = run.step.paused?.kind === 'failure' ? run.step.paused : undefined;
  const retry = failure ? <RetryButton pause={failure} compact={compact} /> : null;
  // AFS-205: Continue and Pause share one place (one button), so the focus stays on it when one
  // turns into the other; Step stays, waiting for the next pause.
  const goOrPause = paused
    ? button('continue', 'debug-continue', 'Continue', 'Run on to the next pause point or the end')
    : button('pause', 'debug-pause', 'Pause', 'Pause before the next step');
  return (
    <fieldset className="afd-step-buttons" aria-label="Step-by-step run">
      {retry}
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

/** AFD-371: what the log points wrote (and conditions that failed), the newest last. */
function PointLogs({ logs }: { logs: NonNullable<RunView['step']>['logs'] }) {
  const doc = useUi((s) => s.snapshot?.doc);
  const shown = (logs ?? []).slice(-50);
  const title = (id: Ulid) => (doc ? stepPath(modelOf(doc), id) : id);
  return (
    <details className="afd-point-logs" data-point-logs={logs?.length ?? 0}>
      <summary>Log points ({logs?.length ?? 0})</summary>
      <ul className="afd-run-hosts">
        {shown.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: log lines repeat; their order is the key.
          <li key={i} className={l.error ? 'tone-warn' : undefined}>
            <span className="muted">{title(l.node)}</span>{' '}
            {l.host ? <span className="mono">{l.host}: </span> : null}
            {l.error
              ? `${l.source === 'condition' ? 'condition' : 'message'} failed: ${l.error}`
              : l.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * AFD-379: why Retry is not offered, as one sentence. The engine's reason may already say "Retry is
 * not offered …" and end with a full stop ("Retry is not offered here: Retry is not offered for …..").
 */
export function refusedLine(reason: string): string {
  const said = reason.trim().replace(/[.\s]+$/, '');
  return /^retry is not offered/i.test(said) ? `${said}.` : `Retry is not offered here: ${said}.`;
}

/** Retry at a failure pause: says that the step runs again; where refused, why (disabled). */
function RetryButton({ pause, compact }: { pause: StepPause; compact?: boolean }) {
  const title = useTitle(pause.node);
  const refused = pause.retryRefused;
  const words = refused ? refusedLine(refused) : retryWarning(pause, title);
  return (
    <button
      type="button"
      className={`secondary afd-step-button${compact ? ' icon' : ''}`}
      data-step-command="retry"
      aria-disabled={refused ? true : undefined}
      aria-label={compact ? 'Retry' : undefined}
      title={words}
      onClick={() => !refused && stepRun('retry')}
    >
      <span className="codicon codicon-debug-restart" aria-hidden="true" />
      {compact ? null : ' Retry'}
    </button>
  );
}

/**
 * The line of a paused run: a debug run's reason (the step, the hosts and why), or 1.1's line;
 * with how long until it stops by itself.
 */
export function pauseLine(
  pause: StepPause,
  title: string,
  now: number,
  pointHere: boolean,
): string {
  if (!pause.kind) return `${pausedLine(pause, title, now)}${pointHere ? ' · a pause point' : ''}`;
  return `${reasonLine(pause, title, pointHere)} · stops by itself in ${stopsIn(pause, now)}`;
}

/** What a failure pause says under its line: the hosts and why, then Retry's warning or refusal. */
function FailureNote({ pause, title }: { pause: StepPause; title: string }) {
  const lines = failedLines(pause);
  return (
    <>
      <ul className="afd-run-hosts" data-failed-hosts={lines.length}>
        {lines.slice(0, 5).map((l) => (
          <li key={l} className="mono">
            {l}
          </li>
        ))}
        {lines.length > 5 ? <li className="muted">and {lines.length - 5} more</li> : null}
      </ul>
      <p
        className="muted afd-failure-note"
        data-retry-note={pause.retryRefused ? 'refused' : 'warn'}
      >
        {pause.retryRefused
          ? `${refusedLine(pause.retryRefused)} Continue routes the failed hosts as the flow says; Stop ends the run.`
          : `${retryWarning(pause, title)} Continue routes the failed hosts as the flow says; Stop ends the run.`}
      </p>
    </>
  );
}

/**
 * AFD-372: a failure pause over the canvas: the reason line, the failed hosts, Retry (with its
 * warning), Continue and Stop where this host drives the run; the reason alone for a reader.
 */
export function FailureBar() {
  const run = useUi((s) => s.run);
  const stepRuns = useUi((s) => s.stepRuns);
  const pause =
    run?.state === 'running' && !run.past && run.step?.paused?.kind === 'failure'
      ? run.step.paused
      : undefined;
  const title = useTitle(pause?.node);
  const now = useNow(!!pause);
  if (!pause) return null;
  return (
    <section className="afd-failure-bar" role="status" data-failure-bar={pause.id}>
      <span className="codicon codicon-error" aria-hidden="true" />
      <span className="afd-failure-reason">{pauseLine(pause, title, now, false)}</span>
      {stepRuns ? <StepButtons compact={false} /> : null}
      <FailureNote pause={pause} title={title} />
    </section>
  );
}

/** What Continue does, by the pause points: at the only one, it runs to the end. */
export function continueLine(points: readonly Ulid[], pausedAt: Ulid | undefined): string {
  const ahead = points.filter((p) => p !== pausedAt).length;
  if (points.length === 0)
    return 'No pause point: Continue runs to the end. Right-click a step to add one.';
  const n = `${points.length} pause point${points.length === 1 ? '' : 's'}`;
  return ahead === 0
    ? `${n}: Continue runs to the end (this is the only one).`
    : `${n}: Continue runs on to the next one.`;
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
      {/* AFD-379: a debug run is named as one. */}
      <h3>{step.debug ? 'Debug' : 'Step by step'}</h3>
      {/* AFS-205: said to a screen reader as it changes (paused, running, stopped). */}
      <div aria-live="polite">
        {going && step.paused ? (
          <>
            <p data-step-paused={step.paused.node}>
              <span className="codicon codicon-debug-pause" aria-hidden="true" />{' '}
              {pauseLine(step.paused, pausedTitle, now, pausePoint)}{' '}
              <button
                type="button"
                className="link"
                onClick={() => reveal(step.paused?.node ?? '')}
              >
                Show
              </button>
            </p>
            <p className="muted">Waiting there: {step.paused.hosts.join(', ') || 'no host'}</p>
            {step.paused.kind === 'failure' ? (
              <FailureNote pause={step.paused} title={pausedTitle} />
            ) : null}
            {step.refused && step.refused.pause === step.paused.id ? (
              <p className="muted" data-step-refused>
                {step.refused.why}
              </p>
            ) : null}
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
              {step.stopped.reason === 'timeout'
                ? ''
                : ` ${stoppedWhere(run, step.stopped)} ${stoppedTitle}`}
            </p>
            <ul
              className="afd-run-hosts"
              data-step-stopped-hosts={stoppedHosts(run, step.stopped).length}
            >
              {stoppedHosts(run, step.stopped).map(({ host, failed }) => (
                <li key={host}>
                  <span className="mono">{host}</span>{' '}
                  {/* AFD-378, AFD-379: stopped at a failure pause, the step ran: a host that failed
                      it says so, the others stopped after it, not before. */}
                  <span className="muted" data-stopped-host={failed ? 'failed' : 'stopped'}>
                    {failed
                      ? `failed ${stoppedTitle}, then stopped`
                      : `stopped ${step.stopped?.after ? 'after' : 'before'} ${stoppedTitle}`}
                  </span>
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
      {step.logs?.length ? <PointLogs logs={step.logs} /> : null}
      {/* AFS-205: a reader who may not go on is told who may. */}
      {going && !stepRuns && step.paused && step.who ? (
        <p className="muted" data-step-who>
          Waiting for {step.who} to go on.
        </p>
      ) : null}
      {/* AFD-379: what Continue does is said while there is a run to continue, not after it. */}
      {going && stepRuns ? (
        <p className="muted" data-pause-points={points.length}>
          {continueLine(points, step.paused?.node)}
        </p>
      ) : null}
    </section>
  );
}
