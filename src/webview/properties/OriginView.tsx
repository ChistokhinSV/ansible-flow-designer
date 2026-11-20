// AFD-339: where a value comes from, drawn from core/flow/origin. The chain under a variable's
// tooltip and under an input row in Details: each hop in words, its value, default or template,
// then what the flow knows about precedence. A hop on a step selects it and opens its Details.
// Nothing here is VS Code's: the server's embedded viewer draws the same.
import { createContext, useCallback, useContext, useMemo } from 'react';
import { upstreamNodes } from '../../core/flow/dataRefs';
import { type Hop, nameOrigin, type Origin, type OriginOptions } from '../../core/flow/origin';
import type { FlowNode } from '../../core/flow/types';
import { useResultFields } from '../catalog';
import { useModel } from '../hooks';
import { useUi } from '../store';

/** The step whose fields are shown: Details provides it, the Jinja fields read it. */
export const OriginScope = createContext<string | undefined>(undefined);

/** What origin needs besides the model: the flow's findings and module result docs. */
export function useOriginOptions(node: FlowNode | undefined): OriginOptions {
  const model = useModel();
  const findings = useUi((s) => s.snapshot?.findings);
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
    }),
    [findings, fields],
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

function HopLine({ hop }: { hop: Hop }) {
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
      className={`afd-origin-hop${hop.static ? ' static' : ''}`}
      data-origin-hop={hop.kind}
      style={{ paddingInlineStart: `${hop.depth * 12}px` }}
    >
      <span className="afd-origin-arrow" aria-hidden="true">
        ←
      </span>{' '}
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
      {hop.doc ? <div className="muted afd-origin-doc">{hop.doc}</div> : null}
    </li>
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
    </div>
  );
}
