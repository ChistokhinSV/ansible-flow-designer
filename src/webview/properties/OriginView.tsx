// AFD-339: where a value comes from, drawn from core/flow/origin. The chain under a variable's
// tooltip and under an input row in Details: each hop in words, its value, default or template,
// then what the flow knows about precedence. A hop on a step selects it and opens its Details.
// Nothing here is VS Code's: the server's embedded viewer draws the same.
// AFD-340: with the repository's variables from the host, a "Defined in" list of every place that
// defines the name (file:line, a link when the host opens files), its rank in words, the winner
// for the host picked; the host picker sits in Details.
import { createContext, useCallback, useContext, useId, useMemo } from 'react';
import { upstreamNodes } from '../../core/flow/dataRefs';
import {
  type Defined,
  type Hop,
  nameOrigin,
  type Origin,
  type OriginOptions,
} from '../../core/flow/origin';
import type { FlowNode } from '../../core/flow/types';
import { rankWord } from '../../core/inventory/varIndex';
import { send } from '../bus';
import { useResultFields } from '../catalog';
import { useModel } from '../hooks';
import { useUi } from '../store';

/** The step whose fields are shown: Details provides it, the Jinja fields read it. */
export const OriginScope = createContext<string | undefined>(undefined);

/** What origin needs besides the model: the flow's findings and module result docs. */
export function useOriginOptions(node: FlowNode | undefined): OriginOptions {
  const model = useModel();
  const findings = useUi((s) => s.snapshot?.findings);
  const index = useUi((s) => s.lensFacts.vars);
  const host = useUi((s) => s.originHost);
  const refs =
    model && node
      ? [node, ...upstreamNodes(model, node.id)].flatMap((n) =>
          n.impl?.kind === 'module' && n.impl.ref ? [n.impl.ref] : [],
        )
      : [];
  const fields = useResultFields(refs);
  return useMemo(
    () => ({
      findings,
      fieldsOf: (step: FlowNode) => (step.impl?.ref ? fields[step.impl.ref] : undefined),
      ...(index ? { index } : {}),
      ...(index && host ? { host } : {}),
    }),
    [findings, fields, index, host],
  );
}

/** Where a `{{ name }}` of the scoped step comes from; undefined outside a step's Details. */
export function useNameOrigin(): ((name: string) => Origin | undefined) | undefined {
  const id = useContext(OriginScope);
  const model = useModel();
  const node = id ? model?.nodes.get(id)?.node : undefined;
  const opts = useOriginOptions(node);
  const of = useCallback(
    (name: string) => (model && node ? nameOrigin(model, node, name, opts) : undefined),
    [model, node, opts],
  );
  return node ? of : undefined;
}

/** Select a hop's step and open its Details (the same as a finding's Open Details). */
function go(id: string): void {
  const ui = useUi.getState();
  ui.reveal(id);
  ui.openDetails(id);
}

/** Where a definition is written: a link that opens it when the host can, else file:line. */
function FileAt({ hop }: { hop: Hop }) {
  const openFiles = useUi((s) => s.openFiles);
  if (hop.file === undefined) return null;
  const at = `${hop.file}:${(hop.line ?? 0) + 1}`;
  if (!openFiles) return <span className="muted mono afd-origin-file"> {at}</span>;
  const open = () =>
    send({ type: 'openCode', path: hop.file as string, line: (hop.line ?? 0) + 1 });
  return (
    <>
      {' '}
      {/* biome-ignore lint/a11y/useSemanticElements: a button in a disabled fieldset is disabled. */}
      <span
        role="button"
        tabIndex={0}
        className="link mono afd-origin-file"
        title={`Open ${at}`}
        onMouseDown={(e) => {
          e.preventDefault();
          open();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        }}
      >
        {at}
      </span>
    </>
  );
}

