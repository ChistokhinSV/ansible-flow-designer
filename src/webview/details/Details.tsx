// A node's Details (AFD-43): one docked panel instead of the inspector plus a page over the canvas.
// Tabs: General, Binding (task and subflow), Inputs and outputs, Ports, Execution; Code and Run
// modes add theirs first. Fields save as you go. The binding is staged: a bar offers Save and
// Discard, and leaving it unsaved (another node, Escape, another level or mode) asks first.
import { useEffect, useRef, useState } from 'react';
import { bindingCommand, draftOf, isDirty } from '../../core/catalog/draft';
import { formatOf } from '../../core/flow/format';
import type { FlowNode } from '../../core/flow/types';
import { nodeProblems, ownWords, problemFix } from '../../core/view/nodeProblems';
import { run } from '../actions';
import { send } from '../bus';
import { StatusIcon } from '../canvas/StatusIcon';
import { copySelection } from '../clipboard';
import { TYPE_LABEL } from '../constants';
import { deleteSelection, useEditable } from '../editActions';
import { onTabListKeys } from '../focus';
import type { HelpTopic } from '../helpPages';
import { useModel, useNode } from '../hooks';
import { NodeCodePanel } from '../panels/DriftPanel';
import { HelpLink } from '../panels/HelpLink';
import { StepFindings } from '../panels/LensFinding';
import { NodeRunPanel } from '../panels/RunPanel';
import { Implementation } from '../properties/Implementation';
import { OriginHostPicker, OriginScope } from '../properties/OriginView';
import { RunHostPicker } from '../properties/RunValues';
import { keysOf } from '../shortcuts';
import { type Mode, type PropTab, useUi } from '../store';
import { BehaviorSection, GeneralSection, IoSection } from './sections';

// AFD-297: four tabs for a step: Step, Binding, Data, Behavior. Ports and Execution are one tab
// (`ports`); asking for `execution` opens it at that section.
const LABEL: Record<PropTab, string> = {
  code: 'Code',
  run: 'Run',
  general: 'Step',
  binding: 'Binding',
  io: 'Data',
  ports: 'Behavior',
  execution: 'Behavior',
};

/** The tab a request names: Execution lives in Behavior now. */
const tabOf = (t: PropTab): PropTab => (t === 'execution' ? 'ports' : t);

/** The tabs a node has in a mode: the mode's own first, then the design ones it supports. */
export function detailsTabs(node: FlowNode, mode: Mode): PropTab[] {
  const bindable = node.type === 'task' || node.type === 'subflow';
  const designable = node.type !== 'start' && node.type !== 'end';
  const design: PropTab[] = ['general'];
  if (bindable) design.push('binding');
  if (designable) design.push('io');
  design.push('ports');
  if (mode === 'code') return ['code', ...design];
  if (mode === 'run') return ['run', ...design];
  return design;
}

/** The guide page about each tab (AFD-73). */
const TAB_HELP: Record<PropTab, HelpTopic> = {
  code: 'code',
  run: 'runs',
  general: 'canvas',
  binding: 'binding',
  io: 'io',
  ports: 'patterns',
  execution: 'execution',
};

/** AFD-299: a binding change is saved this long after the last one. */
const SAVE_AFTER_MS = 700;

