// Editor for a contract (flow inputs, node inputs or outputs). AFD-298: one compact row per field
// (name, type, where it comes from, required or its default); a row opens a small form with
// labelled fields and Remove. "Add input" opens the same form, empty, with the name focused.
// Everything is saved as it is changed, as the other fields of the pane are.
import { type InputHTMLAttributes, useEffect, useId, useRef, useState } from 'react';
import { refChoices } from '../../core/catalog/draft';
import { modelOf, ROOT } from '../../core/flow/model';
import {
  fromOrigin,
  inputOrigin,
  type Origin,
  originText,
  outputOrigin,
} from '../../core/flow/origin';
import type { Contract, ContractField, ContractType, FlowNode, Ulid } from '../../core/flow/types';
import { fromText } from '../../core/view/fromText';
import { defaultText, defaultValue } from '../../core/view/inputDefault';
import { run } from '../actions';
import { useDetailsReadOnly } from '../details/readOnly';
import { useEditable } from '../editActions';
import { OriginChain, OriginHostPicker, useOriginOptions } from '../properties/OriginView';
import { RunHostPicker, RunValues } from '../properties/RunValues';
import { useUi } from '../store';

const TYPES: ContractType[] = ['string', 'integer', 'boolean', 'list', 'dict', 'host_list', 'any'];

/** What each type is called on screen; the file keeps Ansible's names. */
const TYPE_WORDS: Record<ContractType, string> = {
  string: 'text',
  integer: 'number',
  boolean: 'yes/no',
  list: 'list',
  dict: 'map',
  host_list: 'host list',
  any: 'any',
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_HELP = 'Letters, digits and _, starting with a letter or _';

/** A text box that saves when it is left or Enter is pressed (and follows the flow when it changes). */
function CommitBox({
  value,
  onCommit,
  validate,
  ...rest
}: {
  value: string;
  onCommit(text: string): void;
  validate?(text: string): string | undefined;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value);
  const [was, setWas] = useState(value);
  const [problem, setProblem] = useState<string>();
  // The flow changed under the box (undo, an agent): show what it says now.
  if (value !== was) {
    setWas(value);
    setText(value);
  }
  const commit = () => {
    if (text.trim() === value) return setProblem(undefined);
    const why = validate?.(text);
    setProblem(why);
    if (!why) onCommit(text.trim());
  };
  return (
    <>
      <input
        {...rest}
        className={`afd-input ${rest.className ?? ''}${problem ? ' invalid' : ''}`}
        aria-invalid={!!problem}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setText(value);
            setProblem(undefined);
          }
        }}
      />
      {problem ? <span className="afd-field-error">{problem}</span> : null}
    </>
  );
}

interface Props {
  title: string;
  target: 'flow' | Ulid;
  side: 'inputs' | 'outputs';
  contract: Contract | undefined;
  /** Show where each value comes from (node contracts). */
  withFrom?: boolean;
  /** What the contract is for, under its title (AFD-72). */
  hint?: string;
}

