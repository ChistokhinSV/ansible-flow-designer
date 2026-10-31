// Implementation tab of the properties page (mockup 11): Find a module, role or playbook in the
// environment's catalog, Understand it from its docs, Configure the binding with input chips.
// Everything here edits the staged draft; "Save binding" writes it as one command.
import { type ReactNode, useEffect, useId, useState } from 'react';
import {
  type BindingDraft,
  type BindKind,
  checklist,
  contractTypeOf,
  type FormField,
  formFields,
  type RefChoice,
  refChoices,
  stagedNode,
} from '../../core/catalog/draft';
import type { Badge, CatalogOption, SearchHit } from '../../core/catalog/types';
import { bindingTaskText, registerName } from '../../core/engine/binding';
import type { FlowModel } from '../../core/flow/model';
import type { ContractField, FlowNode } from '../../core/flow/types';
import type { CatalogDoc, PlaybookInfo, RoleInfo } from '../../core/protocol';
import { catalogRequest, type Loaded, useCatalog } from '../catalog';
import { useUi } from '../store';
import { ChipField } from './ChipField';
import { YamlField } from './YamlField';

const BADGE: Record<Badge, { text: string; tone: 'ok' | 'neutral' | 'warn' }> = {
  'check-mode': { text: 'check mode', tone: 'ok' },
  'check-mode-partial': { text: 'check mode: partial', tone: 'warn' },
  'no-check-mode': { text: 'no check mode', tone: 'warn' },
  diff: { text: 'diff', tone: 'ok' },
  'read-only': { text: 'read-only', tone: 'neutral' },
  'other-platform': { text: 'other platform', tone: 'warn' },
  deprecated: { text: 'deprecated', tone: 'warn' },
};

const KINDS: { kind: BindKind; label: string }[] = [
  { kind: 'module', label: 'Module' },
  { kind: 'role', label: 'Role' },
  { kind: 'playbook', label: 'Playbook' },
];

export interface DraftProps {
  node: FlowNode;
  model: FlowModel;
  draft: BindingDraft;
  setDraft(d: BindingDraft): void;
}

export function Implementation(props: DraftProps) {
  const { draft } = props;
  const doc = useCatalog(
    draft.kind === 'module' && draft.ref ? { op: 'doc', fqcn: draft.ref } : null,
    `doc:${draft.kind}:${draft.ref}`,
  );
  const roles = useCatalog(draft.kind === 'role' ? { op: 'roles' } : null, `roles:${draft.kind}`);
  const playbooks = useCatalog(
    draft.kind === 'playbook' ? { op: 'playbooks' } : null,
    `playbooks:${draft.kind}`,
  );
  const role = roles.data?.find((r) => r.name === draft.ref);
  const playbook = playbooks.data?.find((p) => p.path === draft.ref);
  return (
    <div className="afd-impl">
      <section className="afd-impl-find" aria-label="Find">
        <Find {...props} roles={roles} playbooks={playbooks} />
      </section>
      <section className="afd-impl-understand" aria-label="Understand">
        {draft.kind === 'module' ? (
          <ModuleDoc {...props} doc={doc.data ?? null} loading={doc.loading} error={doc.error} />
        ) : draft.kind === 'role' ? (
          <RoleDoc {...props} role={role} />
        ) : (
          <PlaybookDoc playbook={playbook} />
        )}
      </section>
      <section className="afd-impl-configure" aria-label="Configure">
        <Configure
          {...props}
          doc={doc.data ?? null}
          docLoading={doc.loading}
          role={role}
          playbook={playbook}
        />
      </section>
    </div>
  );
}

// ---- Find ---------------------------------------------------------------------------------------

