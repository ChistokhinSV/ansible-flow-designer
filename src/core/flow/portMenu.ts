// What clicking a port offers (04 §3, mockup 07): suggestions for an open port by its kind, edit
// actions for a connected one. Pure, so the canvas menu and the inspector list the same items.
import type { FlowModel } from './model';
import { findRollback, isRollback, PATTERNS, type PatternId, patternFits } from './patterns';
import { isFailPort, legalPorts, portDirection } from './ports';
import type { FlowNode, PortRef, Ulid } from './types';

export type PortMenuItem =
  | { kind: 'pattern'; label: string; hint: string; pattern: PatternId }
  | { kind: 'quickAdd'; label: string; title?: string }
  | { kind: 'insert'; label: string; edge: Ulid }
  | { kind: 'pick'; label: string; mode: 'to' | 'from' | 'rewire'; edge?: Ulid }
  | { kind: 'disconnect'; label: string; edge: Ulid }
  | { kind: 'decide'; label: string }
  | { kind: 'reopen'; label: string }
  | { kind: 'enable'; label: string }
  | { kind: 'disable'; label: string }
  /** Shown disabled: arrives in a later milestone. */
  | { kind: 'later'; label: string; hint: string };

export interface PortMenu {
  ref: PortRef;
  node: FlowNode;
  /** Port is a default one or enabled in `ports:`. */
  enabled: boolean;
  connected: boolean;
  decided: boolean;
  items: PortMenuItem[];
}

const pattern = (id: PatternId, label = PATTERNS[id].label): PortMenuItem => ({
  kind: 'pattern',
  label,
  hint: PATTERNS[id].hint,
  pattern: id,
});

/** Labels per port kind (mockup 07). */
const RETRY_LABEL: Record<string, string> = {
  failed_hosts: 'Retry with Backoff',
  unreachable: 'Retry Later',
  timeout: 'Retry',
};

function failSuggestions(model: FlowModel, node: FlowNode, port: string, level: string) {
  const items: PortMenuItem[] = [];
  const fits = (id: PatternId) => patternFits(id, node, port);
  if (fits('rollback')) {
    const lvl = model.levels.get(level);
    const existing = lvl ? findRollback(lvl, node.id) : undefined;
    if (existing) items.push(pattern('rollback', `${existing.title} (existing)`));
    else if (!isRollback(node)) items.push(pattern('rollback'));
  }
  if (fits('notify-stop'))
    items.push(
      pattern('notify-stop', port === 'rejected' ? 'Notify requester and stop' : undefined),
    );
  if (fits('exclude')) items.push(pattern('exclude'));
  if (fits('retry')) items.push(pattern('retry', RETRY_LABEL[port]));
  if (fits('escalate')) items.push(pattern('escalate'));
  if (fits('stop')) items.push(pattern('stop'));
  return items;
}

function openOutputSuggestions(node: FlowNode, port: string): PortMenuItem[] {
  switch (port) {
    case 'unchanged':
      return [
        pattern('done', 'Skip to Done'),
        { kind: 'pick', label: 'Skip to Another Node…', mode: 'to' },
      ];
    case 'always':
      return [
        { kind: 'quickAdd', label: 'Cleanup Task', title: 'Cleanup' },
        pattern('report'),
        { kind: 'pick', label: 'Connect to Another Node…', mode: 'to' },
      ];
    case 'cancelled':
      return [
        { kind: 'quickAdd', label: 'Add Next Node' },
        { kind: 'pick', label: 'Connect to Another Node…', mode: 'to' },
      ];
    default: {
      const items: PortMenuItem[] = [{ kind: 'quickAdd', label: 'Add Next Node' }];
      if (patternFits('done', node, port))
        items.push(pattern('done', port === 'false' ? 'Skip to Done' : 'Connect to Done'));
      items.push({ kind: 'pick', label: 'Connect to Another Node…', mode: 'to' });
      return items;
    }
  }
}