export function Details({ id, context }: { id: string; context?: boolean }) {
  const snapshot = useUi((s) => s.snapshot);
  const mode = useUi((s) => s.mode);
  const hasRun = useUi((s) => !!s.run);
  const wanted = useUi((s) => s.detailsTab);
  const setTab = useUi((s) => s.setDetailsTab);
  const expanded = useUi((s) => s.expanded);
  const leave = useUi((s) => s.leave);
  const bindKind = useUi((s) => (s.bindKind?.node === id ? s.bindKind.kind : undefined));
  const editable = useEditable();
  const model = useModel();
  const entry = useNode(id);
  const node = entry?.node;
  // Drift "Bind role" opens on the kind it names when nothing is bound yet.
  const [draft, setDraft] = useState(() =>
    node ? { ...draftOf(node), ...(bindKind && !node.impl ? { kind: bindKind } : {}) } : undefined,
  );
  // After a save the document is the truth again: restage from the first snapshot past the save
  // (the ack can arrive before it), unless the binding was changed again meanwhile.
  const version = snapshot?.docVersion ?? 0;
  const [restageAfter, setRestageAfter] = useState<number | null>(null);
  const savedDraft = useRef<string | null>(null);
  useEffect(() => {
    if (restageAfter !== null && version > restageAfter && node) {
      if (JSON.stringify(draft) === savedDraft.current) setDraft(draftOf(node));
      setRestageAfter(null);
    }
  }, [restageAfter, version, node, draft]);
  // Quick Add selects a new step on the ack, which can come before the snapshot that has it.
  useEffect(() => {
    if (node && !draft) setDraft(draftOf(node));
  }, [node, draft]);

  const bindable = node?.type === 'task' || node?.type === 'subflow';
  const dirty = !!node && !!draft && bindable && isDirty(node, draft);
  // The store holds back selection, level and mode changes while this binding is unsaved.
  useEffect(() => {
    useUi.getState().setPendingBinding(dirty ? id : null);
  }, [dirty, id]);
  useEffect(
    () => () => {
      if (useUi.getState().pendingBinding === id) useUi.getState().setPendingBinding(null);
    },
    [id],
  );
  // AFD-299: the binding saves as it is changed, as every other field does: a moment after the
  // last change (a value typed is one undo step, not one per key). Browsing another kind with
  // nothing chosen is not a change to save: it never unbinds the step.
  const latest = useRef({ node, draft });
  latest.current = { node, draft };
  const save = async (): Promise<boolean> => {
    const { node: n, draft: d } = latest.current;
    if (!n || !d) return true;
    const before = version;
    savedDraft.current = JSON.stringify(d);
    const ack = await run(bindingCommand(n, d));
    if (ack.ok) setRestageAfter(before);
    return ack.ok;
  };
  const savable = dirty && !!draft?.ref.trim();
  // biome-ignore lint/correctness/useExhaustiveDependencies: each change of the draft restarts the wait
  useEffect(() => {
    if (!savable) return;
    const t = setTimeout(() => void save(), SAVE_AFTER_MS);
    return () => clearTimeout(t);
  }, [savable, draft]);
  // Leaving the step (another selection, level or mode): what is left is saved first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per leave asked
  useEffect(() => {
    if (!leave || !dirty) return;
    if (!savable) {
      if (node) setDraft(draftOf(node));
      useUi.getState().resolveLeave('go');
      return;
    }
    void save().then((ok) => useUi.getState().resolveLeave(ok ? 'go' : 'stay'));
  }, [leave]);

  if (!snapshot?.doc || !model || !entry || !node || !draft) return null;
  const tabs = detailsTabs(node, mode);
  const tab = tabs.includes(tabOf(wanted)) ? tabOf(wanted) : (tabs[0] as PropTab);
  const play = snapshot.plays?.[id];
  // AFD-44: the node's problems at the top, each opening its tab; fields show theirs inline.
  const problems = nodeProblems(snapshot.findings, id, entry.path);
  // Accepting a problem is a format 2 decision (AFD-51); open ports have their own (Accept with
  // Reason… on the port).
  const canAccept = editable && !!snapshot.doc && formatOf(snapshot.doc) >= 2;
  const tabsWithProblems = new Set<string>(problems.map((p) => tabOf(p.tab)));
  const errors = problems.filter((p) => p.finding.severity === 'error').length;
  // Design edits everything; Code mode only the binding (AFD-45); Run mode reads.
  const readOnly = !editable || mode === 'run' || (mode === 'code' && tab !== 'binding');

  return (
    <div className="afd-details" data-details={id} data-inspector={id}>
      {/* AFD-96 (S3): from a step's run results back to the whole run's (round 2: P1 clicked step
        after step once the run panel was gone). */}
      {mode === 'run' && hasRun ? (
        <div className="afd-inspector-head" data-back-to-run>
          <button type="button" className="link" onClick={() => useUi.getState().select({})}>
            <span className="codicon codicon-arrow-left" aria-hidden="true" /> Run Results
          </button>
        </div>
      ) : null}
      <header className="afd-details-head">
        <div className="afd-details-name">
          <StatusIcon status={node.status ?? 'draft'} />
          <h2>{node.title}</h2>
        </div>
        <div className="afd-details-bar">
          <span className="afd-chip">
            {TYPE_LABEL[node.type]} · {node.status ?? 'draft'}
          </span>
          <div className="afd-details-actions">
            {play ? (
              <button
                type="button"
                className="icon"
                title="Peek Code: the node's play in its generated file"
                aria-label="Peek Code"
                onClick={() => send({ type: 'peekCode', node: id })}
              >
                <span className="codicon codicon-code" aria-hidden="true" />
              </button>
            ) : null}
            <HelpLink topic={TAB_HELP[tab]} about={`the ${LABEL[tab]} tab`} />
            <MoreActions
              items={[
                {
                  label: 'Open in Text Editor',
                  icon: 'go-to-file',
                  run: () => send({ type: 'openText', path: entry.path }),
                },
                {
                  label: 'Copy node',
                  text: `Copy (${keysOf('copy')})`,
                  icon: 'copy',
                  run: () => copySelection(),
                },
                {
                  label: expanded ? 'Collapse the panel' : 'Expand the panel',
                  text: expanded ? 'Narrow the panel' : 'Widen the panel',
                  icon: expanded ? 'screen-normal' : 'screen-full',
                  run: () => useUi.getState().setExpanded(!expanded),
                },
                ...(mode !== 'run'
                  ? [
                      {
                        label: 'Delete node',
                        text: 'Delete',
                        icon: 'trash',
                        danger: true,
                        disabled: !editable,
                        run: () => void deleteSelection([id]),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        </div>
      </header>
      {problems.length > 0 ? (
        // AFD-297: one line that says how many, open by itself only when one is an error.
        <details className="afd-node-problems-box" open={errors > 0}>
          <summary className={errors ? 'error' : 'warning'}>
            <span
              className={`codicon codicon-${errors ? 'error' : 'warning'}`}
              aria-hidden="true"
            />{' '}
            {problems.length === 1 ? '1 thing to look at' : `${problems.length} things to look at`}
          </summary>
          <ul
            className="afd-node-problems"
            aria-label="Problems of this node"
            data-node-problems={id}
          >
            {problems.map((p) => {
              // AFD-336: in the step's own words, with a one-click fix where one exists.
              const fix = editable && mode === 'design' ? problemFix(model, p.finding) : undefined;
              return (
                <li key={`${p.finding.code}|${p.finding.path.join('.')}|${p.finding.port ?? ''}`}>
                  <button
                    type="button"
                    className="link"
                    onClick={() => tabs.includes(tabOf(p.tab)) && setTab(p.tab)}
                  >
                    <span
                      className={`codicon codicon-${p.finding.severity === 'error' ? 'error' : 'warning'}`}
                      role="img"
                      aria-label={p.finding.severity}
                    />{' '}
                    {ownWords(p.finding, node)}
                  </button>
                  {fix ? (
                    <button
                      type="button"
                      className="link afd-fix-problem"
                      title={fix.title}
                      data-problem-fix={p.finding.code}
                      onClick={() => void run(fix.command)}
                    >
                      {fix.label}
                    </button>
                  ) : null}
                  {canAccept &&
                  p.finding.severity === 'warning' &&
                  p.finding.code !== 'open-fail-port' ? (
                    <button
                      type="button"
                      className="link afd-accept-problem"
                      title="Keep it as it is, with a reason"
                      onClick={() =>
                        useUi.getState().setAccept({
                          id: `${p.finding.code}|${p.finding.subject ?? ''}`,
                          node: id,
                          title: p.finding.message,
                          check: {
                            code: p.finding.code,
                            ...(p.finding.subject ? { subject: p.finding.subject } : {}),
                          },
                        })
                      }
                    >
                      Accept…
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
      <div className="afd-props-tabs" role="tablist" aria-label="Details" onKeyDown={onTabListKeys}>
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`afd-tab-${t}`}
            aria-selected={tab === t}
            // One tab stop for the list; the arrow keys move between tabs (AFD-47).
            tabIndex={tab === t ? 0 : -1}
            aria-controls="afd-details-panel"
            className={tab === t ? 'active' : ''}
            onClick={() => setTab(t)}
          >
            {LABEL[t]}
            {tabsWithProblems.has(t) ? (
              <span className="afd-tab-problem" title="Has problems" />
            ) : null}
          </button>
        ))}
      </div>
      <div
        className="afd-details-body"
        role="tabpanel"
        id="afd-details-panel"
        aria-labelledby={`afd-tab-${tab}`}
      >
        {/* AFD-87: the lens's findings on this step, with their fixes (round 1: W14). AFD-96 (X4):
          under the tabs, so they stay where they are. */}
        <StepFindings key={id} id={id} />
        {tab === 'code' ? (
          <NodeCodePanel id={id} />
        ) : tab === 'run' ? (
          <NodeRunPanel id={id} />
        ) : (
          <>
            {/* AFD-341: the host the run's values are for; outside the read-only fieldset. */}
            {tab === 'io' && mode === 'run' ? <RunHostPicker node={id} /> : null}
            {/* AFD-342: a read-only Details (a viewer, Code mode) has the repository's host picker
              out here too, or the disabled fieldset would disable it. */}
            {tab === 'io' && mode !== 'run' && readOnly ? <OriginHostPicker /> : null}
            <fieldset className="afd-editable" disabled={readOnly}>
              {/* AFD-339: the fields' tooltips say where this step's values come from. */}
              <OriginScope.Provider value={id}>
                {tab === 'binding' ? (
                  <Implementation node={node} model={model} draft={draft} setDraft={setDraft} />
                ) : tab === 'io' ? (
                  <IoSection node={node} />
                ) : tab === 'ports' ? (
                  <BehaviorSection
                    node={node}
                    problems={problems}
                    at={wanted === 'execution' ? 'execution' : undefined}
                  />
                ) : (
                  <GeneralSection node={node} context={context} problems={problems} />
                )}
              </OriginScope.Provider>
            </fieldset>
          </>
        )}
      </div>
    </div>
  );
}

interface MoreItem {
  /** The accessible name (what tests and screen readers say). */
  label: string;
  /** What the menu shows, when shorter than the label. */
  text?: string;
  icon: string;
  danger?: boolean;
  disabled?: boolean;
  run(): void;
}

/** AFD-297: the step's less used actions behind one button, so the header stays quiet. */
function MoreActions({ items }: { items: MoreItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <div className="afd-more" ref={box}>
      <button
        type="button"
        className="icon"
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="codicon codicon-ellipsis" aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="afd-more-menu"
          role="menu"
          aria-label="More actions"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {items.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              aria-label={i.label}
              className={i.danger ? 'danger' : undefined}
              disabled={i.disabled}
              onClick={() => {
                setOpen(false);
                i.run();
              }}
            >
              <span className={`codicon codicon-${i.icon}`} aria-hidden="true" />{' '}
              {i.text ?? i.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
