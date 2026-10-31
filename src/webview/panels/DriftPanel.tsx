// "Design vs code" (M6, mockup 04, D-29): where the code was read from, how many nodes the
// generated code matches by ID, drift items with an action on each side, the last run; for a
// selected node, the tasks it runs with their file and line. Nothing here resolves anything.
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { DriftItem, NodeCode } from '../../core/drift/types';
import { modelOf } from '../../core/flow/model';
import type { RunView } from '../../core/protocol';
import { run } from '../actions';
import { send } from '../bus';
import { ago } from '../constants';
import { runDriftAction } from '../driftActions';
import { useUi } from '../store';

function SyncSource() {
  const sync = useUi((s) => s.sync);
  const scan = sync.scan;
  const git = scan?.git;
  return (
    <div className="afd-sync-source" data-sync-state={sync.state}>
      {git?.commit ? (
        <span>
          <span className="codicon codicon-git-commit" aria-hidden="true" /> git{' '}
          <span className="mono">{git.branch ?? 'detached'}</span> @{' '}
          <span className="mono">{git.commit}</span>
          {git.when ? <span className="muted"> · {ago(git.when)}</span> : null}
        </span>
      ) : scan ? (
        <span className="muted">Not a Git repository: the working tree as it is</span>
      ) : null}
      {git && git.dirty.length > 0 ? (
        <span className="afd-badge tone-warn" title={git.dirty.join('\n')}>
          {git.dirty.length} uncommitted
        </span>
      ) : null}
      {scan ? (
        <span className="muted afd-sync-env">
          {scan.environment} · scanned {ago(scan.at)}
        </span>
      ) : null}
      {sync.state === 'syncing' ? (
        <span className="muted" role="status">
          <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />{' '}
          Compiling the code in the environment…
        </span>
      ) : null}
      {sync.state === 'error' ? (
        <span className="afd-catalog-error" role="alert">
          {sync.error}
        </span>
      ) : null}
    </div>
  );
}

