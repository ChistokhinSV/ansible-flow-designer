// The launch dialog (AFD-82, wave 8 group B): every input of the run with what it reads as, the
// hosts it will touch and Run, in one place over the canvas, instead of an input box per input and
// a modal (round 1: P4, P8; walkthrough W6, W9, W10). Secret inputs and the vault password live in
// this component's state only: never in the store, the saved state or what `inspect` reports.
import { useEffect, useId, useRef, useState } from 'react';
import {
  checkInputs,
  type LaunchField,
  type LaunchPlan,
  parsedPreview,
  readFields,
  realRunLines,
  realRunQuestion,
} from '../../core/run/launch';
import { send } from '../bus';
import { useDialogFocus } from '../focus';
import { useUi } from '../store';

const TYPE_HINT: Record<string, string> = {
  host_list: 'hosts or groups, comma-separated',
  list: 'items separated by commas, or a JSON list',
  dict: 'key: value lines (YAML) or JSON',
  integer: 'a whole number',
  boolean: 'true or false',
};

export function LaunchDialog() {
  const plan = useUi((s) => s.launch);
  // A new plan (opened again, facts changed at Run) starts its fields afresh.
  return plan ? <Dialog key={plan.token} plan={plan} /> : null;
}

function Dialog({ plan }: { plan: LaunchPlan }) {
  const notice = useUi((s) => s.launchNotice);
  const box = useRef<HTMLDivElement>(null);
  const trap = useDialogFocus(box);
  const title = useId();
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(plan.fields.map((f) => [f.name, f.text])),
  );
  const [vault, setVault] = useState('');
  const [problem, setProblem] = useState<{ field: string; text: string } | null>(null);
  const real = plan.mode === 'real';

  // The host counts the hosts again when the targets change (secrets do not pick hosts).
  const targets = plan.fields
    .filter((f) => f.type === 'host_list')
    .map((f) => texts[f.name] ?? '')
    .join('|');
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `targets` stands for the host lists.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => {
      // AFD-91: whatever the other fields hold; a host list that does not read says so now,
      // instead of what the dialog said when it opened (round 2: S5).
      const r = checkInputs(
        plan.fields.filter((f) => !f.secret),
        texts,
      );
      if ('inputs' in r) send({ type: 'launchCheck', token: plan.token, inputs: r.inputs });
      else useUi.getState().setLaunchFacts(plan.token, undefined, r.error);
    }, 400);
    return () => clearTimeout(t);
  }, [targets]);

  const close = () => {
    send({ type: 'launchCancel', token: plan.token });
    useUi.getState().setLaunch(null);
  };
  const submit = () => {
    const r = readFields(plan.fields, texts);
    if ('error' in r) {
      setProblem({ field: r.field, text: r.error });
      document.getElementById(`afd-launch-${r.field}`)?.focus();
      return;
    }
    if (plan.vault && !vault) {
      setProblem({ field: '__vault', text: 'The vault password is needed for this run' });
      document.getElementById('afd-launch-__vault')?.focus();
      return;
    }
    // The canvas switches to Run mode once the run starts (AFD-81).
    useUi.getState().setRunAsked(true);
    send({
      type: 'launchRun',
      token: plan.token,
      inputs: r.inputs,
      ...(plan.vault ? { vaultPassword: vault } : {}),
    });
    setVault('');
    useUi.getState().setLaunch(null);
  };
  const runLabel = real ? 'Run for Real' : 'Run as Skeleton';
  return (
    <div className="afd-modal-backdrop">
      <div
        ref={box}
        className={`afd-modal afd-launch${real ? ' real' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        data-launch={plan.mode}
        onKeyDown={(e) => {
          trap(e);
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
      >
        <h2 id={title}>
          {runLabel}: {plan.flow}
        </h2>
        <p className="muted">
          {real
            ? 'Not check mode: bound steps change the devices.'
            : 'Check mode: bound steps report what they would change, and change nothing.'}{' '}
          In {plan.environment}.
        </p>
        {notice ? (
          <p className="afd-launch-notice" role="alert">
            {notice}
          </p>
        ) : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {plan.fields.length === 0 ? <p className="muted">This flow has no inputs.</p> : null}
          {plan.fields.map((f) => (
            <Field
              key={f.name}
              field={f}
              text={texts[f.name] ?? ''}
              groups={f.type === 'host_list' ? plan.groups : []}
              problem={problem?.field === f.name ? problem.text : undefined}
              onChange={(text) => {
                setTexts((t) => ({ ...t, [f.name]: text }));
                if (problem?.field === f.name) setProblem(null);
              }}
            />
          ))}
          {plan.vault ? (
            <div className="afd-field">
              <label htmlFor="afd-launch-__vault">Vault password</label>
              <input
                id="afd-launch-__vault"
                className="afd-input"
                type="password"
                autoComplete="off"
                value={vault}
                aria-invalid={problem?.field === '__vault'}
                onChange={(e) => setVault(e.target.value)}
              />
              <span className="afd-help">
                {problem?.field === '__vault'
                  ? problem.text
                  : 'For this run only; never stored or logged.'}
              </span>
            </div>
          ) : null}
          <Facts plan={plan} />
          <div className="afd-modal-actions">
            <button type="button" className="secondary" onClick={close}>
              Cancel
            </button>
            <button type="submit" disabled={!!plan.factsError} data-launch-run>
              {runLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  field,
  text,
  groups,
  problem,
  onChange,
}: {
  field: LaunchField;
  text: string;
  groups: string[];
  problem?: string;
  onChange(text: string): void;
}) {
  const id = `afd-launch-${field.name}`;
  const type = field.type ?? 'string';
  const hint = TYPE_HINT[type];
  const preview = field.type === 'list' || field.type === 'dict' ? parsedPreview(type, text) : '';
  const words = text.split(/[,\s]+/).filter(Boolean);
  return (
    <div className="afd-field" data-launch-field={field.name}>
      <label htmlFor={id}>
        <span className="mono">{field.name}</span> <span className="muted">{type}</span>
        {field.required ? <abbr title="required"> *</abbr> : null}
      </label>
      {field.type === 'dict' ? (
        <textarea
          id={id}
          className="afd-input mono"
          rows={3}
          value={text}
          aria-invalid={!!problem}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className="afd-input"
          type={field.secret ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          value={text}
          placeholder={hint}
          aria-invalid={!!problem}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {groups.length > 0 ? (
        <fieldset className="afd-chips afd-launch-groups">
          <legend className="afd-sr-only">Inventory groups for {field.name}</legend>
          {groups.slice(0, 12).map((g) => (
            <button
              key={g}
              type="button"
              className={`chip-button mono${words.includes(g) ? ' active' : ''}`}
              aria-pressed={words.includes(g)}
              onClick={() =>
                onChange(
                  words.includes(g)
                    ? words.filter((w) => w !== g).join(', ')
                    : [...words, g].join(', '),
                )
              }
            >
              {g}
            </button>
          ))}
        </fieldset>
      ) : null}
      <span className={`afd-help${problem ? ' tone-warn' : ''}`}>
        {problem ??
          (field.secret
            ? 'Typed hidden; not remembered.'
            : preview || (hint ? `${hint[0]?.toUpperCase()}${hint.slice(1)}` : ''))}
      </span>
    </div>
  );
}

/** What the run will touch, as the inventory says now; a real run's confirmation, in words. */
function Facts({ plan }: { plan: LaunchPlan }) {
  if (plan.factsError)
    return (
      <p className="afd-launch-facts tone-warn" role="status" data-launch-facts="error">
        {plan.factsError}
      </p>
    );
  const f = plan.facts;
  if (!f) return null;
  const lines = realRunLines(f);
  return (
    <div
      className="afd-launch-facts"
      role="status"
      data-launch-facts={plan.mode}
      data-launch-hosts={f.count}
    >
      {plan.mode === 'real' ? <strong>{realRunQuestion(plan.flow, f)}</strong> : null}
      <ul>
        {(plan.mode === 'real' ? lines.slice(1) : lines.slice(1, -2)).map((l) => (
          <li key={l} className={l.startsWith('Production-looking') ? 'tone-warn' : ''}>
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}
