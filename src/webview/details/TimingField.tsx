// AFD-112 (round 4: Q4): Retries, Delay and Timeout take a number, or a value given at run time.
// The participant asked to let the operator set a drain wait wrote it into the flow's goal: the
// Timing fields took only numbers, and nothing tied "a value given at run time" to them. A field
// takes an input with @, as a binding parameter does, and "Ask at run time…" makes the flow input,
// the step input that reads it and the template in one edit.
import { useId, useState } from 'react';
import type { RefChoice } from '../../core/catalog/draft';
import { durationSeconds } from '../../core/flow/duration';
import type { ContractField, FlowDocument, FlowNode } from '../../core/flow/types';
import {
  askedInput,
  type SettingField,
  settingProblem,
  settingText,
  settingValue,
} from '../../core/view/settings';
import { run } from '../actions';
import { ChipField } from '../properties/ChipField';
import { useCommitDraft } from './ExprField';

type RunTimeKey = 'retries' | 'delay' | 'timeout';

interface Props {
  node: FlowNode;
  flow: FlowDocument['flow'] | undefined;
  field: SettingField & { key: RunTimeKey };
  /** The field's label with its help, as the other fields show it. */
  label: string;
  choices: RefChoice[];
  /** A problem the flow check found with the stored value. */
  problem?: string;
  /** Saves the value, with the step inputs the chips it holds added (one edit). */
  onCommit(value: unknown, inputs: Record<string, ContractField>): void;
}

export function TimingField({ node, flow, field, label, choices, problem, onCommit }: Props) {
  const id = useId();
  const value = node.settings?.[field.key];
  const shown = settingText(value, field);
  const [asking, setAsking] = useState(false);
  // AFD-227: the draft, Enter, Escape and leaving, and the inputs picked with @, shared with the
  // expression fields.
  const { draft, change, revert, commit, addInput } = useCommitDraft(shown, {
    invalid: (text) => settingProblem(field, text),
    onCommit: (text, inputs) => onCommit(settingValue(field, text), inputs),
  });
  const error = draft !== shown ? settingProblem(field, draft) : problem;
  const asked = askedInput(value, node);
  return (
    <div className="afd-field afd-timing-field" data-timing-field={field.key}>
      <label htmlFor={id}>{label}</label>
      <ChipField
        id={id}
        label={label}
        value={draft}
        onChange={change}
        choices={choices}
        onAddInput={addInput}
        onEnter={commit}
        onEscape={revert}
        onLeave={commit}
      />
      {error ? (
        <div className="afd-field-error" id={`${id}-error`}>
          {error}
        </div>
      ) : null}
      {asked ? (
        <p className="muted afd-timing-asked" data-timing-asked={field.key}>
          Asked at run time: the flow input {asked.flow}
          {defaultWords(flow?.inputs?.[asked.flow]?.default, field.key)}.
        </p>
      ) : asking ? (
        <AskAtRunTime node={node} field={field} value={value} onDone={() => setAsking(false)} />
      ) : (
        <button
          type="button"
          className="link afd-timing-ask"
          data-timing-ask={field.key}
          onClick={() => setAsking(true)}
        >
          Ask at Run Time…
        </button>
      )}
    </div>
  );
}

/** ", default 12" or ", default 30 s"; ", no default" when the person must give it. */
function defaultWords(value: unknown, key: RunTimeKey): string {
  if (value === undefined) return ', no default: whoever runs the flow gives it';
  return `, default ${String(value)}${key === 'retries' ? '' : ' s'}`;
}

const WHAT: Record<RunTimeKey, (title: string) => string> = {
  retries: (t) => `How many more times ${t} tries`,
  delay: (t) => `Seconds between the tries of ${t}`,
  timeout: (t) => `Seconds one try of ${t} may take`,
};

/** The field's value as the flow input's default: a count, or whole seconds. */
function defaultFor(key: RunTimeKey, value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (key === 'timeout' && typeof value === 'string') {
    const s = durationSeconds(value);
    if (s !== undefined) return String(s);
  }
  // Ansible's own defaults; a timeout has none.
  return key === 'retries' ? '3' : key === 'delay' ? '5' : '';
}

/**
 * The form "Ask at run time…" opens under a Timing field: the input's name, what it is for, and
 * its default, then one `askAtRunTime` edit.
 */
function AskAtRunTime({
  node,
  field,
  value,
  onDone,
}: {
  node: FlowNode;
  field: SettingField & { key: RunTimeKey };
  value: unknown;
  onDone(): void;
}) {
  const id = useId();
  const [name, setName] = useState(`${node.key.replaceAll('-', '_')}_${field.key}`);
  const [description, setDescription] = useState(WHAT[field.key](node.title));
  const [fallback, setFallback] = useState(defaultFor(field.key, value));
  const nameProblem = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    ? undefined
    : 'A variable name: letters, digits and _';
  const defaultProblem = /^[0-9]*$/.test(fallback.trim()) ? undefined : 'A whole number, or empty';
  const ask = () => {
    if (nameProblem || defaultProblem) return;
    void run({
      kind: 'askAtRunTime',
      id: node.id,
      setting: field.key,
      name,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(fallback.trim() ? { default: Number(fallback.trim()) } : {}),
    });
    onDone();
  };
  return (
    <fieldset className="afd-timing-askform" data-timing-askform={field.key}>
      <legend>Ask for {field.label} at run time</legend>
      <p className="muted">
        A flow input, asked for when the flow runs (the launch dialog, an AWX survey), feeds this
        step's {field.label}
        {field.key === 'retries' ? '' : ' in seconds'}.
      </p>
      <div className="afd-field">
        <label htmlFor={`${id}-name`}>Input name</label>
        <input
          id={`${id}-name`}
          className={`afd-input mono${nameProblem ? ' invalid' : ''}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {nameProblem ? <div className="afd-field-error">{nameProblem}</div> : null}
      </div>
      <div className="afd-field">
        <label htmlFor={`${id}-description`}>What it is for</label>
        <input
          id={`${id}-description`}
          className="afd-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="afd-field">
        <label htmlFor={`${id}-default`}>
          Default{field.key === 'retries' ? '' : ' (seconds)'}; empty: required
        </label>
        <input
          id={`${id}-default`}
          className={`afd-input mono${defaultProblem ? ' invalid' : ''}`}
          inputMode="numeric"
          value={fallback}
          onChange={(e) => setFallback(e.target.value)}
        />
        {defaultProblem ? <div className="afd-field-error">{defaultProblem}</div> : null}
      </div>
      <div className="afd-timing-askform-buttons">
        <button type="button" disabled={!!nameProblem || !!defaultProblem} onClick={ask}>
          Ask at Run Time
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}