function ItemCard({ item }: { item: DriftItem }) {
  const reveal = useUi((s) => s.reveal);
  const [busy, setBusy] = useState(false);
  return (
    <li
      className={`afd-drift-item kind-${item.kind} sev-${item.severity}${item.ignored ? ' ignored' : ''}`}
      data-drift={item.id}
    >
      <div className="afd-drift-head">
        {item.node ? (
          <button type="button" className="link" onClick={() => reveal(item.node as string)}>
            {item.title}
          </button>
        ) : (
          <strong>{item.title}</strong>
        )}
        <span className="muted"> · {item.label}</span>
      </div>
      <p className="afd-drift-detail">{item.detail}</p>
      {item.ignored ? (
        <p className="muted afd-drift-ignored">
          Ignored{item.ignored.by ? ` by ${item.ignored.by}` : ''}: {item.ignored.reason}
        </p>
      ) : null}
      <div className="afd-drift-actions">
        {item.actions.map((a, i) => (
          <button
            key={`${a.label}|${JSON.stringify(a.action)}`}
            type="button"
            className={i === 0 && !item.ignored ? '' : 'secondary'}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await runDriftAction(a.action);
              setBusy(false);
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
    </li>
  );
}

function LastRun({ run: last, nodes }: { run: RunView | null; nodes: NodeCode[] }) {
  const s = last?.state === 'done' ? last.summary : undefined;
  if (!s) return null;
  const failed = new Set(s.failures.map((f) => f.node));
  let ok = 0;
  let bad = 0;
  for (const n of nodes) {
    if (failed.has(n.node)) bad++;
    else if (s.nodes[n.node]) ok++;
  }
  return (
    <section className="afd-section" data-last-run-summary>
      <h3>Last {last?.mode === 'check' ? 'skeleton run' : 'run'}</h3>
      <p>
        ok {ok} · failed {bad} · not run {nodes.length - ok - bad}
        <span className="muted"> · {ago(last?.finishedAt ?? last?.startedAt)}</span>
      </p>
    </section>
  );
}

export function DriftPanel() {
  const drift = useUi((s) => s.drift);
  const sync = useUi((s) => s.sync);
  const lastRun = useUi((s) => s.run);
  const [showIgnored, setShowIgnored] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  // Drift first; notes (info: roles without specs, unexpanded includes) do not count as drift.
  const open = drift?.items.filter((i) => !i.ignored && i.severity === 'warning') ?? [];
  const notes = drift?.items.filter((i) => !i.ignored && i.severity === 'info') ?? [];
  const ignored = drift?.items.filter((i) => i.ignored) ?? [];
  return (
    <div className="afd-panel-body" data-drift-panel>
      <h2 className="afd-panel-title">Design vs code</h2>
      <SyncSource />
      {!drift && sync.state !== 'syncing' ? (
        <p className="muted">
          Re-sync to compile the generated code and every bound role and playbook in the
          environment, then compare them with the design.
        </p>
      ) : null}
      {drift ? (
        <>
          <p className="afd-matched" data-matched={`${drift.matched}/${drift.matchable}`}>
            <strong>
              {drift.matched} / {drift.matchable}
            </strong>{' '}
            nodes matched by ID
          </p>
          <p>
            <strong>{open.length}</strong> drift item{open.length === 1 ? '' : 's'}
          </p>
          <ul className="afd-drift-list">
            {open.map((i) => (
              <ItemCard key={`${i.node}|${i.id}`} item={i} />
            ))}
          </ul>
          {notes.length > 0 ? (
            <section className="afd-section" data-drift-notes={notes.length}>
              <button type="button" className="link" onClick={() => setShowNotes(!showNotes)}>
                {showNotes ? 'Hide' : 'Show'} {notes.length} note{notes.length === 1 ? '' : 's'}
              </button>
              {showNotes ? (
                <ul className="afd-drift-list">
                  {notes.map((i) => (
                    <ItemCard key={`${i.node}|${i.id}`} item={i} />
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
          {ignored.length > 0 ? (
            <section className="afd-section">
              <button type="button" className="link" onClick={() => setShowIgnored(!showIgnored)}>
                {showIgnored ? 'Hide' : 'Show'} {ignored.length} ignored
              </button>
              {showIgnored ? (
                <ul className="afd-drift-list">
                  {ignored.map((i) => (
                    <ItemCard key={`${i.node}|${i.id}`} item={i} />
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
          <LastRun
            run={lastRun}
            nodes={Object.values(drift.nodes).filter(
              (n) => n.artifact !== 'start' && n.artifact !== 'end',
            )}
          />
        </>
      ) : null}
    </div>
  );
}

/** A selected node in Implementation mode: what it runs, where, and its drift. */
export function NodeCodePanel({ id }: { id: string }) {
  const drift = useUi((s) => s.drift);
  const doc = useUi((s) => s.snapshot?.doc);
  const select = useUi((s) => s.select);
  const node = doc ? modelOf(doc).nodes.get(id)?.node : undefined;
  if (!node) return null;
  const code = drift?.nodes[id];
  const items = drift?.items.filter((i) => i.node === id) ?? [];
  return (
    <div className="afd-panel-body" data-node-code={id}>
      <div className="afd-inspector-head">
        <button type="button" className="link" onClick={() => select({})}>
          <span className="codicon codicon-arrow-left" aria-hidden="true" /> All drift
        </button>
        <button
          type="button"
          className="icon"
          title="Properties"
          aria-label="Open properties"
          onClick={() => useUi.getState().openProperties(id, 'implementation')}
        >
          <span className="codicon codicon-settings-gear" aria-hidden="true" />
        </button>
      </div>
      <h2 className="afd-panel-title">{node.title}</h2>
      {!code ? (
        <p className="muted">Re-sync to see the code this node runs.</p>
      ) : (
        <>
          <p className="mono">{code.artifact}</p>
          <p>
            {code.matched ? (
              <>
                <span className="codicon codicon-pass" aria-hidden="true" /> Matched by ID in the
                generated code{' '}
                {code.play ? (
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      send({ type: 'openCode', path: code.play?.path ?? '', line: code.play?.line })
                    }
                  >
                    open play
                  </button>
                ) : null}
              </>
            ) : (
              <span className="muted">No generated play is tagged with this node.</span>
            )}
          </p>
          {code.missing && code.missing !== 'not scanned' ? (
            <p className="afd-catalog-error">{code.missing}</p>
          ) : null}
          {code.tasks.length > 0 ? (
            <section className="afd-section">
              <h3>
                {code.tasks.length} task{code.tasks.length === 1 ? '' : 's'}
                {code.dynamic > 0 ? (
                  <span className="muted"> · {code.dynamic} dynamic include, not expanded</span>
                ) : null}
              </h3>
              <ul className="afd-code-tasks">
                {code.tasks.map((t, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: tasks are listed in run order.
                  <li key={i} className={t.dynamic ? 'dynamic' : ''}>
                    <span>{t.name || t.action}</span> <span className="muted mono">{t.action}</span>
                    {t.origin ? (
                      <button
                        type="button"
                        className="link mono"
                        onClick={() =>
                          send({
                            type: 'openCode',
                            path: t.origin?.path ?? '',
                            line: t.origin?.line,
                          })
                        }
                      >
                        {t.origin.path.split('/').slice(-2).join('/')}:{t.origin.line}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      {items.length > 0 ? (
        <ul className="afd-drift-list">
          {items.map((i) => (
            <ItemCard key={i.id} item={i} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** "Ignore…" a drift item: a reason is required; the host records the Git user (decision M6-2). */
export function IgnoreDialog() {
  const target = useUi((s) => s.ignore);
  const close = useUi((s) => s.setIgnore);
  const [reason, setReason] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!target) return;
    setReason('');
    setTimeout(() => field.current?.focus(), 0);
  }, [target]);
  if (!target) return null;
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!reason.trim()) return;
    const ack = await run({ kind: 'ignoreDrift', node: target.node, item: target.item, reason });
    if (ack.ok) close(null);
  };
  return (
    <div className="afd-modal-backdrop">
      <form
        className="afd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="afd-ignore-title"
        onSubmit={submit}
        onKeyDown={(e) => {
          // Only this dialog closes: the page behind it (Properties) stays open.
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          close(null);
        }}
      >
        <h2 id="afd-ignore-title">Ignore this drift</h2>
        <p className="muted">
          <strong>{target.title}</strong> · {target.label}. Code and design stay as they are; the
          item moves to the ignored list. The decision is recorded in the flow with your Git user
          name.
        </p>
        <div className="afd-field">
          <label htmlFor="afd-ignore-reason">Reason (required)</label>
          <textarea
            id="afd-ignore-reason"
            ref={field}
            className="afd-input"
            rows={3}
            value={reason}
            placeholder="e.g. The role runs it from main"
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="afd-modal-actions">
          <button type="button" className="secondary" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" disabled={!reason.trim()}>
            Ignore
          </button>
        </div>
      </form>
    </div>
  );
}