export function ContractEditor({ title, target, side, contract, withFrom, hint }: Props) {
  const [open, setOpen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const doc = useUi((s) => s.snapshot?.doc);
  const model = doc ? modelOf(doc) : undefined;
  const node = target === 'flow' ? undefined : model?.nodes.get(target)?.node;
  // AFD-309: a flow's outputs read what reaches its end, as a step there would read it.
  const flowOutputs = target === 'flow' && side === 'outputs';
  const end = flowOutputs ? endOf(model) : undefined;
  // AFD-72: `from:` in words; the raw reference stays in the tooltip.
  const fromWords = (from: string) =>
    model && node
      ? fromText(model, node, side, from)
      : model && end
        ? fromText(model, end, 'inputs', from)
        : from;
  // AFD-339: where each value comes from, hop by hop (a step's inputs and outputs, a flow's outputs).
  const originOpts = useOriginOptions(node ?? end);
  const originOf = (name: string, field: ContractField | undefined): Origin | undefined => {
    if (!model) return undefined;
    if (node) {
      if (side === 'inputs') return inputOrigin(model, node, name, originOpts);
      return field?.from || node.type === 'subflow' || node.impl
        ? outputOrigin(model, node, name, originOpts)
        : undefined;
    }
    return end && field?.from
      ? fromOrigin(model, end, 'inputs', field.from, originOpts)
      : undefined;
  };
  // AFD-341: in Run mode, a step's inputs show the value each host had; the chain's value to
  // compare with is worked out for that host (the repository's winner differs per host).
  const mode = useUi((s) => s.mode);
  const editable = useEditable();
  // AFS-188: read-only, the rows still open (where a value comes from); nothing to change is shown.
  const readOnly = useDetailsReadOnly() || !editable;
  const runValues = mode === 'run' && !!node && side === 'inputs' && !!model;
  const originForHost = (name: string) => (host: string | undefined) =>
    model && node
      ? inputOrigin(model, node, name, {
          ...originOpts,
          ...(originOpts.index && host ? { host } : {}),
        })
      : undefined;
  const entries = Object.entries(contract ?? {});
  const one = side === 'inputs' ? 'input' : 'output';
  const flowInputs = target === 'flow' && side === 'inputs';
  const set = (name: string, field: ContractField | null, rename?: string) =>
    run({ kind: 'setContractField', target, side, name, field, rename });
  // AFD-287: a step's new input from what reaches it: flow inputs, earlier steps' outputs, their
  // results and facts (as the @ list offers them; a result or fact becomes an output there too).
  const sources =
    withFrom && side === 'inputs' && model && node
      ? refChoices(model, node).filter((c) => c.field?.from)
      : model && end
        ? // A top-level step's output, result or fact: not a flow input, not inside a subflow.
          refChoices(model, end).filter((c) => {
            const head = c.field?.from?.split('.')[0] ?? '';
            return !!c.field?.from && head !== 'flow' && !head.includes('/');
          })
        : [];
  const addFrom = async (label: string) => {
    const c = sources.find((x) => x.label === label);
    if (!c?.field) return;
    if (flowOutputs) {
      // The step gives it as an output first (a result or a fact it sets), then the flow does.
      if (c.expose)
        await run({
          kind: 'setContractField',
          target: c.expose.node,
          side: 'outputs',
          name: c.expose.output,
          field: c.expose.field ?? { type: 'any' },
        });
      await set(c.name, { type: c.field.type ?? 'any', from: c.field.from });
      return;
    }
    if (c.expose && !c.expose.field?.from && c.expose.field) {
      await run({ kind: 'useFact', reader: target, setter: c.expose.node, name: c.expose.output });
      return;
    }
    if (c.expose)
      await run({
        kind: 'setContractField',
        target: c.expose.node,
        side: 'outputs',
        name: c.expose.output,
        field: c.expose.field ?? { type: 'dict', from: 'impl.register' },
      });
    await set(c.name, c.field);
  };
  return (
    <section className="afd-section afd-contract-section">
      <div className="afd-section-head">
        <h3>{title}</h3>
        {!adding && !readOnly ? (
          <button
            type="button"
            className="link"
            onClick={() => {
              setAdding(true);
              setOpen(undefined);
            }}
          >
            <span className="codicon codicon-add" aria-hidden="true" /> Add {one}
          </button>
        ) : null}
      </div>
      {hint ? <p className="muted afd-help">{hint}</p> : null}
      {/* AFD-340: the host where a value comes from is worked out for (the repository's hosts);
        AFD-341: in Run mode, the run's hosts. AFS-188: here in every mode, in the panel's padding. */}
      {side === 'inputs' && node ? (
        mode === 'run' ? (
          <RunHostPicker node={node.id} />
        ) : (
          <OriginHostPicker />
        )
      ) : null}
      {entries.length === 0 && !adding ? <p className="muted">None yet.</p> : null}
      <ul className="afd-contract">
        {entries.map(([name, field]) => {
          const isOpen = open === name;
          const origin = originOf(name, field);
          const meta =
            side === 'outputs'
              ? undefined
              : field?.default !== undefined
                ? `= ${defaultText(field.default)}`
                : field?.required
                  ? 'required'
                  : 'optional';
          return (
            <li key={name} className={isOpen ? 'open' : undefined} data-contract-field={name}>
              <button
                type="button"
                className="afd-contract-row"
                title={origin?.hops.length && !field?.from ? originText(origin) : undefined}
                aria-expanded={isOpen}
                aria-label={`${name}: ${TYPE_WORDS[field?.type ?? 'any']}${meta ? `, ${meta}` : ''}`}
                onClick={() => setOpen(isOpen ? undefined : name)}
              >
                <span className="mono afd-contract-name">{name}</span>
                <span className="afd-chip">{TYPE_WORDS[field?.type ?? 'any']}</span>
                {field?.targets ? (
                  <span className="afd-chip accent" title="The hosts the run starts on">
                    targets
                  </span>
                ) : null}
                {withFrom && field?.from ? (
                  <span
                    className="muted afd-contract-from"
                    title={`Comes from ${field.from}${
                      origin?.hops.length ? `\n${originText(origin)}` : ''
                    }`}
                  >
                    ← {fromWords(field.from)}
                  </span>
                ) : null}
                {meta ? <span className="muted afd-contract-meta">{meta}</span> : null}
                <span
                  className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`}
                  aria-hidden="true"
                />
              </button>
              {runValues && node ? (
                <RunValues node={node.id} name={name} originFor={originForHost(name)} />
              ) : null}
              {isOpen ? (
                <FieldForm
                  readOnly={readOnly}
                  name={name}
                  field={field}
                  side={side}
                  flowInputs={flowInputs}
                  taken={(n) => n !== name && n in (contract ?? {})}
                  from={withFrom && field?.from ? fromWords(field.from) : undefined}
                  origin={origin?.hops.length ? origin : undefined}
                  onChange={(next, rename) => {
                    void set(name, next, rename).then((a) => {
                      if (a.ok && rename) setOpen(rename);
                    });
                  }}
                  onRemove={() => {
                    setOpen(undefined);
                    void set(name, null);
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {adding ? (
        <NewField
          one={one}
          taken={(n) => n in (contract ?? {})}
          onAdd={async (name, type) => {
            // AFD-106 (round 3: R6): a run must give a new flow input until it has a default.
            const field: ContractField = flowInputs ? { type, required: true } : { type };
            const a = await set(name, field);
            if (a.ok) {
              setAdding(false);
              setOpen(name);
            }
          }}
          onCancel={() => setAdding(false)}
          sources={sources.map((c) => ({ label: c.label, detail: c.detail }))}
          fromLabel={flowOutputs ? "Take a step's output" : 'Take one that reaches this step'}
          onAddFrom={(label) => {
            setAdding(false);
            void addFrom(label);
          }}
        />
      ) : null}
    </section>
  );
}

/** One field's form: its name, type, whether a run must give it, what it is asked as, its default. */
function FieldForm({
  name,
  field,
  side,
  flowInputs,
  taken,
  from,
  origin,
  onChange,
  onRemove,
  readOnly,
}: {
  readOnly?: boolean;
  name: string;
  field: ContractField | undefined;
  side: 'inputs' | 'outputs';
  flowInputs: boolean;
  taken(name: string): boolean;
  from?: string;
  origin?: Origin;
  onChange(field: ContractField, rename?: string): void;
  onRemove(): void;
}) {
  const id = useId();
  const current = (field ?? { type: 'any' }) as ContractField;
  return (
    // AFS-188: read-only, the fields read as text and the chain's hops still go to their steps.
    <fieldset className="afd-contract-form afd-editable" disabled={readOnly}>
      <div className="afd-field">
        <label htmlFor={`${id}-name`}>Name</label>
        <CommitBox
          id={`${id}-name`}
          className="mono"
          value={name}
          validate={(t) =>
            !NAME.test(t.trim())
              ? NAME_HELP
              : taken(t.trim())
                ? `There is a ${t.trim()} already`
                : undefined
          }
          onCommit={(t) => onChange(current, t)}
        />
      </div>
      <div className="afd-field">
        <label htmlFor={`${id}-type`}>Type</label>
        <select
          id={`${id}-type`}
          aria-label={`Type of ${name}`}
          value={current.type ?? 'any'}
          onChange={(e) => onChange({ ...current, type: e.target.value as ContractType })}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_WORDS[t]}
            </option>
          ))}
        </select>
      </div>
      {origin ? (
        <div className="afd-field" data-comes-from>
          <span className="afd-label">Comes from</span>
          <OriginChain origin={origin} />
        </div>
      ) : from ? (
        <div className="afd-field">
          <span className="afd-label">Comes from</span>
          <span className="afd-value">{from}</span>
        </div>
      ) : null}
      {side === 'inputs' ? (
        <div className="afd-field afd-check">
          <label>
            <input
              type="checkbox"
              checked={!!current.required}
              onChange={(e) => onChange({ ...current, required: e.target.checked || undefined })}
            />{' '}
            Required
          </label>
          <span className="afd-help">
            {flowInputs
              ? 'A run must give it (a default makes it optional).'
              : 'The step fails when nothing gives it.'}
          </span>
        </div>
      ) : null}
      {/* The targets list says what it is: the hosts the run starts on. */}
      {flowInputs && !current.targets ? (
        <>
          <div className="afd-field">
            <label htmlFor={`${id}-asked`}>Asked as</label>
            <CommitBox
              id={`${id}-asked`}
              aria-label={`What ${name} is for`}
              data-input-description={name}
              placeholder="Folder for the configuration backups"
              value={current.description ?? ''}
              onCommit={(t) => onChange({ ...current, description: t || undefined })}
            />
            <span className="afd-help">
              Shown when a run asks for it: in the launch dialog, the prompts and the AWX survey.
            </span>
          </div>
          <DefaultField name={name} field={current} onChange={onChange} />
        </>
      ) : null}
      {flowInputs && current.targets ? (
        <p className="muted afd-help">The hosts the run starts on: the start node's targets.</p>
      ) : null}
      {readOnly ? null : (
        <button
          type="button"
          className="link danger"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <span className="codicon codicon-trash" aria-hidden="true" /> Remove
        </button>
      )}
    </fieldset>
  );
}

/**
 * AFD-106 (round 3: R6, Y5): a flow input's default, read by its type. A default feeds a run that
 * gives no value, so setting one clears required; the launch dialog and the prompts pre-fill it.
 */
function DefaultField({
  name,
  field,
  onChange,
}: {
  name: string;
  field: ContractField;
  onChange(field: ContractField): void;
}) {
  const id = useId();
  const type = field.type ?? 'any';
  return (
    <div className="afd-field">
      <label htmlFor={id}>Default</label>
      <CommitBox
        id={id}
        className="mono"
        aria-label={`Default for ${name}`}
        data-input-default={name}
        value={defaultText(field.default)}
        validate={(t) => defaultValue(type, t).problem}
        onCommit={(t) => {
          const next = { ...field } as ContractField;
          const read = defaultValue(type, t);
          if (read.value === undefined) delete next.default;
          else {
            next.default = read.value;
            delete next.required;
          }
          onChange(next);
        }}
      />
      <span className="afd-help">Used when a run gives none.</span>
    </div>
  );
}

/** A new field: its name (focused) and type; or, for a step's input, one of what reaches it. */
function NewField({
  one,
  taken,
  onAdd,
  onCancel,
  sources,
  onAddFrom,
  fromLabel,
}: {
  one: string;
  taken(name: string): boolean;
  onAdd(name: string, type: ContractType): Promise<void>;
  onCancel(): void;
  sources: { label: string; detail: string }[];
  onAddFrom(label: string): void;
  /** What the picker of sources is called. */
  fromLabel: string;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [type, setType] = useState<ContractType>('string');
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => box.current?.focus(), []);
  const n = name.trim();
  const why = !n
    ? undefined
    : !NAME.test(n)
      ? NAME_HELP
      : taken(n)
        ? `There is a ${n} already`
        : undefined;
  const add = () => {
    if (n && !why) void onAdd(n, type);
  };
  return (
    <div className="afd-contract-form afd-contract-new">
      {sources.length ? (
        <div className="afd-field">
          <label htmlFor={`${id}-from`}>{fromLabel}</label>
          <select
            id={`${id}-from`}
            aria-label={`Add an ${one} from`}
            value=""
            onChange={(e) => onAddFrom(e.target.value)}
          >
            <option value="">Pick…</option>
            {sources.map((c) => (
              <option key={c.label} value={c.label} title={c.detail}>
                {c.label} · {c.detail.split(' · ')[0]}
              </option>
            ))}
          </select>
          <span className="afd-help">Or name a new one:</span>
        </div>
      ) : null}
      <div className="afd-field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input
          ref={box}
          id={`${id}-name`}
          className={`afd-input mono${why ? ' invalid' : ''}`}
          aria-label={`New ${one} name`}
          placeholder="backup_dir"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
            if (e.key === 'Escape') onCancel();
          }}
        />
        <span className={why ? 'afd-field-error' : 'afd-help'}>{why ?? NAME_HELP}</span>
      </div>
      <div className="afd-field">
        <label htmlFor={`${id}-type`}>Type</label>
        <select
          id={`${id}-type`}
          value={type}
          onChange={(e) => setType(e.target.value as ContractType)}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_WORDS[t]}
            </option>
          ))}
        </select>
      </div>
      <div className="afd-form-actions">
        <button type="button" onClick={add} disabled={!n || !!why}>
          Add
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** AFD-309: the flow's success end on the top level (else any end): where flow outputs are read. */
function endOf(model: ReturnType<typeof modelOf> | undefined): FlowNode | undefined {
  const ends = (model?.levels.get(ROOT)?.nodes ?? []).filter(
    (n): n is FlowNode => n?.type === 'end',
  );
  return ends.find((n) => n.outcome !== 'failed') ?? ends[0];
}
