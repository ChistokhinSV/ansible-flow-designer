// A node's Details (AFD-43): one docked panel instead of the inspector plus a page over the canvas.
// Tabs: General, Binding (task and subflow), Inputs and outputs, Ports, Execution; Code and Run
// modes add theirs first. Fields save as you go. The binding is staged: a bar offers Save and
// Discard, and leaving it unsaved (another node, Escape, another level or mode) asks first.
import { useEffect, useRef, useState } from 'react';
import { bindingCommand, draftOf, isDirty } from '../../core/catalog/draft';
import { formatOf } from '../../core/flow/format';
import type { FlowNode } from '../../core/flow/types';
import { nodeProblems } from '../../core/view/nodeProblems';
import { run } from '../actions';
import { send } from '../bus';
import { StatusIcon } from '../canvas/StatusIcon';
import { copySelection } from '../clipboard';
import { TYPE_LABEL } from '../constants';
import { deleteSelection, useEditable } from '../editActions';
import { onTabListKeys, useDialogFocus } from '../focus';
import type { HelpTopic } from '../helpPages';
import { useModel, useNode } from '../hooks';
import { NodeCodePanel } from '../panels/DriftPanel';
import { HelpLink } from '../panels/HelpLink';
import { NodeRunPanel } from '../panels/RunPanel';
import { Implementation } from '../properties/Implementation';
import { keysOf } from '../shortcuts';
import { type Mode, type PropTab, useUi } from '../store';
import { ExecutionSection, GeneralSection, IoSection, PortsSection } from './sections';

const LABEL: Record<PropTab, string> = {
  code: 'Code',
  run: 'Run',
  general: 'General',
  binding: 'Binding',
  io: 'Inputs and outputs',
  ports: 'Ports',
  execution: 'Execution',
};

