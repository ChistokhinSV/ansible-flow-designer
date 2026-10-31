// Node properties page over the canvas (M5, mockup 11): General, Implementation, Inputs and
// outputs, Ports and Execution. The binding is staged on the Implementation tab and written by
// "Save binding" as one command (one undo step); the other tabs edit like the inspector does.
import { useEffect, useState } from 'react';
import { bindingCommand, draftOf, isDirty } from '../../core/catalog/draft';
import { registerName } from '../../core/engine/binding';
import { SLUG } from '../../core/flow/ids';
import { buildModel } from '../../core/flow/model';
import type { FlowNode, NodeSettings } from '../../core/flow/types';
import { run } from '../actions';
import { TYPE_LABEL } from '../canvas/FlowNodeView';
import { ContractEditor } from '../panels/ContractEditor';
import { CommitField } from '../panels/fields';
import { Lifecycle, PortRow, TypeFields, updatePatch } from '../panels/Inspector';
import { type PropTab, useUi } from '../store';
import { levelTrail, levelView } from '../viewModel';
import { Implementation } from './Implementation';

const TABS: { tab: PropTab; label: string }[] = [
  { tab: 'general', label: 'General' },
  { tab: 'implementation', label: 'Implementation' },
  { tab: 'io', label: 'Inputs and outputs' },
  { tab: 'ports', label: 'Ports' },
  { tab: 'execution', label: 'Execution' },
];

