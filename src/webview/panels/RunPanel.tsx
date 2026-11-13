// Run mode's right panel (04 §10, M7): the run with nothing selected (source, status, AWX job,
// revision, failed hosts, the `tested` proposal of decision 15), a node's per-host results, or the
// hosts that took a wire.
import { Fragment, useEffect, useState } from 'react';
import { modelOf } from '../../core/flow/model';
import type { Edge, Ulid } from '../../core/flow/types';
import type { RunView } from '../../core/protocol';
import type { OutputEntry } from '../../core/run/events';
import { pastRunLabel } from '../../core/run/pastRuns';
import {
  arrivals,
  edgeHosts,
  formatSeconds,
  type HostResult,
  nodeHosts,
  runPassed,
  runVerdict,
  testedCandidates,
} from '../../core/run/view';
import {
  endRows,
  endWords,
  forcedAt,
  forcedText,
  missWhy,
  missWords,
  scenarioMisses,
} from '../../core/scenario/view';
import { trailOf } from '../../core/view/find';
import { run as runCommand } from '../actions';
import { send } from '../bus';
import { ago } from '../constants';
import { showPastRun } from '../runActions';
import { requestRunOutput } from '../runOutput';
import { useUi } from '../store';
import { HelpLink } from './HelpLink';

/**
 * AFD-245: the runs kept of this flow. Choosing one shows it on the canvas again, with what each
 * host did; a run of an earlier version of the flow says so.
 */
function PastRuns({ run }: { run: RunView | null }) {
  const runs = useUi((s) => s.pastRuns);
  const version = useUi((s) => s.snapshot?.doc?.flow.version);
  if (runs.length === 0 || (runs.length === 1 && runs[0]?.id === run?.id)) return null;
  const shown = runs.some((r) => r.id === run?.id) ? run?.id : '';
  const older =
    run?.past &&
    run.flowVersion !== undefined &&
    version !== undefined &&
    run.flowVersion !== version;
  return (
    <div className="afd-field afd-past-runs" data-past-runs={runs.length}>
      <label htmlFor="afd-past-run">Earlier runs</label>
      <select
        id="afd-past-run"
        className="afd-input"
        value={shown ?? ''}
        onChange={(e) => e.target.value && showPastRun(e.target.value)}
      >
        {shown ? null : <option value="">The run shown is not among the kept runs</option>}
        {runs.map((r) => (
          <option key={r.id} value={r.id} title={r.partial}>
            {pastRunLabel(r)}
          </option>
        ))}
      </select>
      {older ? (
        <p className="muted" data-past-version={run?.flowVersion}>
          <span className="codicon codicon-history" aria-hidden="true" /> This run is of version{' '}
          {run?.flowVersion} of the flow; it is at version {version} now, so steps may have changed
          since.
        </p>
      ) : null}
    </div>
  );
}

function describe(run: RunView): string {
  if (run.scenario) return `Scenario: ${run.scenario.name} (stubs, local connection)`;
  // AFD-244: what a partial run ran, and what it left out.
  if (run.partial) return `Local skeleton run of part of the flow. ${run.partial.line}`;
  if (run.source === 'awx' && run.awx)
    return `AWX ${run.awx.workflow ? 'workflow' : 'job'} #${run.awx.jobId} · ${run.awx.template}`;
  return run.mode === 'check' ? 'Local skeleton run (check mode)' : 'Local real run';
}

