// Editor for a contract (flow inputs, node inputs or outputs): one row per field.
import { useState } from 'react';
import type { Contract, ContractField, ContractType, Ulid } from '../../core/flow/types';
import { run } from '../actions';

const TYPES: ContractType[] = ['string', 'integer', 'boolean', 'list', 'dict', 'host_list', 'any'];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Props {
  title: string;
  target: 'flow' | Ulid;
  side: 'inputs' | 'outputs';
  contract: Contract | undefined;
  /** Show the `from:` column (node contracts). */
  withFrom?: boolean;
}

export function ContractEditor({ title, target, side, contract, withFrom }: Props) {
  const [adding, setAdding] = useState('');
  const entries = Object.entries(contract ?? {});
  const set = (name: string, field: ContractField | null, rename?: string) =>
    run({ kind: 'setContractField', target, side, name, field, rename });
  const add = () => {
    const name = adding.trim();
    if (!NAME.test(name) || name in (contract ?? {})) return;
    void set(name, { type: 'string' }).then((a) => a.ok && setAdding(''));
  };
  return (
    <section className="afd-section">
      <h3>{title}</h3>
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
                req
              </label>
            ) : null}
            {withFrom && field?.from ? (
              <span className="mono muted afd-contract-from" title="Source of the value">
                ← {field.from}
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