export function portMenu(model: FlowModel, ref: PortRef): PortMenu | undefined {
  const entry = model.nodes.get(ref.node);
  if (!entry) return undefined;
  const { node, level } = entry;
  const legal = legalPorts(node).find((p) => p.name === ref.port);
  if (!legal) return undefined;
  const edges = model.levels.get(level)?.edges ?? [];
  const decided = (model.doc.decisions ?? []).some(
    (d) => d?.node === ref.node && d.port === ref.port,
  );
  const items: PortMenuItem[] = [];

  if (portDirection(ref.port) === 'in') {
    const incoming = edges.filter((e) => e?.to?.node === ref.node && e.to.port === ref.port);
    if (ref.port === 'undo') {
      items.push({
        kind: 'later',
        label: 'Bind Undo Task',
        hint: 'Not supported: wire rollback steps from the failure port instead',
      });
    } else {
      items.push({ kind: 'pick', label: 'Connect from Another Node…', mode: 'from' });
    }
    for (const e of incoming) {
      const from = model.nodes.get(e.from.node)?.node;
      items.push({
        kind: 'disconnect',
        label: `Disconnect from ${from?.title ?? e.from.node} · ${e.from.port}`,
        edge: e.id,
      });
    }
    if (!legal.enabled) items.unshift({ kind: 'enable', label: 'Enable Port' });
    else if (legal.optional && incoming.length === 0)
      items.push({ kind: 'disable', label: 'Remove Port' });
    return { ref, node, enabled: legal.enabled, connected: incoming.length > 0, decided, items };
  }

  const out = edges.find((e) => e?.from?.node === ref.node && e.from.port === ref.port);
  if (out) {
    items.push(
      { kind: 'insert', label: 'Insert Node on This Wire', edge: out.id },
      { kind: 'pick', label: 'Rewire to Another Node…', mode: 'rewire', edge: out.id },
      { kind: 'disconnect', label: 'Disconnect', edge: out.id },
    );
    return { ref, node, enabled: true, connected: true, decided, items };
  }

  if (isFailPort(ref.port)) {
    items.push(...failSuggestions(model, node, ref.port, level));
    items.push({ kind: 'pick', label: 'Connect to Another Node…', mode: 'to' });
    if (decided) {
      items.push({ kind: 'decide', label: 'Edit Reason…' }, { kind: 'reopen', label: 'Reopen' });
    } else if (legal.enabled) {
      items.push({ kind: 'decide', label: 'Accept with Reason…' });
    }
  } else {
    items.push(...openOutputSuggestions(node, ref.port));
  }
  if (!legal.enabled) items.unshift({ kind: 'enable', label: 'Enable Port' });
  else if (legal.optional && !decided) items.push({ kind: 'disable', label: 'Remove Port' });
  return { ref, node, enabled: legal.enabled, connected: false, decided, items };
}

/** Output a node continues on when another node's input is wired from it ("Connect from…"). */
export function freeOutput(model: FlowModel, nodeId: Ulid): string | undefined {
  const entry = model.nodes.get(nodeId);
  if (!entry) return undefined;
  const edges = model.levels.get(entry.level)?.edges ?? [];
  const wired = (p: string) => edges.some((e) => e?.from?.node === nodeId && e.from.port === p);
  const outs = legalPorts(entry.node).filter(
    (p) => p.direction === 'out' && !p.fail && p.name !== 'cancelled' && !wired(p.name),
  );
  return (outs.find((p) => p.enabled) ?? outs[0])?.name;
}

/** First port of a node a dropped pattern attaches to: open, unwired and accepted by it. */
export function patternTarget(
  model: FlowModel,
  nodeId: Ulid,
  id: PatternId,
  preferred?: string,
): string | undefined {
  const entry = model.nodes.get(nodeId);
  if (!entry) return undefined;
  const edges = model.levels.get(entry.level)?.edges ?? [];
  const wired = (p: string) => edges.some((e) => e?.from?.node === nodeId && e.from.port === p);
  const candidates = legalPorts(entry.node).filter(
    (p) => p.direction === 'out' && patternFits(id, entry.node, p.name) && !wired(p.name),
  );
  if (preferred && candidates.some((p) => p.name === preferred)) return preferred;
  // Enabled ports first: dropping on a node should resolve what is already flagged.
  return (candidates.find((p) => p.enabled) ?? candidates[0])?.name;
}