function statusOf(run: RunView): { label: string; tone: 'ok' | 'warn' | 'neutral' } {
  if (run.state === 'running')
    return {
      label: run.awx
        ? `running (${run.awx.status})`
        : run.quiet
          ? 'running · no new events for 20 s'
          : 'running',
      tone: run.quiet ? 'warn' : 'neutral',
    };
  if (run.scenario)
    return run.scenario.passed
      ? { label: 'passed: every host ended where expected', tone: 'ok' }
      : {
          label:
            run.scenario.error ?? `${scenarioMisses(run.scenario).length} host(s) ended elsewhere`,
          tone: 'warn',
        };
  if (run.state === 'error') return { label: run.error ?? 'failed', tone: 'warn' };
  if (runPassed(run)) return { label: `passed · exit ${run.rc}`, tone: 'ok' };
  const { ok, failed } = runVerdict(run);
  const hosts = failed ? ` · ${failed} failed` : '';
  const label = run.awx ? `${run.awx.status} · exit ${run.rc}${hosts}` : `exit ${run.rc}${hosts}`;
  return { label, tone: ok ? 'ok' : 'warn' };
}

function OpenRun({ run }: { run: RunView }) {
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => send({ type: 'showRunOutput' })}
      title={run.awx ? run.awx.url : 'Show the terminal of the run'}
    >
      <span
        className={`codicon ${run.awx ? 'codicon-link-external' : 'codicon-terminal'}`}
        aria-hidden="true"
      />{' '}
      {run.awx ? 'Open in AWX' : 'Show Terminal'}
    </button>
  );
}

