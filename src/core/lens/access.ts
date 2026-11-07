// Access lens (04 §7): with which credential, user and privilege each node acts, and which vaulted
// variables it reads. Node `credential` names apply in AWX (decision 22); locally the inventory's
// connection variables decide, read by the probe with their origin and never decrypted.

import { formatOf } from '../flow/format';
import { refsIn } from '../flow/jinja';
import type { FlowModel } from '../flow/model';
import { modelOf } from '../flow/model';
import { runtimeKind } from '../flow/status';
import type { FlowDocument, FlowNode, Ulid } from '../flow/types';
import { isWork, joinTitles, neighbours, plural, title } from './common';
import { declaredTarget } from './inventory';
import type {
  AccessVar,
  CodeFacts,
  InventoryState,
  LensChip,
  LensFinding,
  LensItem,
  LensView,
} from './types';

function vaultRefs(node: FlowNode, vaulted: Record<string, string>): string[] {
  const refs = new Set([...refsIn(node.impl?.params ?? {}), ...refsIn(node.inputs ?? {})]);
  return [...refs].filter((r) => r in vaulted).sort();
}

function single(v: AccessVar | undefined): string | undefined {
  const keys = Object.keys(v?.values ?? {});
  return keys.length === 1 ? keys[0] : undefined;
}

