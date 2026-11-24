// AFD-82: the launch dialog's host side. A plan carries a token the host keeps: single-use, for
// one flow file and mode, ten minutes. Only Run in that dialog, with that token, starts a run without
// the input boxes and the real-run modal, and the run re-reads the inventory first: when it answers
// differently from what the dialog showed, nothing runs and the dialog shows the new facts.
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { parseFlow } from '../../core/flow/document';
import { type LaunchFacts, type LaunchPlan, launchFields, readFields } from '../../core/run/launch';
import { environmentFor } from '../env/environment';
import { inputsKey } from './inputs';
import { inventoryGroups, launchFacts, type RunDeps } from './runner';

export const TOKEN_MS = 10 * 60_000;

interface Pending {
  uri: string;
  mode: 'check' | 'real';
  expires: number;
  /** What the dialog shows now: Run checks the inventory still says so. */
  facts?: LaunchFacts;
}

const pending = new Map<string, Pending>();

function sweep(now = Date.now()) {
  for (const [token, p] of pending) if (p.expires <= now) pending.delete(token);
}

export async function planLaunch(
  document: vscode.TextDocument,
  deps: RunDeps,
  mode: 'check' | 'real',
  /** AFD-83: start the targets field with this (the Inventory view's Run Flow on This Group…). */
  prefill: { targets?: string; texts?: Record<string, string> } = {},
): Promise<{ ok: true; plan: LaunchPlan } | { ok: false; error: string; environment?: boolean }> {
  const doc = parseFlow(document.getText()).doc;
  if (!doc) return { ok: false, error: 'The flow does not parse: fix it before running' };
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) return { ok: false, error: 'Open the flow inside a workspace folder to run it' };
  const env = environmentFor(folder.uri);
  if (!env.ok) return { ok: false, error: env.error, environment: true };
  const remembered = deps.state.get<Record<string, unknown>>(inputsKey(doc.flow.id), {});
  // AFD-95 (X5): the groups first; with groups to pick from, a skeleton run's hosts start empty.
  const { groups, hosts: groupHosts } = await inventoryGroups(folder.uri, deps.probes);
  const fields = launchFields(doc, remembered, mode === 'check', groups.length === 0);
  // AFD-376: the dialog opens again (Change beside the inventory) with what was typed in it.
  if (prefill.texts)
    for (const f of fields) {
      const typed = prefill.texts[f.name];
      if (!f.secret && typeof typed === 'string') f.text = typed;
    }
  if (prefill.targets) {
    const lists = fields.filter((f) => f.type === 'host_list');
    const field = lists.find((f) => f.targets) ?? lists[0];
    if (field) field.text = prefill.targets;
  }
  const start = readFields(fields, {});
  const empty = 'error' in start && fields.find((f) => f.name === start.field);
  const found =
    'inputs' in start
      ? await launchFacts(doc, start.inputs, folder.uri, deps.probes)
      : {
          ok: false as const,
          // An empty host list with groups beside it asks for the hosts, it is no error yet.
          error:
            empty && empty.type === 'host_list' && !empty.text && groups.length
              ? 'Pick the hosts to run on: a group below, or host names'
              : start.error,
        };
  const facts = found.ok ? found.facts : undefined;
  sweep();
  const token = randomUUID();
  pending.set(token, {
    uri: document.uri.toString(),
    mode,
    expires: Date.now() + TOKEN_MS,
    facts,
  });
  return {
    ok: true,
    plan: {
      token,
      mode,
      flow: doc.flow.name,
      fields,
      groups,
      groupHosts,
      ...(facts ? { facts } : { factsError: found.ok ? undefined : found.error }),
      vault: asksVault(document, facts),
      environment: env.env.label,
      inventory:
        vscode.workspace.getConfiguration('afd', folder.uri).get<string>('run.inventory', '') ||
        // AFD-379: with none set, Ansible's own default ("the default of ansible.cfg" read as a
        // file the workspace did not have, and the confirmation then said /etc/ansible/hosts).
        (facts?.sources.length
          ? facts.sources.join(', ')
          : "Ansible's default (/etc/ansible/hosts, unless an ansible.cfg names one)"),
    },
  };
}

/** Whether the dialog asks for the vault password (`afd.run.askVaultPassword`, the inventory). */
function asksVault(document: vscode.TextDocument, facts: LaunchFacts | undefined): boolean {
  const ask = vscode.workspace
    .getConfiguration('afd', document.uri)
    .get<'auto' | 'always' | 'never'>('run.askVaultPassword', 'auto');
  return ask === 'always' || (ask === 'auto' && !!facts?.vault);
}

/**
 * The facts for the dialog's inputs as they are now; the token keeps them for Run. AFD-379: with
 * whether to ask for the vault password: a dialog that opened before it had hosts (the first of a
 * flow) knew no facts and showed no field; the run then asked in an input box.
 */
export async function checkLaunch(
  document: vscode.TextDocument,
  deps: RunDeps,
  token: string,
  inputs: Record<string, unknown>,
): Promise<{ facts?: LaunchFacts; error?: string; vault?: boolean }> {
  sweep();
  const p = pending.get(token);
  if (!p || p.uri !== document.uri.toString()) return { error: 'This dialog has expired' };
  const doc = parseFlow(document.getText()).doc;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!doc || !folder) return { error: 'The flow does not parse' };
  const found = await launchFacts(doc, inputs, folder.uri, deps.probes);
  p.facts = found.ok ? found.facts : undefined;
  return found.ok
    ? { facts: found.facts, vault: asksVault(document, found.facts) }
    : { error: found.error };
}

/** The token's launch, once: a second Run with it, another flow's or an old one gets nothing. */
export function takeLaunch(token: string, uri: vscode.Uri): Pending | undefined {
  sweep();
  const p = pending.get(token);
  pending.delete(token);
  return p && p.uri === uri.toString() ? p : undefined;
}

export function dropLaunch(token: string): void {
  pending.delete(token);
}
