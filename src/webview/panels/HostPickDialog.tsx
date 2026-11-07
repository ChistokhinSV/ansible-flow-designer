// Which hosts a step sends down an outcome in the scenario being edited (AFD-116): a checklist of
// the scenario's hosts, the ones forced now ticked. Save writes `force` (one edit); none removes it.
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { scenarioMenu } from '../../core/scenario/authoring';
import { byPath } from '../../core/scenario/scenarios';
import { scenarioRequest } from '../bus';
import { useDialogFocus } from '../focus';
import { useUi } from '../store';

export function HostPickDialog() {
  const pick = useUi((s) => s.hostPick);
  const close = () => useUi.getState().setHostPick(null);
  const doc = useUi((s) => s.snapshot?.doc);
  const check = useUi((s) => s.scenarioCheck);
  const menu = pick && doc && check ? scenarioMenu(doc, check, pick.scenario) : undefined;
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const box = useRef<HTMLFormElement>(null);
  const trap = useDialogFocus(box);
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts over when the dialog opens for a step and outcome
  useEffect(() => {
    setChosen(new Set(menu && pick ? menu.forced(pick.step, pick.outcome) : []));
    setTimeout(() => box.current?.querySelector<HTMLInputElement>('input')?.focus(), 0);
  }, [pick]);
  if (!pick || !menu || !doc) return null;
  const step = byPath(doc).get(pick.step);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const hosts = menu.hosts.filter((h) => chosen.has(h));
    const ack = await scenarioRequest({
      kind: 'force',
      name: pick.scenario,
      step: pick.step,
      outcome: pick.outcome,
      hosts,
    });
    if (!ack.ok) useUi.getState().setError(ack.error ?? 'The scenario did not change');
    else close();
  };
  return (
    <div className="afd-modal-backdrop">
      <form
        ref={box}
        className="afd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="afd-host-pick-title"
        data-host-pick={pick.outcome}
        onSubmit={submit}
        onKeyDown={(e) => {
          trap(e);
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          close();
        }}
      >
        <h2 id="afd-host-pick-title">
          {step?.title ?? pick.step}: {pick.title}…
        </h2>
        <p className="muted">
          In scenario <strong>{pick.scenario}</strong>, the hosts ticked here take this outcome at{' '}
          {step?.title ?? pick.step}; the rest go on as usual.
        </p>
        <fieldset className="afd-host-pick">
          <legend className="afd-sr-only">Hosts</legend>
          {menu.hosts.map((h) => (
            <label key={h} className="afd-check">
              <input
                type="checkbox"
                checked={chosen.has(h)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(h);
                  else next.delete(h);
                  setChosen(next);
                }}
              />{' '}
              {h}
            </label>
          ))}
        </fieldset>
        <div className="afd-modal-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button type="submit">Save</button>
        </div>
      </form>
    </div>
  );
}