export function accessLens(
  doc: FlowDocument,
  inv: InventoryState | undefined,
  code?: CodeFacts,
): LensView {
  const model = modelOf(doc);
  const facts = inv?.state === 'ready' ? inv.facts : undefined;
  const targets = facts?.targets ?? inv?.targets ?? '';
  const vaulted = facts?.vaulted ?? {};
  const chips: Record<Ulid, LensChip[]> = {};
  const findings: LensFinding[] = [];
  const creds = new Map<string, Set<Ulid>>();
  const become = new Set<Ulid>();
  const vaultUse = new Map<string, Set<Ulid>>();
  const kind = runtimeKind(model);
  const awx = kind === 'awx_job' || kind === 'awx_workflow';
  // Format 2 (AFD-52): every node runs with the flow's AWX credentials, the template's.
  const flowCreds = formatOf(doc) >= 2 ? (doc.flow.runtime?.credentials ?? []).join(', ') : '';
  const credOf = (n: FlowNode): string | undefined =>
    formatOf(doc) >= 2 ? flowCreds || undefined : n.settings?.credential;

  for (const { node } of model.nodes.values()) {
    if (!isWork(node)) continue;
    const list: LensChip[] = [];
    const cred = credOf(node);
    const pattern = declaredTarget(doc, node, targets, code)?.pattern ?? targets;
    const vars = facts?.access[pattern];
    if (cred) {
      list.push({
        text: cred,
        title: awx ? 'AWX credential' : 'AWX credential (local runs use the environment)',
      });
      creds.set(cred, (creds.get(cred) ?? new Set()).add(node.id));
    } else {
      const user = single(vars?.ansible_user);
      if (user)
        list.push({
          text: `user ${user}`,
          title: vars?.ansible_user?.origins.join(', '),
          tone: 'muted',
        });
    }
    const invBecome = vars?.ansible_become?.values.true;
    if (node.settings?.become) {
      list.push({ text: 'become' });
      become.add(node.id);
    } else if (invBecome)
      list.push({
        text: 'become (inventory)',
        title: `${plural(invBecome, 'host')} get ansible_become`,
      });
    const refs = vaultRefs(node, vaulted);
    for (const r of refs) vaultUse.set(r, (vaultUse.get(r) ?? new Set()).add(node.id));
    if (refs.length > 0)
      list.push({
        text: `vault: ${refs.join(', ')}`,
        title: refs.map((r) => `${r} (${vaulted[r]})`).join('\n'),
      });
    chips[node.id] = list.slice(0, 2);
  }

  for (const { node } of model.nodes.values()) {
    if (!isWork(node)) continue;
    const near = neighbours(model, node.id).filter(isWork);
    const cred = credOf(node);
    // Neighbours that agree on one credential (at least two of them) make an odd one stand out.
    const used = near.map((n) => credOf(n)).filter((c): c is string => !!c);
    const others = [...new Set(used)];
    if (cred && used.length >= 2 && others.length === 1 && others[0] !== cred)
      findings.push({
        id: `access:credential:${node.id}`,
        lens: 'access',
        severity: 'warning',
        title: `${node.title} uses ${cred}, its neighbours use ${others[0]}`,
        detail: `${joinTitles(near.filter((n) => credOf(n)).map((n) => n.title))} run with ${others[0]}. Check that ${node.title} needs the access ${cred} gives.`,
        node: node.id,
        nodes: [node.id, ...near.map((n) => n.id)],
        fixes: [],
      });
    if (becomeStandsOut(model, node))
      findings.push({
        id: `access:become:${node.id}`,
        lens: 'access',
        severity: 'info',
        title: `${node.title} escalates privileges, unlike its neighbours`,
        detail: `${node.title} sets become; none of the nodes wired to it do. Needs root? Accept it with a reason, so others know why.`,
        node: node.id,
        nodes: [node.id],
        acceptFirst: true,
        fixes: [
          {
            label: 'Remove Become',
            command: { kind: 'updateNode', id: node.id, patch: { settings: { become: null } } },
          },
        ],
      });
  }
  if (!awx && creds.size > 0) {
    const ids = [...creds.values()].flatMap((s) => [...s]);
    findings.push({
      id: 'access:awx-only',
      lens: 'access',
      severity: 'info',
      title: 'Node credentials apply in AWX only',
      detail: `${joinTitles(ids.map((id) => title(model, id)))} name an AWX credential. Local runs use the environment's keys and the inventory's connection variables.`,
      nodes: ids,
      fixes: [],
    });
  }
  if (vaultUse.size > 0) {
    const ids = [...new Set([...vaultUse.values()].flatMap((s) => [...s]))];
    findings.push({
      id: 'access:vault',
      lens: 'access',
      severity: 'info',
      title: `${plural(ids.length, 'node')} ${ids.length === 1 ? 'reads' : 'read'} vaulted variables`,
      detail: `${[...vaultUse.keys()].join(', ')}: runs need the vault password (asked per run locally, never stored).`,
      nodes: ids,
      fixes: [],
    });
  }

  const users: LensItem[] = [];
  for (const [pattern, vars] of Object.entries(facts?.access ?? {})) {
    // One row per group or host: combined patterns (`a,b`) would count the same hosts twice.
    if (/[,:]/.test(pattern)) continue;
    for (const [value, n] of Object.entries(vars.ansible_user?.values ?? {}))
      users.push({
        key: `user:${pattern}:${value}`,
        label: value,
        value: String(n),
        detail: `${pattern} · ${vars.ansible_user?.origins.join(', ') || 'origin unknown'}`,
        nodes: [],
      });
  }
  const notes: string[] = [];
  if (!facts)
    notes.push(
      'Read the inventory (Inventory lens) to see connection users and vaulted variables.',
    );
  return {
    lens: 'access',
    chips,
    stats: [
      { label: 'credentials', value: String(creds.size) },
      { label: 'become', value: String(become.size) },
      { label: 'vaulted vars', value: String(vaultUse.size) },
    ],
    sections: [
      {
        title: 'Credentials',
        items: [...creds.entries()].map(([c, ids]) => ({
          key: `cred:${c}`,
          label: c,
          detail: [...ids].map((id) => title(model, id)).join(', '),
          nodes: [...ids],
        })),
        empty: 'No node names a credential.',
      },
      {
        title: 'Privilege escalation',
        items: [...become].map((id) => ({
          key: `become:${id}`,
          label: title(model, id),
          nodes: [id],
        })),
        empty: 'No node sets become.',
      },
      {
        title: 'Vaulted variables',
        items: Object.entries(vaulted).map(([v, origin]) => ({
          key: `vault:${v}`,
          label: v,
          detail: `${origin}${vaultUse.get(v) ? ` · ${[...(vaultUse.get(v) ?? [])].map((id) => title(model, id)).join(', ')}` : ''}`,
          nodes: [...(vaultUse.get(v) ?? [])],
        })),
        empty: facts ? 'No vaulted variables for the hosts in scope.' : 'Inventory not read.',
      },
      {
        title: 'Connection users',
        items: users,
        empty: facts ? 'No ansible_user set.' : 'Inventory not read.',
      },
    ],
    findings,
    notes,
  };
}

/**
 * The Access lens's become finding (AFD-106): the step sets become and none of the work steps wired
 * to it do. Also asked without the lens, by a step's Privilege fold.
 */
export function becomeStandsOut(model: FlowModel, node: FlowNode): boolean {
  if (!node.settings?.become || !isWork(node)) return false;
  const near = neighbours(model, node.id).filter(isWork);
  return near.length > 0 && !near.some((n) => n.settings?.become);
}