function Proposal({ run }: { run: RunView }) {
  const doc = useUi((s) => s.snapshot?.doc);
  if (!doc) return null;
  const ids = testedCandidates(doc, run);
  if (ids.length === 0) return null;
  const model = modelOf(doc);
  return (
    <section className="afd-section" data-tested-proposal={ids.length}>
      <h3>Tested</h3>
      <p>
        This run passed on flow version {run.flowVersion}. Mark the implemented nodes it ran as
        tested? Saving the flow records it.
      </p>
      <ul className="afd-run-hosts">
        {ids.map((id) => (
          <li key={id}>{model.nodes.get(id)?.node.title ?? id}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() =>
          void runCommand({
            kind: 'setStatuses',
            statuses: Object.fromEntries(ids.map((id) => [id, 'tested' as const])),
            // Format 2 keeps the run on each node (AFD-50).
            run: {
              id: run.id,
              ...(run.flowVersion !== undefined ? { flowVersion: run.flowVersion } : {}),
              ...(run.awx?.revision ? { commit: run.awx.revision } : {}),
            },
          })
        }
      >
        <span className="codicon codicon-verified" aria-hidden="true" /> Mark {ids.length} Node
        {ids.length === 1 ? '' : 's'} Tested
      </button>
    </section>
  );
}

/**
 * The steps where hosts failed, on every level (AFD-48): each shows its node, opening the subflow
 * it is in, so a failure deep in the flow is one click or Enter away.
 */
function FailedSteps() {
  const runNodes = useUi((s) => s.runNodes);
  const doc = useUi((s) => s.snapshot?.doc);
  if (!runNodes || !doc) return null;
  const model = modelOf(doc);
  const failed = Object.entries(runNodes)
    .filter(([id, r]) => r.failed > 0 && model.nodes.get(id)?.node.type !== 'subflow')
    .map(([id, r]) => {
      const entry = model.nodes.get(id);
      return {
        id,
        r,
        title: entry?.node.title ?? id,
        trail: entry ? trailOf(model, entry.level) : [],
      };
    })
    .sort(
      (a, b) =>
        a.trail.join('/').localeCompare(b.trail.join('/')) || a.title.localeCompare(b.title),
    );
  if (failed.length === 0) return null;
  return (
    <section className="afd-section" data-failed-steps={failed.length}>
      <h3>Failed steps</h3>
      <ul className="afd-run-hosts">
        {failed.map(({ id, r, title, trail }) => (
          <li key={id}>
            <button
              type="button"
              className="link"
              data-failed-step={id}
              onClick={() => useUi.getState().reveal(id)}
            >
              {title}
            </button>{' '}
            <span className="muted">
              {trail.length ? `${trail.join(' › ')} · ` : ''}
              {r.failed} of {r.hosts} host{r.hosts === 1 ? '' : 's'} failed
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The flow's scenario results (AFD-84): one row each, a click shows it on the canvas like a run;
 * a scenario on the canvas says so, with the way back to the last run.
 */
function Scenarios() {
  const results = useUi((s) => s.scenarios);
  const shown = useUi((s) => s.scenarioShown);
  const show = useUi((s) => s.showScenario);
  const doc = useUi((s) => s.snapshot?.doc);
  if (!results?.length) return null;
  const failed = results.filter((r) => !r.passed).length;
  return (
    <section className="afd-section" data-run-scenarios={results.length}>
      <h3>
        Scenarios ·{' '}
        {failed ? `${failed} of ${results.length} failed` : `all ${results.length} pass`}
      </h3>
      {shown ? (
        <p data-scenario-shown={shown}>
          On the canvas: scenario <strong>{shown}</strong>.{' '}
          <button type="button" className="link" onClick={() => show(null)}>
            Back to Last Run
          </button>
        </p>
      ) : null}
      <ul className="afd-lens-items">
        {results.map((r) => {
          const misses = scenarioMisses(r);
          return (
            <li key={r.name} className={r.passed ? 'tone-ok' : 'tone-warn'} data-scenario={r.name}>
              <button
                type="button"
                className="afd-lens-item-button"
                aria-pressed={shown === r.name}
                onClick={() => show(r.name)}
                title="Show this scenario on the canvas"
              >
                <span className="afd-lens-item-label">
                  {r.passed ? 'pass' : 'fail'} · {r.name}
                </span>
                {r.error ? (
                  <span className="afd-lens-item-detail muted">{r.error}</span>
                ) : misses.length ? (
                  // AFD-94: the ends by their titles (round 2: S9, the keys were not read).
                  // AFD-105 (round 3: R8): and why, when the scenario planted the host's failure.
                  <span className="afd-lens-item-detail muted" data-scenario-misses>
                    {misses.map((m) => missWhy(doc ?? undefined, m, r.forced)).join('. ')}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function RunPanel() {
  const run = useUi((s) => s.run);
  const doc = useUi((s) => s.snapshot?.doc);
  const viewer = useUi((s) => s.viewer);
  if (!run && viewer)
    return (
      <div className="afd-panel-body" data-run-panel="none">
        <h2 className="afd-panel-title">Run</h2>
        <p className="muted">
          No run of this flow yet. Run it from the bar above; nodes and wires then show what each
          host did.
        </p>
        <PastRuns run={null} />
      </div>
    );
  if (!run)
    return (
      <div className="afd-panel-body" data-run-panel="none">
        <h2 className="afd-panel-title">
          Run <HelpLink topic="runs" about="runs" />
        </h2>
        <p className="muted">
          No run of this flow yet. Launch it in AWX, or run it as a skeleton in the local
          environment; nodes and wires then show what each host did.
        </p>
        <PastRuns run={null} />
        <Scenarios />
      </div>
    );
  const st = statusOf(run);
  const s = run.summary;
  const outcome = Object.entries(s?.outcome ?? {});
  return (
    <div className="afd-panel-body" data-run-panel={run.state}>
      <h2 className="afd-panel-title">
        Run <HelpLink topic="runs" about="runs" />
      </h2>
      <Scenarios />
      <PastRuns run={run} />
      <dl className="afd-run-facts">
        <dt>Run</dt>
        <dd>{describe(run)}</dd>
        <dt>Status</dt>
        <dd className={`tone-${st.tone}`} data-run-status={run.awx?.status ?? run.state}>
          {st.label}
        </dd>
        <dt>When</dt>
        <dd title={run.finishedAt ?? run.startedAt}>{ago(run.finishedAt ?? run.startedAt)}</dd>
        {run.environment ? (
          <>
            <dt>Where</dt>
            <dd className="mono">{run.environment}</dd>
          </>
        ) : null}
        {run.awx?.revision ? (
          <>
            <dt>Commit</dt>
            <dd className="mono" title={run.awx.revision}>
              {run.awx.revision.slice(0, 10)}
            </dd>
          </>
        ) : null}
        {run.flowVersion !== undefined ? (
          <>
            <dt>Flow</dt>
            <dd>
              v{run.flowVersion}
              {doc && doc.flow.version !== run.flowVersion ? (
                <span className="muted"> (now v{doc.flow.version})</span>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
      {run.awx?.revisionMismatch ? (
        <p className="afd-run-warning" data-revision-mismatch>
          <span className="codicon codicon-warning" aria-hidden="true" /> AWX ran another commit
          than your HEAD: push your changes to the project's remote so the run matches the design.
        </p>
      ) : null}
      {/* A scenario has no terminal or AWX job of its own (AFD-84). */}
      {run.scenario ? null : <OpenRun run={run} />}
      <FailedSteps />
      {run.awx?.segments?.length ? (
        <section className="afd-section" data-run-segments={run.awx.segments.length}>
          <h3>Segments</h3>
          <ul className="afd-run-hosts">
            {run.awx.segments.map((g) => (
              <li key={g.job}>
                <span className="mono">{g.name}</span>{' '}
                <span className="muted">
                  job #{g.job} · {g.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {s ? (
        <section className="afd-section">
          <h3>Hosts</h3>
          <p>
            {s.hosts.length} host{s.hosts.length === 1 ? '' : 's'}
            {s.stoppedEarly ? ' · stopped early' : ''}
          </p>
          {outcome.length > 0 ? (
            <ul className="afd-run-hosts" data-run-outcome={outcome.length}>
              {outcome.map(([host, why]) => (
                <li key={host}>
                  <span className="mono">{host}</span> <span className="muted">{why}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {s.failures.length > 0 ? (
            <ul className="afd-run-hosts" data-run-failures={s.failures.length}>
              {s.failures.map((f) => {
                // AFD-105 (round 3: R8): a failure the scenario planted says so, and how.
                const planted =
                  run.scenario && doc && f.node
                    ? forcedAt(doc, run.scenario.forced, f.host, f.node)
                    : undefined;
                return (
                  <li key={`${f.host}|${f.task}`} data-forced={planted ? 'true' : undefined}>
                    <span className="mono">{f.host}</span>
                    {planted ? (
                      `: ${forcedText(doc ?? undefined, planted)}`
                    ) : (
                      <>
                        {' '}
                        failed in {f.task}
                        {f.msg ? <span className="muted"> · {f.msg}</span> : null}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      ) : null}
      <Proposal run={run} />
    </div>
  );
}

/** The Run tab of a node's Details (AFD-43): each host, the port it left by, its result. */
export function NodeRunPanel({ id }: { id: Ulid }) {
  const [open, setOpen] = useState<string | null>(null);
  const doc = useUi((s) => s.snapshot?.doc);
  const run = useUi((s) => s.run);
  const r = useUi((s) => s.runNodes?.[id]);
  const approval = useUi((s) => s.run?.awx?.approvals?.[id]);
  const model = doc ? modelOf(doc) : undefined;
  const node = model?.nodes.get(id)?.node;
  if (!model || !node) return null;
  const s = run?.summary;
  // AFD-81: what each host did here, read from the run's events; local runs, once ended.
  const outputs =
    run?.source === 'local' &&
    run.state !== 'running' &&
    node.type !== 'start' &&
    node.type !== 'end';
  // Start and end nodes have no play: start sent every host, end lists the hosts that arrived.
  const rows: (HostResult & { ended?: string })[] = !s
    ? []
    : node.type === 'start'
      ? s.hosts.map((host) => ({ host, ports: ['ok_hosts'] }))
      : node.type === 'end'
        ? arrivals(model, s, id).map((host) => ({
            host,
            ports: [],
            ended: s.outcome[host] ?? (node.outcome === 'failed' ? 'failed here' : 'ended here'),
          }))
        : nodeHosts(s, id);
  // AFD-84: an end node in a scenario: who was expected here, and where each ended.
  if (run?.scenario && doc && node.type === 'end') {
    const ends = endRows(doc, run.scenario, run, id);
    return (
      <div className="afd-panel-body" data-node-run={id} data-scenario-end={run.scenario.name}>
        <p>
          Scenario <strong>{run.scenario.name}</strong>
        </p>
        {ends.length === 0 ? (
          <p className="muted">The scenario expected no host here, and none came.</p>
        ) : (
          <table className="afd-run-table" data-end-rows={ends.length}>
            <thead>
              <tr>
                <th>Host</th>
                <th>Expected</th>
                <th>Ended</th>
              </tr>
            </thead>
            <tbody>
              {ends.map((r) => (
                <tr key={r.host} data-host={r.host} className={r.ok ? '' : 'tone-warn'}>
                  <td className="mono">{r.host}</td>
                  <td>{r.expected ? 'here' : 'elsewhere'}</td>
                  <td title={r.ended}>{endWords(doc, r.ended)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }
  return (
    <div className="afd-panel-body" data-node-run={id}>
      {!s ? (
        <p className="muted">No run yet.</p>
      ) : r?.state === 'idle' ? (
        <p className="muted">The last run did not reach this node.</p>
      ) : (
        <>
          <p>
            {r?.hosts} host{r?.hosts === 1 ? '' : 's'} · {r?.failed} failed
            {r?.seconds !== undefined ? ` · ${formatSeconds(r.seconds)}` : ''}
          </p>
          <table className="afd-run-table" data-run-hosts={rows.length}>
            <thead>
              <tr>
                <th>Host</th>
                <th>Left through</th>
                <th>Result</th>
                {outputs ? (
                  <th>
                    <span className="afd-sr-only">Output</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => {
                // AFD-105 (round 3: R8): "the scenario fails it here" was not understood.
                const planted =
                  h.problem && run?.scenario && doc
                    ? forcedAt(doc, run.scenario.forced, h.host, node.id)
                    : undefined;
                // AFD-111 (round 4: Q5): and where the host ended against where it was expected.
                const missed = planted
                  ? run?.scenario?.hosts.find((x) => x.host === h.host && x.expected !== x.actual)
                  : undefined;
                return (
                  <Fragment key={h.host}>
                    <tr data-host={h.host} data-port={h.ports.join(',')}>
                      <td className="mono">{h.host}</td>
                      <td className="mono afd-run-port">
                        {h.ports.join(', ') || (h.ended ? '-' : '(no route)')}
                      </td>
                      <td>
                        {h.ended ? (
                          <span className={node.outcome === 'failed' ? 'tone-warn' : 'tone-ok'}>
                            {h.ended}
                          </span>
                        ) : planted ? (
                          <>
                            <span
                              className="tone-warn"
                              data-forced
                              title={forcedText(doc ?? undefined, planted)}
                            >
                              Forced by the scenario ({planted.outcome})
                            </span>
                            {missed ? (
                              <span className="muted" data-forced-miss>
                                {' '}
                                · {missWords(doc ?? undefined, missed)}
                              </span>
                            ) : null}
                          </>
                        ) : h.problem ? (
                          <span title={h.problem.msg}>
                            {h.problem.status} in {h.problem.task}
                            {h.problem.msg ? (
                              <span className="muted"> · {h.problem.msg}</span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="tone-ok">ok</span>
                        )}
                      </td>
                      {outputs ? (
                        <td>
                          {/* AFD-96 (S4): an icon, which a 340 px panel does not wrap. */}
                          <button
                            type="button"
                            className="icon"
                            aria-expanded={open === h.host}
                            aria-label={`Output of ${h.host}`}
                            title={`Output of ${h.host}`}
                            data-output-toggle={h.host}
                            onClick={() => setOpen(open === h.host ? null : h.host)}
                          >
                            <span className="codicon codicon-output" aria-hidden="true" />
                          </button>
                        </td>
                      ) : null}
                    </tr>
                    {open === h.host ? <HostOutputRow node={id} host={h.host} /> : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      {approval ? (
        <p data-approval={approval.status}>
          AWX approval: <strong>{approval.status}</strong>{' '}
          <button
            type="button"
            className="secondary"
            onClick={() => send({ type: 'showRunOutput', approval: id })}
            title={approval.url}
          >
            <span className="codicon codicon-link-external" aria-hidden="true" /> Open approval in
            AWX
          </button>
        </p>
      ) : null}
      {run && !run.scenario ? <OpenRun run={run} /> : null}
    </div>
  );
}

function edgeById(edges: Edge[][], id: string): Edge | undefined {
  for (const list of edges) {
    const e = list.find((x) => x.id === id);
    if (e) return e;
  }
  return undefined;
}

export function WireRunPanel({ edge }: { edge: Ulid }) {
  const doc = useUi((s) => s.snapshot?.doc);
  const summary = useUi((s) => s.run?.summary);
  if (!doc) return null;
  const model = modelOf(doc);
  const e = edgeById(
    [...model.levels.values()].map((l) => l.edges),
    edge,
  );
  if (!e) return null;
  const from = model.nodes.get(e.from.node)?.node;
  const to = model.nodes.get(e.to.node)?.node;
  const hosts = summary ? edgeHosts(model, summary, e) : [];
  return (
    <div className="afd-panel-body" data-wire-run={edge}>
      <h2 className="afd-panel-title">
        {from?.title} <span className="mono">{e.from.port}</span> → {to?.title}
      </h2>
      {!summary ? (
        <p className="muted">No run yet.</p>
      ) : hosts.length === 0 ? (
        <p className="muted">No host took this wire in the last run.</p>
      ) : (
        <>
          <p>
            {hosts.length} host{hosts.length === 1 ? '' : 's'} took this wire
          </p>
          <ul className="afd-run-hosts mono" data-wire-hosts={hosts.join(',')}>
            {hosts.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** One host's task results in a node of the last local run (AFD-81), asked for when opened. */
function HostOutputRow({ node, host }: { node: Ulid; host: string }) {
  const [got, setGot] = useState<{ entries?: OutputEntry[]; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    void requestRunOutput(node, host).then((a) => live && setGot(a));
    return () => {
      live = false;
    };
  }, [node, host]);
  return (
    <tr className="afd-run-output" data-run-output={host}>
      <td colSpan={4}>
        {!got ? (
          <p className="muted">Reading the output…</p>
        ) : got.error ? (
          <p className="muted">{got.error}</p>
        ) : !got.entries?.length ? (
          <p className="muted">No task results for {host} here.</p>
        ) : (
          got.entries.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: results have no identity besides order.
            <div key={i} className="afd-output-entry" data-output-task={e.task}>
              <div>
                <span className="mono">{e.task}</span>{' '}
                <span
                  className={
                    e.status === 'ok' ? 'tone-ok' : e.status === 'skipped' ? 'muted' : 'tone-warn'
                  }
                >
                  {e.status}
                  {e.changed ? ' · changed' : ''}
                  {e.rc !== undefined ? ` · rc ${e.rc}` : ''}
                  {e.item ? ' · loop item' : ''}
                </span>
              </div>
              {e.censored ? <p className="muted">Output hidden (no_log).</p> : null}
              {e.msg && !e.out?.msg ? <pre className="afd-code">{e.msg}</pre> : null}
              {(['msg', 'stdout', 'stderr'] as const).map((k) =>
                e.out?.[k] ? (
                  <div key={k}>
                    <span className="muted">{k}</span>
                    <pre className="afd-code">{e.out[k]}</pre>
                  </div>
                ) : null,
              )}
            </div>
          ))
        )}
      </td>
    </tr>
  );
}
