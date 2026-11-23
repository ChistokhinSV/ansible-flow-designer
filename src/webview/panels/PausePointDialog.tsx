// AFD-371 (ADR-0040 §6): Edit Pause Point… on a step: always pause, pause when a condition holds
// (any host matching pauses all hosts), only once it is reached N times, or log only (never
// pauses); and the flow's failure filters (ADR-0040 §7). Saved through the host's messages
// (setPausePoint, setFailureFilters), so VS Code and a server's pages keep them their own way.
import { type FormEvent, useRef, useState } from 'react';
import { failuresOf, type PointHow, pointHow } from '../../core/run/debug';
import type { PausePoint } from '../../core/run/step';
import { useDialogFocus } from '../focus';
import { setFailureFilters, setPausePoint } from '../runActions';
import { useUi } from '../store';
import { useTitle } from './StepBar';

export function PausePointDialog() {
  const node = useUi((s) => s.pointEdit);
  return node ? <Dialog key={node} node={node} /> : null;
}

function Dialog({ node }: { node: string }) {
  const title = useTitle(node);
  const existing = useUi((s) => s.pointSettings[node]);
  const isPoint = useUi((s) => s.pausePoints.includes(node));
  const filters = failuresOf(useUi((s) => s.failureFilters));
  const box = useRef<HTMLFormElement>(null);
  const trap = useDialogFocus(box);
  const [how, setHow] = useState<PointHow>(pointHow(existing));
  const [condition, setCondition] = useState(existing?.condition ?? '');
  const [log, setLog] = useState(existing?.log ?? '');
  const [counted, setCounted] = useState(!!existing?.hits);
  const [hits, setHits] = useState(String(existing?.hits ?? 2));
  const [failed, setFailed] = useState(filters.failed);
  const [unreachable, setUnreachable] = useState(filters.unreachable);
  const [problem, setProblem] = useState<string | null>(null);
  const close = () => useUi.getState().setPointEdit(null);

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    const point: PausePoint = { node };
    if (how === 'when') {
      if (!condition.trim()) return setProblem('Write the condition, or choose Always pause');
      point.condition = condition.trim().replace(/^\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
    }
    if (how === 'log') {
      if (!log.trim()) return setProblem('Write the message, or choose another way');
      point.log = log;
    }
    if (counted) {
      const n = Number(hits);
      if (!Number.isInteger(n) || n < 1)
        return setProblem('The count is a whole number, 1 or more');
      point.hits = n;
    }
    setPausePoint(node, point);
    if (failed !== filters.failed || unreachable !== filters.unreachable)
      setFailureFilters({ failed, unreachable });
    close();
  };

  const radio = (value: PointHow, label: string) => (
    <label className="afd-point-row">
      <input
        type="radio"
        name="afd-point-how"
        value={value}
        checked={how === value}
        data-point-how={value}
        onChange={() => {
          setHow(value);
          setProblem(null);
        }}
      />
      {label}
    </label>
  );

  return (
    <div className="afd-modal-backdrop">
      <form
        ref={box}
        className="afd-modal afd-point-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="afd-point-title"
        data-point-dialog={node}
        onSubmit={save}
        onKeyDown={(e) => {
          trap(e);
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          close();
        }}
      >
        <h2 id="afd-point-title">Pause point · {title}</h2>
        {radio('always', 'Always pause')}
        {radio('when', 'Pause when')}
        {how === 'when' ? (
          <div className="afd-field">
            <input
              className="afd-input mono"
              aria-label="Condition (Jinja, checked per host)"
              placeholder="inventory_hostname is match('core')"
              value={condition}
              data-point-condition
              onChange={(e) => setCondition(e.target.value)}
            />
            <span className="afd-help">
              Checked per host before the step. All hosts wait when any host matches; the pause
              names them.
            </span>
          </div>
        ) : null}
        {radio('log', 'Log only, never pause')}
        {how === 'log' ? (
          <div className="afd-field">
            <input
              className="afd-input mono"
              aria-label="Log message (Jinja, per host)"
              placeholder="bgp peers: {{ bgp_peers | length }}"
              value={log}
              data-point-log
              onChange={(e) => setLog(e.target.value)}
            />
            <span className="afd-help">
              Written per host to the run's output, with secrets masked.
            </span>
          </div>
        ) : null}
        <label className="afd-point-row">
          <input
            type="checkbox"
            checked={counted}
            data-point-counted
            onChange={(e) => setCounted(e.target.checked)}
          />
          Only after it is reached
          <input
            type="number"
            min={1}
            className="afd-input"
            aria-label="Times reached"
            value={hits}
            disabled={!counted}
            data-point-hits
            onChange={(e) => setHits(e.target.value)}
          />
          times
        </label>
        <hr />
        <label className="afd-point-row">
          <input
            type="checkbox"
            checked={failed}
            data-filter-failed
            onChange={(e) => setFailed(e.target.checked)}
          />
          Pause when a host fails a step
        </label>
        <label className="afd-point-row">
          <input
            type="checkbox"
            checked={unreachable}
            data-filter-unreachable
            onChange={(e) => setUnreachable(e.target.checked)}
          />
          Pause when a host is unreachable
        </label>
        <p className="afd-help">
          Conditions, counts, log points and failure pauses work in debug runs (Run ▾ › Debug); a
          step-by-step run pauses at the point always.
        </p>
        {problem ? (
          <p className="afd-help tone-warn" role="alert" data-point-problem>
            {problem}
          </p>
        ) : null}
        <div className="afd-modal-actions">
          {isPoint ? (
            <button
              type="button"
              className="secondary"
              data-point-remove
              onClick={() => {
                setPausePoint(node, null);
                close();
              }}
            >
              Remove Pause Point
            </button>
          ) : null}
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button type="submit" data-point-save>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