/** The tabs a node has in a mode: the mode's own first, then the design ones it supports. */
export function detailsTabs(node: FlowNode, mode: Mode): PropTab[] {
  const bindable = node.type === 'task' || node.type === 'subflow';
  const designable = node.type !== 'start' && node.type !== 'end';
  const design: PropTab[] = ['general'];
  if (bindable) design.push('binding');
  if (designable) design.push('io');
  design.push('ports');
  if (designable) design.push('execution');
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

export function Details({ id, context }: { id: string; context?: boolean }) {
  const snapshot = useUi((s) => s.snapshot);
  const mode = useUi((s) => s.mode);
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
  const [saving, setSaving] = useState(false);
  // After a save the document is the truth again: restage from the first snapshot past the save
  // (the ack can arrive before it).
  const version = snapshot?.docVersion ?? 0;
  const [restageAfter, setRestageAfter] = useState<number | null>(null);
  useEffect(() => {
    if (restageAfter !== null && version > restageAfter && node) {
      setDraft(draftOf(node));
      setRestageAfter(null);
    }
  }, [restageAfter, version, node]);
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

  if (!snapshot?.doc || !model || !entry || !node || !draft) return null;
  const tabs = detailsTabs(node, mode);
  const tab = tabs.includes(wanted) ? wanted : (tabs[0] as PropTab);
  const play = snapshot.plays?.[id];
  // AFD-44: the node's problems at the top, each opening its tab; fields show theirs inline.
  const problems = nodeProblems(snapshot.findings, id, entry.path);
  // Accepting a problem is a format 2 decision (AFD-51); open ports have their own (Accept with
  // Reason… on the port).
  const canAccept = editable && !!snapshot.doc && formatOf(snapshot.doc) >= 2;
  const tabsWithProblems = new Set<string>(problems.map((p) => p.tab));
  // Design edits everything; Code mode only the binding (AFD-45); Run mode reads.
  const readOnly = !editable || mode === 'run' || (mode === 'code' && tab !== 'binding');

  const save = async (): Promise<boolean> => {
    setSaving(true);
    const before = version;
    const ack = await run(bindingCommand(node, draft));
    setSaving(false);
    if (ack.ok) setRestageAfter(before);
    return ack.ok;
  };
  const discard = () => setDraft(draftOf(node));

  return (
    <div className="afd-details" data-details={id} data-inspector={id}>
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
            <HelpLink topic={TAB_HELP[tab]} about={`the ${LABEL[tab]} tab`} />
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
            <button
              type="button"
              className="icon"
              title="Open in Text Editor"
              aria-label="Open in Text Editor"
              onClick={() => send({ type: 'openText', path: entry.path })}
            >
              <span className="codicon codicon-go-to-file" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon"
              title={`Copy (${keysOf('copy')}): paste on a flow (${keysOf('paste')}) or in a text file`}
              aria-label="Copy node"
              onClick={() => copySelection()}
            >
              <span className="codicon codicon-copy" aria-hidden="true" />
            </button>
            {mode !== 'run' ? (
              <button
                type="button"
                className="icon"
                title="Delete node"
                aria-label="Delete node"
                disabled={!editable}
                onClick={() => void deleteSelection([id])}
              >
                <span className="codicon codicon-trash" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              className="icon"
              title={expanded ? 'Narrow the panel again' : 'Widen the panel (for the catalog docs)'}
              aria-label={expanded ? 'Collapse the panel' : 'Expand the panel'}
              aria-pressed={expanded}
              onClick={() => useUi.getState().setExpanded(!expanded)}
            >
              <span
                className={`codicon codicon-${expanded ? 'screen-normal' : 'screen-full'}`}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
      </header>
      {dirty ? (
        <div className="afd-pending" role="status" data-pending-binding={id}>
          <span>The binding is not saved.</span>
          <button type="button" className="secondary" onClick={discard}>
            Discard
          </button>
          <button type="button" disabled={saving} onClick={() => void save()} data-save-binding>
            Save Binding
          </button>
        </div>
      ) : null}
      {problems.length > 0 ? (
        <ul
          className="afd-node-problems"
          aria-label="Problems of this node"
          data-node-problems={id}
        >
          {problems.map((p) => (
            <li key={`${p.finding.code}|${p.finding.path.join('.')}|${p.finding.port ?? ''}`}>
              <button
                type="button"
                className="link"
                onClick={() => tabs.includes(p.tab) && setTab(p.tab)}
              >
                <span
                  className={`codicon codicon-${p.finding.severity === 'error' ? 'error' : 'warning'}`}
                  role="img"
                  aria-label={p.finding.severity}
                />{' '}
                {p.finding.message}
              </button>
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
          ))}
        </ul>
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
            {t === 'binding' && dirty ? <span className="afd-dirty" title="Not saved" /> : null}
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
        {tab === 'code' ? (
          <NodeCodePanel id={id} />
        ) : tab === 'run' ? (
          <NodeRunPanel id={id} />
        ) : (
          <fieldset className="afd-editable" disabled={readOnly}>
            {tab === 'binding' ? (
              <Implementation node={node} model={model} draft={draft} setDraft={setDraft} />
            ) : tab === 'io' ? (
              <IoSection node={node} />
            ) : tab === 'ports' ? (
              <PortsSection id={id} />
            ) : tab === 'execution' ? (
              <ExecutionSection node={node} problems={problems} />
            ) : (
              <GeneralSection node={node} context={context} problems={problems} />
            )}
          </fieldset>
        )}
      </div>
      {leave && dirty ? (
        <LeaveDialog title={node.title} saving={saving} save={save} discard={discard} />
      ) : null}
    </div>
  );
}

/** Leaving with a staged binding asks first (AFD-43); the safe choice has the focus. */
function LeaveDialog(props: {
  title: string;
  saving: boolean;
  save(): Promise<boolean>;
  discard(): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const trap = useDialogFocus(box);
  return (
    <div className="afd-modal-backdrop">
      <div
        ref={box}
        className="afd-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="afd-leave-title"
        data-leave-binding
        onKeyDown={trap}
      >
        <h2 id="afd-leave-title">Discard the binding change?</h2>
        <p className="muted">
          The binding of "{props.title}" has a change that is not saved yet. Leaving now drops it.
        </p>
        <div className="afd-modal-actions">
          <button
            type="button"
            className="secondary"
            // biome-ignore lint/a11y/noAutofocus: the safe choice takes the focus in this alert
            autoFocus
            onClick={() => useUi.getState().resolveLeave('stay')}
          >
            Keep Editing
          </button>
          <button
            type="button"
            className="secondary"
            data-leave-discard
            onClick={() => {
              props.discard();
              useUi.getState().resolveLeave('go');
            }}
          >
            Discard
          </button>
          <button
            type="button"
            disabled={props.saving}
            onClick={() =>
              void props.save().then((ok) => ok && useUi.getState().resolveLeave('go'))
            }
          >
            Save Binding
          </button>
        </div>
      </div>
    </div>
  );
}
