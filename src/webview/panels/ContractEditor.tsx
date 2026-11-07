// Editor for a contract (flow inputs, node inputs or outputs): one row per field.
import { useState } from 'react';
import { modelOf } from '../../core/flow/model';
import type { Contract, ContractField, ContractType, Ulid } from '../../core/flow/types';
import { fromText } from '../../core/view/fromText';
import { defaultText, defaultValue } from '../../core/view/inputDefault';
import { run } from '../actions';
import { useUi } from '../store';

const TYPES: ContractType[] = ['string', 'integer', 'boolean', 'list', 'dict', 'host_list', 'any'];

/**
 * AFD-95: what a flow input is for, in words, committed when the box is left (round 1: W9). The
 * launch dialog, the run prompts and the AWX survey show it.
 */
function Description({
  name,
  value,
  onCommit,
}: {
  name: string;
  value: string;
  onCommit(text: string): void;
}) {
  const [text, setText] = useState(value);
  const [was, setWas] = useState(value);
  // The flow changed under the box (undo, an agent): show what it says now.
  if (value !== was) {
    setWas(value);
    setText(value);
  }
  const commit = () => text.trim() !== value && onCommit(text.trim());
  return (
    <input
      className="afd-input afd-contract-description"
      aria-label={`What ${name} is for`}
      placeholder="What it is for (shown when a run asks)"
      value={text}
      data-input-description={name}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}
/**
 * AFD-106 (round 3: R6, Y5): a flow input's default, read by its type. A default feeds a run that
 * gives no value, so setting one clears required; the launch dialog and the prompts pre-fill it.
 */
function DefaultBox({
  name,
  type,
  value,
  onCommit,
}: {
  name: string;
  type: ContractType;
  value: unknown;
  onCommit(value: unknown): void;
}) {
  const shown = defaultText(value);
  const [text, setText] = useState(shown);
  const [was, setWas] = useState(shown);
  const [problem, setProblem] = useState<string>();
  // The flow changed under the box (undo, an agent): show what it says now.
  if (shown !== was) {
    setWas(shown);
    setText(shown);
  }
  const commit = () => {
    if (text.trim() === shown) return setProblem(undefined);
    const read = defaultValue(type, text);
    setProblem(read.problem);
    if (!read.problem) onCommit(read.value);
  };
  return (
    <>
      <input
        className={`afd-input mono afd-contract-default${problem ? ' invalid' : ''}`}
        aria-label={`Default for ${name}`}
        aria-invalid={!!problem}
        placeholder="Default (when a run gives none)"
        value={text}
        data-input-default={name}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {problem ? <span className="afd-field-error">{problem}</span> : null}
    </>
  );
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Props {
  title: string;
  target: 'flow' | Ulid;
  side: 'inputs' | 'outputs';
  contract: Contract | undefined;
  /** Show the `from:` column (node contracts). */
  withFrom?: boolean;
  /** What the contract is for, under its title (AFD-72). */
  hint?: string;
}

export function ContractEditor({ title, target, side, contract, withFrom, hint }: Props) {
  const [adding, setAdding] = useState('');
  const doc = useUi((s) => s.snapshot?.doc);
  // AFD-72: `from:` in words; the raw reference stays in the tooltip.
  const fromWords = (s: 'inputs' | 'outputs', from: string) => {
    const model = doc ? modelOf(doc) : undefined;
    const node = target === 'flow' ? undefined : model?.nodes.get(target)?.node;
    return model && node ? fromText(model, node, s, from) : from;
  };
  const entries = Object.entries(contract ?? {});
  const set = (name: string, field: ContractField | null, rename?: string) =>
    run({ kind: 'setContractField', target, side, name, field, rename });
  const add = () => {
    const name = adding.trim();
    if (!NAME.test(name) || name in (contract ?? {})) return;
    // AFD-106 (round 3: R6): a run must give a new flow input until it has a default.
    const field: ContractField =
      target === 'flow' && side === 'inputs'
        ? { type: 'string', required: true }
        : { type: 'string' };
    void set(name, field).then((a) => a.ok && setAdding(''));
  };
  return (
    <section className="afd-section">
      <h3>{title}</h3>
      {hint ? <p className="muted">{hint}</p> : null}
      {entries.length === 0 ? <p className="muted">None yet.</p> : null}
      <ul className="afd-contract">
        {entries.map(([name, field]) => (
          <li key={name}>
            <span className="mono afd-contract-name">{name}</span>
            <select
              aria-label={`Type of ${name}`}
              value={field?.type ?? 'any'}
              onChange={(e) => void set(name, { ...field, type: e.target.value as ContractType })}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {side === 'inputs' ? (
              <label className="afd-check" title="Required">
                <input
                  type="checkbox"
                  checked={!!field?.required}
                  onChange={(e) =>
                    void set(name, { ...field, required: e.target.checked || undefined })
                  }
                />
                required
              </label>
            ) : null}
            {withFrom && field?.from ? (
              <span
                className="muted afd-contract-from"
                title={`Source of the value: ${field.from}`}
              >
                ← {fromWords(side, field.from)}
              </span>
            ) : null}
            <button
              type="button"
              className="icon"
              aria-label={`Remove ${name}`}
              onClick={() => void set(name, null)}
            >
              <span className="codicon codicon-trash" aria-hidden="true" />
            </button>
            {/* The targets list says what it is (the hosts the flow runs on): a new flow, which
              has only that input, keeps its 35 controls. */}
            {target === 'flow' && side === 'inputs' && !field?.targets ? (
              <>
                <Description
                  name={name}
                  value={field?.description ?? ''}
                  onCommit={(text) =>
                    void set(name, { ...field, description: text || undefined } as ContractField)
                  }
                />
                <DefaultBox
                  name={name}
                  type={field?.type ?? 'any'}
                  value={field?.default}
                  onCommit={(value) => {
                    const next = { ...field } as ContractField;
                    if (value === undefined) delete next.default;
                    else {
                      next.default = value;
                      delete next.required;
                    }
                    void set(name, next);
                  }}
                />
              </>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="afd-inline-add">
        <input
          className={`afd-input mono${adding && !NAME.test(adding.trim()) ? ' invalid' : ''}`}
          placeholder="new_name"
          aria-label={`New ${side.slice(0, -1)} name`}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button
          type="button"
          className="secondary"
          onClick={add}
          disabled={!NAME.test(adding.trim())}
        >
          Add
        </button>
      </div>
    </section>
  );
}
