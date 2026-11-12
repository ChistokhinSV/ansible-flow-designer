// Fields that hold a bare expression (AFD-227): a decision's Condition and Until. Ansible reads
// them without braces, so they are chip fields in expression mode: coloured as one expression,
// completed as one (the node's variables, filters, tests, a result's fields), and `@` puts in a
// bare name. They save as CommitField saves: on Enter and when the focus leaves, Escape takes the
// typing back, and a value `validate` refuses is not saved.
import { useEffect, useId, useRef, useState } from 'react';
import type { RefChoice } from '../../core/catalog/draft';
import { exprRefs } from '../../core/flow/jinja';
import type { ContractField } from '../../core/flow/types';
import { ChipField } from '../properties/ChipField';

/**
 * A field's typing, saved as a whole (AFD-112, AFD-227): the draft, what Enter, Escape and leaving
 * do, and the inputs picked with `@` that the step does not have yet, saved with the value when
 * it still reads them.
 */
export function useCommitDraft(
  shown: string,
  opts: {
    /** Why a text cannot be saved: it is taken back instead. */
    invalid?(text: string): string | undefined;
    onCommit(text: string, inputs: Record<string, ContractField>): void;
  },
) {
  const [draft, setDraft] = useState(shown);
  const latest = useRef(draft);
  const added = useRef<Record<string, ContractField>>({});
  // The stored value changed (a save, an undo): the field shows it.
  useEffect(() => {
    latest.current = shown;
    added.current = {};
    setDraft(shown);
  }, [shown]);
  const change = (v: string) => {
    latest.current = v;
    setDraft(v);
  };
  const revert = () => {
    added.current = {};
    change(shown);
  };
  const commit = () => {
    const text = latest.current;
    if (text === shown && Object.keys(added.current).length === 0) return;
    if (opts.invalid?.(text)) {
      revert();
      return;
    }
    // Only the inputs the value still reads.
    const reads = new Set(exprRefs(text));
    const inputs = Object.fromEntries(Object.entries(added.current).filter(([n]) => reads.has(n)));
    added.current = {};
    opts.onCommit(text, inputs);
  };
  const addInput = (c: RefChoice) => {
    if (c.field) added.current = { ...added.current, [c.name]: c.field };
  };
  return { draft, change, revert, commit, addInput };
}

export function ExprField({
  label,
  value,
  choices,
  placeholder,
  problem,
  validate,
  onCommit,
}: {
  label: string;
  value: string;
  /** What the expression can read: the node's variables (and a step's own result). */
  choices: RefChoice[];
  placeholder?: string;
  /** A problem the flow check found with the stored value. */
  problem?: string;
  validate?(text: string): string | undefined;
  onCommit(text: string, inputs: Record<string, ContractField>): void;
}) {
  const id = useId();
  const d = useCommitDraft(value, { invalid: validate, onCommit });
  const error = d.draft !== value ? validate?.(d.draft) : problem;
  return (
    <div className="afd-field" data-expr-field>
      <label htmlFor={id}>{label}</label>
      <ChipField
        id={id}
        label={label}
        mode="expr"
        value={d.draft}
        onChange={d.change}
        choices={choices}
        onAddInput={d.addInput}
        onEnter={d.commit}
        onEscape={d.revert}
        onLeave={d.commit}
        placeholder={placeholder}
      />
      {error ? <div className="afd-field-error">{error}</div> : null}
    </div>
  );
}