function Find({
  node,
  draft,
  setDraft,
  roles,
  playbooks,
}: DraftProps & {
  roles: Loaded<RoleInfo[]>;
  playbooks: Loaded<PlaybookInfo[]>;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const status = useUi((s) => s.catalog);
  const suggestion = (node.intent || node.title).trim();
  const q = query.trim() || suggestion;
  const hits = useCatalog(
    draft.kind === 'module' && q ? { op: 'search', query: q, types: ['module'] } : null,
    `search:${draft.kind}:${q}`,
    query ? 200 : 0,
  );
  const choose = (kind: BindKind, ref: string, extra: Partial<BindingDraft> = {}) =>
    setDraft({
      ...draft,
      kind,
      ref,
      params: ref === draft.ref && kind === draft.kind ? draft.params : {},
      register: kind === 'module' ? draft.register || registerName(node) : '',
      ...extra,
    });
  const filter = query.trim().toLowerCase();
  return (
    <>
      <span className="afd-label">Bind to</span>
      <fieldset className="afd-segmented afd-kind" aria-label="Bind to">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            className={draft.kind === k.kind ? 'active' : ''}
            aria-pressed={draft.kind === k.kind}
            onClick={() => draft.kind !== k.kind && choose(k.kind, '')}
          >
            {k.label}
          </button>
        ))}
      </fieldset>
      <label htmlFor={id} className="afd-label">
        {draft.kind === 'module'
          ? 'Search modules'
          : draft.kind === 'role'
            ? 'Filter roles'
            : 'Filter playbooks'}
      </label>
      <input
        id={id}
        className="afd-input"
        value={query}
        placeholder={draft.kind === 'module' ? suggestion || 'vlan, restart service…' : ''}
        onChange={(e) => setQuery(e.target.value)}
        data-catalog-search
      />
      <div className="afd-chips">
        {status.environment ? (
          <span className="afd-chip afd-ctx">in {status.environment}</span>
        ) : null}
        {(status.platforms ?? []).map((p) => (
          <span key={p} className="afd-chip afd-ctx">
            platform: {p.split('.')[1] ?? p}
          </span>
        ))}
      </div>
      {status.state === 'loading' ? (
        <p className="muted" role="status">
          <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />{' '}
          {status.message ?? 'Loading the catalog…'}
        </p>
      ) : null}
      {draft.kind === 'module' ? (
        <>
          {!query.trim() && suggestion ? (
            <p className="muted afd-suggested">Suggested from intent: “{suggestion}”</p>
          ) : null}
          {hits.error ? <CatalogError message={hits.error} /> : null}
          {hits.data ? (
            <span className="muted">
              {hits.data.length} results · ranked by node intent, collections in use and platform
            </span>
          ) : null}
          <ul className="afd-results" aria-label="Modules">
            {(hits.data ?? []).map((h) => (
              <li key={h.fqcn}>
                <Hit
                  hit={h}
                  selected={draft.ref === h.fqcn}
                  onPick={() => choose('module', h.fqcn)}
                />
              </li>
            ))}
          </ul>
        </>
      ) : draft.kind === 'role' ? (
        <>
          {roles.error ? <CatalogError message={roles.error} /> : null}
          {roles.loading ? <p className="muted">Reading roles…</p> : null}
          {roles.data && roles.data.length === 0 ? (
            <p className="muted">No roles in this repository.</p>
          ) : null}
          <ul className="afd-results" aria-label="Roles">
            {(roles.data ?? [])
              .filter((r) => !filter || r.name.toLowerCase().includes(filter))
              .map((r) => (
                <li key={r.name}>
                  <button
                    type="button"
                    className={`afd-result${draft.ref === r.name ? ' selected' : ''}`}
                    onClick={() => choose('role', r.name)}
                  >
                    <span className="mono afd-result-name">{r.name}</span>
                    <span className="afd-result-text">
                      {r.entry_points.main?.short_description || r.path}
                    </span>
                    <span className="afd-chips">
                      <span
                        className={`afd-badge tone-${Object.keys(r.entry_points).length ? 'ok' : 'warn'}`}
                      >
                        {Object.keys(r.entry_points).length
                          ? 'argument specs'
                          : 'no argument specs'}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </>
      ) : (
        <>
          {playbooks.error ? <CatalogError message={playbooks.error} /> : null}
          {playbooks.data && playbooks.data.length === 0 ? (
            <p className="muted">No playbooks in this repository.</p>
          ) : null}
          <ul className="afd-results" aria-label="Playbooks">
            {(playbooks.data ?? [])
              .filter((p) => !filter || p.path.toLowerCase().includes(filter))
              .map((p) => (
                <li key={p.path}>
                  <button
                    type="button"
                    className={`afd-result${draft.ref === p.path ? ' selected' : ''}`}
                    onClick={() => choose('playbook', p.path)}
                  >
                    <span className="mono afd-result-name">{p.path}</span>
                    <span className="afd-result-text">
                      {p.plays
                        .map((x) => x.name || x.hosts)
                        .filter(Boolean)
                        .join(' · ') || 'no plays'}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}
    </>
  );
}

function Hit({ hit, selected, onPick }: { hit: SearchHit; selected: boolean; onPick(): void }) {
  return (
    <button
      type="button"
      className={`afd-result${selected ? ' selected' : ''}${hit.dimmed ? ' dimmed' : ''}`}
      onClick={onPick}
      data-hit={hit.fqcn}
      title={hit.match}
    >
      <span className="mono afd-result-name">{hit.fqcn}</span>
      <span className="afd-result-text">{hit.short_description}</span>
      <span className="afd-chips">
        <span className="afd-badge tone-ok">in EE</span>
        {hit.badges.map((b) => (
          <span key={b} className={`afd-badge tone-${BADGE[b].tone}`}>
            {BADGE[b].text}
          </span>
        ))}
      </span>
    </button>
  );
}

function CatalogError({ message }: { message: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="afd-catalog-error" role="alert">
      <p>{message}</p>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          catalogRequest({ op: 'rebuild' }).finally(() => setBusy(false));
        }}
      >
        Rebuild catalog
      </button>
    </div>
  );
}

// ---- Understand ---------------------------------------------------------------------------------

const PARAMS_SHOWN = 6;

function docsUrl(fqcn: string): string | undefined {
  const [ns, coll, name] = fqcn.split('.');
  if (!ns || !coll || !name) return undefined;
  return `https://docs.ansible.com/ansible/latest/collections/${ns}/${coll}/${name}_module.html`;
}

function ModuleDoc({
  draft,
  setDraft,
  node,
  doc,
  loading,
  error,
}: DraftProps & { doc: CatalogDoc | null; loading: boolean; error?: string }) {
  const [all, setAll] = useState(false);
  if (!draft.ref)
    return (
      <p className="muted afd-empty">
        Choose a module to see what it does and how to configure it.
      </p>
    );
  if (error) return <CatalogError message={error} />;
  if (!doc)
    return (
      <p className="muted">
        {loading ? 'Reading the docs…' : `${draft.ref} is not in this environment.`}
      </p>
    );
  const options = Object.entries(doc.options ?? {});
  const shown = all ? options : options.slice(0, PARAMS_SHOWN);
  const url = docsUrl(doc.fqcn);
  const outputs = stagedNode(node, draft).outputs ?? {};
  const toggleReturn = (name: string, type: ContractField['type']) => {
    const from = `impl.register.${name}`;
    const on = outputs[name]?.from === from;
    const field: ContractField | null = on ? null : { type, from };
    const next = { ...draft.outputs };
    if (field === null && !node.outputs?.[name]) delete next[name];
    else next[name] = field;
    setDraft({ ...draft, outputs: next });
  };
  return (
    <div className="afd-doc" data-doc={doc.fqcn}>
      <h3 className="mono">{doc.fqcn}</h3>
      <p>{doc.short_description}</p>
      <div className="afd-chips">
        <span className="afd-badge tone-neutral">
          {doc.collection} {doc.collection_version ?? ''}
        </span>
        <span className="afd-badge tone-ok">in your EE</span>
        {doc.attributes?.check_mode?.support ? (
          <span
            className={`afd-badge tone-${doc.attributes.check_mode.support === 'full' ? 'ok' : 'warn'}`}
          >
            check mode: {doc.attributes.check_mode.support}
          </span>
        ) : null}
        {doc.attributes?.diff_mode?.support ? (
          <span className="afd-badge tone-neutral">
            diff mode: {doc.attributes.diff_mode.support}
          </span>
        ) : null}
        {doc.deprecated ? <span className="afd-badge tone-warn">deprecated</span> : null}
        {url ? (
          <a href={url} className="afd-docs-link">
            Full docs ↗
          </a>
        ) : null}
      </div>
      {doc.description ? <p className="afd-doc-text">{doc.description.split('\n')[0]}</p> : null}
      <table className="afd-params">
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Type</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {shown.map(([name, o]) => (
            <tr key={name}>
              <td className="mono">
                {name}
                {o.required ? <abbr title="required"> *</abbr> : null}
              </td>
              <td className="muted">{o.type}</td>
              <td>
                {o.description.split('\n')[0]}
                <OptionFacts option={o} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {options.length > PARAMS_SHOWN ? (
        <button type="button" className="link" onClick={() => setAll(!all)}>
          {all ? 'Show fewer parameters' : `Show ${options.length - PARAMS_SHOWN} more parameters`}
        </button>
      ) : null}
      {doc.returns && Object.keys(doc.returns).length > 0 ? (
        <>
          <h4>Returns · usable as node outputs</h4>
          <div className="afd-chips">
            {Object.entries(doc.returns).map(([name, r]) => {
              const on = outputs[name]?.from === `impl.register.${name}`;
              return (
                <button
                  key={name}
                  type="button"
                  className={`chip-button mono${on ? ' active' : ''}`}
                  aria-pressed={on}
                  title={`${r.description}${on ? ' (node output)' : ' · add as node output'}`}
                  onClick={() => toggleReturn(name, contractTypeOf(r))}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
      {doc.examples ? (
        <>
          <h4>Example from docs</h4>
          <pre className="afd-code">{doc.examples.split('\n\n')[0]?.trim()}</pre>
        </>
      ) : null}
    </div>
  );
}

function OptionFacts({ option }: { option: CatalogOption }) {
  const facts: string[] = [];
  if (option.choices?.length) facts.push(option.choices.map(String).join(' · '));
  if (option.default !== undefined && option.default !== null)
    facts.push(`default ${String(option.default)}`);
  if (option.aliases?.length) facts.push(`alias: ${option.aliases.join(', ')}`);
  return facts.length > 0 ? <span className="muted afd-facts"> {facts.join(', ')}</span> : null;
}

function RoleDoc({ draft, setDraft, role }: DraftProps & { role?: RoleInfo }) {
  if (!draft.ref) return <p className="muted afd-empty">Choose a role from this repository.</p>;
  if (!role) return <p className="muted">Reading {draft.ref}…</p>;
  const entries = Object.keys(role.entry_points);
  const entry = String(draft.params.tasks_from ?? 'main');
  const spec = role.entry_points[entry];
  return (
    <div className="afd-doc" data-doc={role.name}>
      <h3 className="mono">{role.name}</h3>
      <p className="muted mono">{role.path}</p>
      {entries.length > 1 || role.tasks.length > 1 ? (
        <div className="afd-field">
          <label htmlFor="afd-role-entry">Entry point (tasks_from)</label>
          <select
            id="afd-role-entry"
            value={entry}
            onChange={(e) => {
              const params = { ...draft.params };
              if (e.target.value === 'main') delete params.tasks_from;
              else params.tasks_from = e.target.value;
              setDraft({ ...draft, params });
            }}
          >
            {[...new Set(['main', ...entries, ...role.tasks])].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {spec ? (
        <>
          <p>{spec.short_description}</p>
          {spec.description ? (
            <p className="afd-doc-text">{spec.description.split('\n')[0]}</p>
          ) : null}
          <table className="afd-params">
            <tbody>
              {Object.entries(spec.options).map(([name, o]) => (
                <tr key={name}>
                  <td className="mono">
                    {name}
                    {o.required ? <abbr title="required"> *</abbr> : null}
                  </td>
                  <td className="muted">{o.type}</td>
                  <td>
                    {o.description.split('\n')[0]}
                    <OptionFacts option={o} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="muted">
          This entry point has no argument spec (meta/argument_specs.yml): its variables are
          free-form.
        </p>
      )}
    </div>
  );
}

function PlaybookDoc({ playbook }: { playbook?: PlaybookInfo }) {
  if (!playbook) return <p className="muted afd-empty">Choose a playbook from this repository.</p>;
  return (
    <div className="afd-doc" data-doc={playbook.path}>
      <h3 className="mono">{playbook.path}</h3>
      <p>
        The node imports this playbook with <span className="mono">afd_hosts</span> set to the hosts
        arriving here; hosts still running afterwards leave through ok_hosts. Failures inside it
        stop those hosts.
      </p>
      <ul className="afd-plays">
        {playbook.plays.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: plays have no identity besides order.
          <li key={i}>
            {p.name ?? 'unnamed play'} <span className="muted mono">hosts: {p.hosts ?? '?'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Configure ----------------------------------------------------------------------------------

function Configure({
  node,
  model,
  draft,
  setDraft,
  doc,
  docLoading,
  role,
  playbook,
}: DraftProps & {
  doc: CatalogDoc | null;
  docLoading?: boolean;
  role?: RoleInfo;
  playbook?: PlaybookInfo;
}) {
  const staged = stagedNode(node, draft);
  const choices = refChoices(model, staged);
  // Inserting a chip stages an input and changes a value in one gesture: both see the latest.
  const latest = { current: draft };
  const update = (d: BindingDraft) => {
    latest.current = d;
    setDraft(d);
  };
  const addInput = (c: RefChoice) => {
    if (c.field)
      update({ ...latest.current, inputs: { ...latest.current.inputs, [c.name]: c.field } });
  };
  const setParam = (name: string, value: unknown) => {
    const params = { ...latest.current.params };
    if (value === undefined) delete params[name];
    else params[name] = value;
    update({ ...latest.current, params });
  };
  const entry = String(draft.params.tasks_from ?? 'main');
  const options =
    draft.kind === 'module'
      ? doc?.options
      : draft.kind === 'role'
        ? role?.entry_points[entry]?.options
        : undefined;
  const { shown, more } = formFields(options, draft.params);
  const [extra, setExtra] = useState<string[]>([]);
  const visible = [...shown, ...more.filter((f) => extra.includes(f.name))];
  const hidden = more.filter((f) => !extra.includes(f.name));
  const known = new Set(Object.keys(options ?? {}));
  const free = Object.keys(draft.params).filter((k) => !known.has(k) && k !== 'tasks_from');
  const impl = staged.impl;
  const items = checklist(model, staged, {
    plugin: doc,
    roleSpec: !!role?.entry_points[entry],
    playbookTargets: playbook?.plays.some((p) => (p.hosts ?? '').includes('afd_hosts')),
  });
  if (!draft.ref)
    return <p className="muted afd-empty">Configure appears once something is chosen.</p>;
  if (draft.kind === 'module' && !doc && docLoading)
    return <p className="muted">Reading the docs…</p>;
  const fieldProps = { choices, onAddInput: addInput };
  return (
    <div className="afd-configure">
      {visible.map((f) => (
        <ParamField
          key={f.name}
          field={f}
          value={draft.params[f.name]}
          onChange={(v) => setParam(f.name, v)}
          {...fieldProps}
        />
      ))}
      {hidden.length > 0 ? (
        <div className="afd-field">
          <label htmlFor="afd-add-param">More parameters</label>
          <select
            id="afd-add-param"
            value=""
            onChange={(e) => e.target.value && setExtra([...extra, e.target.value])}
          >
            <option value="">Add a parameter…</option>
            {hidden.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {draft.kind !== 'module' || !options ? (
        <FreeVars
          names={free}
          params={draft.params}
          onChange={setParam}
          label={draft.kind === 'playbook' ? 'Extra vars for the playbook' : 'Variables'}
          {...fieldProps}
        />
      ) : null}
      {draft.kind === 'module' ? <Register node={node} draft={draft} setDraft={setDraft} /> : null}
      <ul className="afd-checklist" aria-label="Checks">
        {items.map((i) => (
          <li key={i.text} className={`check-${i.state}`}>
            <span
              className={`codicon codicon-${i.state === 'ok' ? 'check' : i.state === 'warn' ? 'warning' : 'circle-large-outline'}`}
              aria-hidden="true"
            />{' '}
            {i.text}
          </li>
        ))}
      </ul>
      {impl ? (
        <>
          <h4>Generated task</h4>
          <pre className="afd-code" data-binding-preview>
            {bindingTaskText(staged, impl)}
          </pre>
        </>
      ) : null}
    </div>
  );
}

function Register({ node, draft, setDraft }: Omit<DraftProps, 'model'>) {
  const id = useId();
  const outputs = stagedNode(node, draft).outputs ?? {};
  const exposed = outputs[draft.register]?.from === 'impl.register';
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.register);
  const expose = (on: boolean, name = draft.register) => {
    const next = { ...draft.outputs };
    if (on) next[name] = { type: 'dict', from: 'impl.register' };
    else if (node.outputs?.[name]) next[name] = null;
    else delete next[name];
    return next;
  };
  return (
    <div className="afd-field afd-register">
      <label htmlFor={id}>Register result as</label>
      <input
        id={id}
        className={`afd-input mono${valid ? '' : ' invalid'}`}
        value={draft.register}
        onChange={(e) => {
          const name = e.target.value;
          // An exposed result moves with its name.
          let outputs = draft.outputs;
          if (exposed) {
            outputs = expose(false);
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
              outputs = { ...outputs, [name]: { type: 'dict', from: 'impl.register' } };
          }
          setDraft({ ...draft, register: name, outputs });
        }}
      />
      <label className="afd-check">
        <input
          type="checkbox"
          checked={exposed}
          disabled={!valid}
          onChange={(e) => setDraft({ ...draft, outputs: expose(e.target.checked) })}
        />
        Expose as node output
      </label>
    </div>
  );
}

interface FieldChoices {
  choices: RefChoice[];
  onAddInput(c: RefChoice): void;
}

function ParamField({
  field,
  value,
  onChange,
  choices,
  onAddInput,
}: FieldChoices & { field: FormField; value: unknown; onChange(v: unknown): void }) {
  const id = useId();
  const o = field.option;
  const label = (
    <label htmlFor={id}>
      <span className="mono">{field.name}</span>
      {field.required ? <abbr title="required"> *</abbr> : null}
    </label>
  );
  const help = <span className="afd-help">{o.description.split('\n')[0]}</span>;
  const chipProps = { choices, onAddInput };
  let control: ReactNode;
  switch (field.control) {
    case 'bool':
      control = (
        <select
          id={id}
          value={value === true ? 'true' : value === false ? 'false' : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'true')}
        >
          <option value="">
            {o.default !== undefined ? `default (${String(o.default)})` : 'not set'}
          </option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
      break;
    case 'choice':
      control = (
        <select
          id={id}
          value={value === undefined ? '' : String(value)}
          onChange={(e) =>
            onChange(
              e.target.value === ''
                ? undefined
                : (o.choices ?? []).find((c) => String(c) === e.target.value),
            )
          }
        >
          <option value="">
            {o.default !== undefined ? `default (${String(o.default)})` : 'not set'}
          </option>
          {(o.choices ?? []).map((c) => (
            <option key={String(c)} value={String(c)}>
              {String(c)}
            </option>
          ))}
        </select>
      );
      break;
    case 'list':
      control = (
        <ListField
          id={id}
          name={field.name}
          value={
            Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)]
          }
          onChange={(items) => onChange(items.length > 0 ? items : undefined)}
          {...chipProps}
        />
      );
      break;
    case 'yaml':
      control = <YamlField id={id} value={value} onChange={onChange} />;
      break;
    default:
      control = (
        <ChipField
          id={id}
          label={field.name}
          value={value === undefined ? '' : String(value)}
          placeholder={o.default !== undefined ? `default ${String(o.default)}` : undefined}
          onChange={(v) =>
            onChange(
              v === ''
                ? undefined
                : field.control === 'number' && /^-?[0-9]+(\.[0-9]+)?$/.test(v)
                  ? Number(v)
                  : v,
            )
          }
          {...chipProps}
        />
      );
  }
  return (
    <div className="afd-field" data-param={field.name}>
      {label}
      {control}
      {help}
    </div>
  );
}

function ListField({
  id,
  name,
  value,
  onChange,
  choices,
  onAddInput,
}: FieldChoices & { id: string; name: string; value: string[]; onChange(v: string[]): void }) {
  // Rows keep empty lines being typed; the value has none.
  const [rows, setRows] = useState<string[]>(value.length > 0 ? value : ['']);
  const key = value.join('\u0000');
  useEffect(() => {
    setRows((r) =>
      r.filter((x) => x !== '').join('\u0000') === key ? r : key ? key.split('\u0000') : [''],
    );
  }, [key]);
  const change = (next: string[]) => {
    setRows(next.length > 0 ? next : ['']);
    onChange(next.filter((r) => r !== ''));
  };
  return (
    <div className="afd-list" id={id}>
      {rows.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional.
        <div key={i} className="afd-list-row">
          <ChipField
            id={`${id}-${i}`}
            label={`${name} ${i + 1}`}
            value={item}
            onChange={(v) => change(rows.map((r, j) => (j === i ? v : r)))}
            choices={choices}
            onAddInput={onAddInput}
          />
          {rows.length > 1 ? (
            <button
              type="button"
              className="icon"
              aria-label={`Remove ${name} ${i + 1}`}
              onClick={() => change(rows.filter((_, j) => j !== i))}
            >
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ))}
      <button type="button" className="link" onClick={() => setRows([...rows, ''])}>
        Add line
      </button>
    </div>
  );
}

/** Variables for roles without argument specs and extra vars for playbooks (free-form). */
function FreeVars({
  names,
  params,
  onChange,
  label,
  choices,
  onAddInput,
}: FieldChoices & {
  names: string[];
  params: Record<string, unknown>;
  onChange(name: string, value: unknown): void;
  label: string;
}) {
  const [name, setName] = useState('');
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !(name in params);
  return (
    <fieldset className="afd-fieldset afd-freevars">
      <legend>{label}</legend>
      {names.map((n) => (
        <div key={n} className="afd-list-row" data-param={n}>
          <span className="mono afd-freevar-name">{n}</span>
          <ChipField
            id={`afd-var-${n}`}
            label={n}
            value={
              typeof params[n] === 'string' ? (params[n] as string) : JSON.stringify(params[n])
            }
            onChange={(v) => onChange(n, v)}
            choices={choices}
            onAddInput={onAddInput}
          />
          <button
            type="button"
            className="icon"
            aria-label={`Remove ${n}`}
            onClick={() => onChange(n, undefined)}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
      ))}
      <div className="afd-list-row">
        <input
          className="afd-input mono"
          aria-label="New variable name"
          placeholder="variable_name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          className="secondary"
          disabled={!valid}
          onClick={() => {
            onChange(name, '');
            setName('');
          }}
        >
          Add
        </button>
      </div>
    </fieldset>
  );
}