function HopLine({ hop, mark }: { hop: Hop; mark?: 'wins' | 'other' }) {
  const value =
    hop.value !== undefined ? hop.value : hop.template !== undefined ? hop.template : undefined;
  const body = (
    <>
      <span className="afd-origin-label">{hop.label}</span>
      {value !== undefined ? <span className="mono afd-origin-value"> = {value}</span> : null}
      {hop.fallback !== undefined ? <span className="muted"> (default {hop.fallback})</span> : null}
      {hop.secret ? <span className="muted"> (secret: not shown)</span> : null}
    </>
  );
  return (
    <li
      className={`afd-origin-hop${hop.static ? ' static' : ''}${mark ? ` ${mark}` : ''}`}
      data-origin-hop={hop.kind}
      style={{ paddingInlineStart: `${hop.depth * 12}px` }}
    >
      <span className="afd-origin-arrow" aria-hidden="true">
        {mark === 'wins' ? '★' : '←'}
      </span>{' '}
      {hop.rank !== undefined && !hop.label.startsWith(rankWord(hop.rank)) ? (
        // AFS-189: not "host_vars host_vars of sw-01": the label names the kind already.
        <span className="afd-origin-rank">{rankWord(hop.rank)}</span>
      ) : null}
      {hop.node ? (
        // A span, not a button: a read-only Details is a disabled fieldset, and a hop still goes.
        // biome-ignore lint/a11y/useSemanticElements: a button in a disabled fieldset is disabled.
        <span
          role="button"
          tabIndex={0}
          className="link afd-origin-go"
          title="Select this step"
          // A field keeps its focus (and its tooltip) until the step is selected.
          onMouseDown={(e) => {
            e.preventDefault();
            go(hop.node as string);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              go(hop.node as string);
            }
          }}
        >
          {body}
        </span>
      ) : (
        body
      )}
      <FileAt hop={hop} />
      {mark === 'wins' ? <span className="afd-origin-wins"> wins</span> : null}
      {mark === 'other' ? <span className="muted"> (other hosts)</span> : null}
      {hop.doc ? <div className="muted afd-origin-doc">{hop.doc}</div> : null}
    </li>
  );
}

/** AFD-340: the host the winner is worked out for, from the hosts the repository names. */
export function OriginHostPicker() {
  const id = useId();
  const hosts = useUi((s) => s.lensFacts.vars?.hosts);
  const host = useUi((s) => s.originHost);
  if (!hosts?.length) return null;
  return (
    <div className="afd-origin-host">
      <label htmlFor={id}>For host</label>{' '}
      <select
        id={id}
        value={host ?? ''}
        onChange={(e) => useUi.getState().setOriginHost(e.target.value || null)}
      >
        <option value="">any host</option>
        {hosts.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </div>
  );
}

/** AFD-340: every place in the repository that defines the name, the winner marked. */
function DefinedList({ defined }: { defined: Defined }) {
  return (
    <div className="afd-origin-defined" data-origin-defined>
      <div className="afd-origin-defined-head">
        Defined in the repository <span className="muted">({defined.scope})</span>
      </div>
      {defined.beaten ? (
        <div className="muted">
          {defined.beaten[0]?.toUpperCase()}
          {defined.beaten.slice(1)} wins over all of them.
        </div>
      ) : null}
      <ol className="afd-origin-hops" aria-label={`Where ${defined.name} is defined`}>
        {defined.hops.map((h, i) => (
          <HopLine
            // biome-ignore lint/suspicious/noArrayIndexKey: definitions are positional.
            key={i}
            hop={h}
            // AFS-189: when the flow's value wins over all of them, none of them is starred.
            mark={
              i === defined.winner && !defined.beaten
                ? 'wins'
                : defined.others?.includes(i)
                  ? 'other'
                  : undefined
            }
          />
        ))}
      </ol>
      {defined.why && !defined.beaten ? (
        <div className="muted">
          {defined.why[0]?.toUpperCase()}
          {defined.why.slice(1)}.
        </div>
      ) : null}
    </div>
  );
}

/** The chain, then the precedence notes. */
export function OriginChain({ origin }: { origin: Origin }) {
  return (
    <div className="afd-origin" data-origin>
      <ol className="afd-origin-hops" aria-label="Where the value comes from">
        {origin.hops.map((h, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: hops are positional.
          <HopLine key={i} hop={h} />
        ))}
      </ol>
      {origin.cut ? (
        <div className="muted">
          {origin.cut === 'cycle'
            ? 'The chain comes back to a value it passed.'
            : 'The chain goes on: too many steps to show.'}
        </div>
      ) : null}
      {origin.secret ? <div className="muted">Secret: values are not shown.</div> : null}
      {origin.notes.map((n) => (
        <div key={n} className="afd-origin-note">
          <span className="codicon codicon-info" aria-hidden="true" /> {n}
        </div>
      ))}
      {origin.defined ? <DefinedList defined={origin.defined} /> : null}
    </div>
  );
}
