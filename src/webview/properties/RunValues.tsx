// AFD-341: the value each host had for a step's input in the run shown (Run mode), next to where
// the value comes from. Read from the run summary (core/run/view), so the server's embedded viewer
// draws the same. A host picked (Details › For host, the inventory tree) narrows it to that host.
import { useId } from 'react';
import type { Origin } from '../../core/flow/origin';
import type { RecordedInput } from '../../core/run/events';
import {
  differsFromPredicted,
  hostInputs,
  inputValueGroups,
  nodeInputsRecorded,
  recordedText,
} from '../../core/run/view';
import { useUi } from '../store';

/** How many different values a row lists before "and N more". */
const MAX_GROUPS = 4;

/** The host the run values are for: the one picked, else the run's only host at the step. */
export function useRunHost(node: string | undefined): string | undefined {
  const picked = useUi((s) => s.originHost);
  const byHost = useUi((s) => (node ? s.run?.summary?.inputs?.[node] : undefined));
  if (picked) return picked;
  const hosts = Object.keys(byHost ?? {});
  return hosts.length === 1 ? hosts[0] : undefined;
}

/** One host's recorded value of `name` at `node`, in Run mode with a host to say it for. */
export function useRunValue(
  node: string | undefined,
  name: string,
): { host: string; input: RecordedInput } | undefined {
  const mode = useUi((s) => s.mode);
  const host = useRunHost(node);
  const input = useUi((s) =>
    node && host ? hostInputs(s.run?.summary, node, host)?.[name] : undefined,
  );
  return mode === 'run' && host && input ? { host, input } : undefined;
}

/** The tooltip line (Run mode, one host): "In this run: value (host)", and whether it differs. */
export function RunValueTip({
  node,
  name,
  origin,
}: {
  node: string | undefined;
  name: string;
  origin?: Origin;
}) {
  const v = useRunValue(node, name);
  if (!v) return null;
  const differs = differsFromPredicted(origin, v.input);
  return (
    <div className="afd-run-value" data-run-value={v.host}>
      In this run: <span className="mono">{recordedText(v.input)}</span>{' '}
      <span className="muted">({v.host})</span>
      {differs ? <div className="afd-run-value-differs">{differs}</div> : null}
    </div>
  );
}

/** Why a step has no values of this run: off, not recorded (an older run), or none reached it. */
function noValues(off: boolean | undefined, anyRecorded: boolean): string {
  if (off) return 'Input values were not recorded: the run turned recording off.';
  return anyRecorded
    ? 'No input values of this step in this run.'
    : 'This run did not record input values.';
}

/**
 * Under an input row of a step's Details in Run mode: the value each host had, hosts with the same
 * value together; with a host picked, that host's value and whether it differs from the chain's.
 */
export function RunValues({
  node,
  name,
  originFor,
}: {
  node: string;
  name: string;
  /** The input's origin for a host (the winner differs per host); undefined: none worked out. */
  originFor?: (host: string | undefined) => Origin | undefined;
}) {
  const mode = useUi((s) => s.mode);
  const summary = useUi((s) => s.run?.summary);
  const host = useRunHost(node);
  if (mode !== 'run' || !summary) return null;
  if (!nodeInputsRecorded(summary, node)) {
    const any = Object.keys(summary.inputs ?? {}).length > 0;
    return (
      <div className="afd-run-values muted" data-run-values="none">
        {noValues(summary.inputsOff, any)}
      </div>
    );
  }
  if (host) {
    const input = hostInputs(summary, node, host)?.[name];
    const differs = differsFromPredicted(originFor?.(host), input);
    return (
      <div className="afd-run-values" data-run-values={host}>
        <span className="afd-label">In this run</span>{' '}
        <span className="mono" title={input ? recordedText(input, 2000) : undefined}>
          {input ? recordedText(input) : 'not recorded for this host'}
        </span>{' '}
        <span className="muted">({host})</span>
        {differs ? <div className="afd-run-value-differs">{differs}</div> : null}
      </div>
    );
  }
  const groups = inputValueGroups(summary, node, name);
  if (groups.length === 0)
    return (
      <div className="afd-run-values muted" data-run-values="none">
        Not recorded in this run.
      </div>
    );
  const shown = groups.slice(0, MAX_GROUPS);
  const more = groups.length - shown.length;
  return (
    <div className="afd-run-values" data-run-values="all">
      <span className="afd-label">In this run</span>
      <ul className="afd-run-value-groups">
        {shown.map((g) => {
          const differs = differsFromPredicted(originFor?.(g.hosts[0]), g.input);
          return (
            <li key={g.full} data-run-value-hosts={g.hosts.length}>
              <span className="mono" title={g.full}>
                {g.text}
              </span>{' '}
              <span className="muted" title={g.hosts.join(', ')}>
                ({hostsText(g.hosts)})
              </span>
              {differs ? <div className="afd-run-value-differs">{differs}</div> : null}
            </li>
          );
        })}
      </ul>
      {more > 0 ? (
        <div className="muted">
          and {more} more value{more === 1 ? '' : 's'}: pick a host to see its own
        </div>
      ) : null}
    </div>
  );
}

function hostsText(hosts: string[]): string {
  if (hosts.length <= 3) return hosts.join(', ');
  return `${hosts.slice(0, 2).join(', ')} and ${hosts.length - 2} more hosts`;
}

/**
 * AFD-341: the host the run values (and the repository's winner) are for, in Run mode. It sits
 * outside the read-only Details fieldset, so it can be used there; it lists the run's hosts at the
 * step and the hosts the repository names.
 */
export function RunHostPicker({ node }: { node: string }) {
  const id = useId();
  const mode = useUi((s) => s.mode);
  const byHost = useUi((s) => s.run?.summary?.inputs?.[node]);
  const repo = useUi((s) => s.lensFacts.vars?.hosts);
  const host = useUi((s) => s.originHost);
  const ran = Object.keys(byHost ?? {}).sort();
  if (mode !== 'run' || ran.length === 0) return null;
  const others = (repo ?? []).filter((h) => !ran.includes(h));
  return (
    <div className="afd-origin-host afd-run-host" data-run-host-picker>
      <label htmlFor={id}>For host</label>{' '}
      <select
        id={id}
        value={host ?? ''}
        onChange={(e) => useUi.getState().setOriginHost(e.target.value || null)}
      >
        <option value="">every host of this run</option>
        <optgroup label="Hosts in this run">
          {ran.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </optgroup>
        {others.length ? (
          <optgroup label="Other hosts">
            {others.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </div>
  );
}

/** The inputs one host had at a step, for the Run panel's host rows. */
export function HostInputsRow({ node, host }: { node: string; host: string }) {
  const inputs = useUi((s) => hostInputs(s.run?.summary, node, host));
  const entries = Object.entries(inputs ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return (
    <tr className="afd-run-inputs-row" data-host-inputs={host}>
      <td colSpan={4}>
        {entries.length === 0 ? (
          <span className="muted">No input values recorded for {host}.</span>
        ) : (
          <dl className="afd-run-inputs">
            {entries.map(([name, input]) => (
              <div key={name}>
                <dt className="mono">{name}</dt>
                <dd className="mono" title={recordedText(input, 2000)}>
                  {recordedText(input)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </td>
    </tr>
  );
}