export function Properties({ node: id }: { node: string }) {
  const snapshot = useUi((s) => s.snapshot);
  const tab = useUi((s) => s.properties?.tab ?? 'general');
  const close = useUi((s) => s.closeProperties);
  const doc = snapshot?.doc;
  const model = doc ? buildModel(doc) : undefined;
  const entry = model?.nodes.get(id);
  const node = entry?.node;
  const bindKind = useUi((s) => s.properties?.bindKind);
  // Drift "Bind role" opens on the kind it names when nothing is bound yet.
  const [draft, setDraft] = useState(() =>
    node ? { ...draftOf(node), ...(bindKind && !node.impl ? { kind: bindKind } : {}) } : undefined,
  );
  const [saving, setSaving] = useState(false);
  // After a save the document is the truth again: restage from the first snapshot past the save
  // (the ack can arrive before it).
  const version = snapshot?.docVersion ?? 0;
  const [resyncAfter, setResyncAfter] = useState<number | null>(null);
  useEffect(() => {
    if (resyncAfter !== null && version > resyncAfter && node) {
      setDraft(draftOf(node));
      setResyncAfter(null);
    }
  }, [resyncAfter, version, node]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  if (!doc || !model || !entry || !node || !draft) return null;
  const bindable = node.type === 'task' || node.type === 'subflow';
  const dirty = bindable && isDirty(node, draft);
  const trail = levelTrail(doc, entry.level).map((l) => l.title);
  const save = async () => {
    setSaving(true);
    const before = version;
    const ack = await run(bindingCommand(node, draft));
    setSaving(false);
    if (ack.ok) setResyncAfter(before);
  };
  const cancel = () => {
    setDraft(draftOf(node));
    close();
  };
  const setTab = (t: PropTab) => useUi.setState({ properties: { node: id, tab: t } });

  return (
    <div
      className="afd-properties"
      role="dialog"
      aria-modal="true"
      aria-label={`Properties of ${node.title}`}
      data-properties={id}
    >
      <header className="afd-props-head">
        <div className="afd-props-title">
          <span className="muted">{trail.join(' / ')} /</span>
          <span className="afd-props-name">
            <strong>{node.title}</strong>
            <span className="afd-chip">
              {TYPE_LABEL[node.type]} · {node.status ?? 'draft'}
            </span>
          </span>
        </div>
        <div className="afd-props-actions">
          <button type="button" className="secondary" onClick={cancel}>
            {dirty ? 'Cancel' : 'Close'}
          </button>
          {bindable ? (
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              data-save-binding
            >
              Save binding
            </button>
          ) : null}
        </div>
      </header>
      <div className="afd-props-tabs" role="tablist" aria-label="Properties">
        {TABS.filter((t) => bindable || t.tab !== 'implementation').map((t) => (
          <button
            key={t.tab}
            type="button"
            role="tab"
            aria-selected={tab === t.tab}
            className={tab === t.tab ? 'active' : ''}
            onClick={() => setTab(t.tab)}
          >
            {t.label}
            {t.tab === 'implementation' && dirty ? (
              <span className="afd-dirty" title="Unsaved changes" />
            ) : null}
          </button>
        ))}
      </div>
      <div className="afd-props-body" role="tabpanel">
        {tab === 'implementation' && bindable ? (
          <Implementation node={node} model={model} draft={draft} setDraft={setDraft} />
        ) : tab === 'io' ? (
          <div className="afd-props-page">
            <ContractEditor
              title="Inputs"
              target={id}
              side="inputs"
              contract={node.inputs}
              withFrom
            />
            <ContractEditor
              title="Outputs"
              target={id}
              side="outputs"
              contract={node.outputs}
              withFrom
            />
          </div>
        ) : tab === 'ports' ? (
          <PortsTab id={id} />
        ) : tab === 'execution' ? (
          <Execution node={node} />
        ) : (
          <General node={node} />
        )}
      </div>
    </div>
  );
}

function General({ node }: { node: FlowNode }) {
  const patch = (p: Record<string, unknown>) => void updatePatch(node.id, p);
  const designable = node.type !== 'start' && node.type !== 'end';
  return (
    <div className="afd-props-page">
      <CommitField
        label="Title"
        value={node.title}
        onCommit={(v) => patch({ title: v })}
        validate={(v) => (v.trim() ? undefined : 'Required')}
      />
      <CommitField
        label="Key"
        value={node.key}
        mono
        onCommit={(v) => patch({ key: v })}
        validate={(v) => (SLUG.test(v) ? undefined : 'Lowercase words joined by dashes')}
      />
      {designable ? (
        <CommitField
          label="Intent"
          value={node.intent ?? ''}
          multiline
          onCommit={(v) => patch({ intent: v.trim() ? v : null })}
        />
      ) : null}
      {designable ? <Lifecycle node={node} onSet={(status) => patch({ status })} /> : null}
      <TypeFields node={node} patch={patch} />
    </div>
  );
}

function PortsTab({ id }: { id: string }) {
  const snapshot = useUi((s) => s.snapshot);
  if (!snapshot?.doc) return null;
  const model = buildModel(snapshot.doc);
  const entry = model.nodes.get(id);
  if (!entry) return null;
  const view = levelView(snapshot, {}, entry.level).nodes.find((n) => n.node.id === id);
  const edges = model.levels.get(entry.level)?.edges ?? [];
  const decisions = snapshot.doc.decisions ?? [];
  return (
    <div className="afd-props-page">
      <ul className="afd-ports">
        {view?.ports.map((p) => (
          <PortRow
            key={p.name}
            model={model}
            node={id}
            port={p}
            target={
              model.nodes.get(
                edges.find((e) => e?.from?.node === id && e.from.port === p.name)?.to.node ?? '',
              )?.node.title ?? ''
            }
            reason={decisions.find((d) => d?.node === id && d.port === p.name)?.reason}
          />
        ))}
      </ul>
    </div>
  );
}

type SettingKey = keyof NodeSettings;

const SETTINGS: {
  key: SettingKey;
  label: string;
  kind: 'text' | 'int' | 'bool' | 'list';
  help: string;
}[] = [
  {
    key: 'timeout',
    label: 'Timeout',
    kind: 'text',
    help: '30s, 15m, 1h30m: the task timeout keyword (timeout port)',
  },
  {
    key: 'retries',
    label: 'Retries',
    kind: 'int',
    help: 'Module nodes retry until the result succeeds, or until Until holds',
  },
  {
    key: 'until',
    label: 'Until',
    kind: 'text',
    help: 'Poll until this Jinja test holds',
  },
  {
    key: 'delay',
    label: 'Delay',
    kind: 'int',
    help: 'Seconds between retries (Ansible default 5)',
  },
  {
    key: 'serial',
    label: 'Serial',
    kind: 'text',
    help: 'Hosts per batch: a number or a percentage',
  },
  {
    key: 'max_fail_percentage',
    label: 'Max fail percentage',
    kind: 'int',
    help: 'Stop the flow when more hosts fail',
  },
  { key: 'become', label: 'Become', kind: 'bool', help: 'Run with privilege escalation' },
  { key: 'tags', label: 'Tags', kind: 'list', help: 'Extra play tags, comma separated' },
  {
    key: 'credential',
    label: 'Credential (AWX)',
    kind: 'text',
    help: 'AWX credential name; local runs use the environment',
  },
  {
    key: 'inventory_target',
    label: 'Inventory target',
    kind: 'text',
    help: 'Informational (decision 23)',
  },
];

function Execution({ node }: { node: FlowNode }) {
  const set = (key: SettingKey, value: unknown) =>
    void updatePatch(node.id, { settings: { [key]: value } });
  const settings = node.settings ?? {};
  return (
    <div className="afd-props-page">
      {SETTINGS.map((s) => {
        const value = settings[s.key];
        if (s.kind === 'bool')
          return (
            <label key={s.key} className="afd-check">
              <input
                type="checkbox"
                checked={value === true}
                onChange={(e) => set(s.key, e.target.checked ? true : null)}
              />
              {s.label} <span className="muted">{s.help}</span>
            </label>
          );
        return (
          <div key={s.key}>
            <CommitField
              label={`${s.label} · ${s.key === 'until' ? `${s.help}; it reads ${registerName(node)} (the result) and the inputs` : s.help}`}
              value={
                Array.isArray(value) ? value.join(', ') : value === undefined ? '' : String(value)
              }
              mono
              validate={(v) =>
                s.kind === 'int' && v.trim() && !/^[0-9]+$/.test(v.trim())
                  ? 'A whole number'
                  : undefined
              }
              onCommit={(v) => {
                const t = v.trim();
                if (!t) return set(s.key, null);
                if (s.kind === 'int') return set(s.key, Number(t));
                if (s.kind === 'list')
                  return set(
                    s.key,
                    t
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean),
                  );
                return set(s.key, /^[0-9]+$/.test(t) && s.key === 'serial' ? Number(t) : t);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
