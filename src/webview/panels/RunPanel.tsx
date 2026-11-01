// Run mode's right panel (04 §10, M7): the run with nothing selected (source, status, AWX job,
// revision, failed hosts, the `tested` proposal of decision 15), a node's per-host results, or the
// hosts that took a wire.
import { modelOf } from '../../core/flow/model';
import type { Edge, Ulid } from '../../core/flow/types';
import type { RunView } from '../../core/protocol';
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
import { run as runCommand } from '../actions';
import { send } from '../bus';
import { ago } from '../constants';
import { useUi } from '../store';

function describe(run: RunView): string {
  if (run.source === 'awx' && run.awx)
    return `AWX ${run.awx.workflow ? 'workflow' : 'job'} #${run.awx.jobId} · ${run.awx.template}`;
  return run.mode === 'check' ? 'Local skeleton run (check mode)' : 'Local real run';
}

function statusOf(run: RunView): { label: string; tone: 'ok' | 'warn' | 'neutral' } {
  if (run.state === 'running')
    return { label: run.awx ? `running (${run.awx.status})` : 'running', tone: 'neutral' };
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
          })
        }
      >
        <span className="codicon codicon-verified" aria-hidden="true" /> Mark {ids.length} Node
        {ids.length === 1 ? '' : 's'} Tested
      </button>
    </section>
  );
}

export function RunPanel() {
  const run = useUi((s) => s.run);
  const doc = useUi((s) => s.snapshot?.doc);
  if (!run)
    return (
      <div className="afd-panel-body" data-run-panel="none">
        <h2 className="afd-panel-title">Run</h2>
        <p className="muted">
          No run of this flow yet. Launch it in AWX, or run it as a skeleton in the local
          environment; nodes and wires then show what each host did.
        </p>
      </div>
    );
  const st = statusOf(run);
  const s = run.summary;
  const outcome = Object.entries(s?.outcome ?? {});
  return (
    <div className="afd-panel-body" data-run-panel={run.state}>
      <h2 className="afd-panel-title">Run</h2>
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
      <OpenRun run={run} />
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
              {s.failures.map((f) => (
                <li key={`${f.host}|${f.task}`}>
                  <span className="mono">{f.host}</span> failed in {f.task}
                  {f.msg ? <span className="muted"> · {f.msg}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <Proposal run={run} />
    </div>
  );
}

export function NodeRunPanel({ id }: { id: Ulid }) {
  const doc = useUi((s) => s.snapshot?.doc);
  const run = useUi((s) => s.run);
  const r = useUi((s) => s.runNodes?.[id]);
  const approval = useUi((s) => s.run?.awx?.approvals?.[id]);
  const model = doc ? modelOf(doc) : undefined;
  const node = model?.nodes.get(id)?.node;
  if (!model || !node) return null;
  const s = run?.summary;
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
  return (
    <div className="afd-panel-body" data-node-run={id}>
      <h2 className="afd-panel-title">{node.title}</h2>
      <p className="mono muted">{node.key}</p>
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
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.host} data-host={h.host} data-port={h.ports.join(',')}>
                  <td className="mono">{h.host}</td>
                  <td className="mono afd-run-port">
                    {h.ports.join(', ') || (h.ended ? '-' : '(no route)')}
                  </td>
                  <td>
                    {h.ended ? (
                      <span className={node.outcome === 'failed' ? 'tone-warn' : 'tone-ok'}>
                        {h.ended}
                      </span>
                    ) : h.problem ? (
                      <span title={h.problem.msg}>
                        {h.problem.status} in {h.problem.task}
                        {h.problem.msg ? <span className="muted"> · {h.problem.msg}</span> : null}
                      </span>
                    ) : (
                      <span className="tone-ok">ok</span>
                    )}
                  </td>
                </tr>
              ))}
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
      {run ? <OpenRun run={run} /> : null}
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
