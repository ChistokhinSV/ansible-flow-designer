// The debugger's words and mappings (ADR-0040 §6–§8, AFD-369, AFD-371, AFD-372), shared by the
// canvas (VS Code and a server's pages) and VS Code's debug adapter. Pure.
// - the reason line of a pause: the step, the count of hosts and why;
// - Retry's warning: the step runs again, and changes on hosts are not undone;
// - pause points as VS Code breakpoints: function breakpoints named "<flow key>:<step key path>",
//   source breakpoints on a step's `key:` line, a hit condition as a count;
// - a value of an inspect answer as one line of text.
import { keyPath } from '../ai/refs';
import { pausableNode } from '../flow/canvasMenu';
import type { FlowModel } from '../flow/model';
import type { Ulid } from '../flow/types';
import { locate, parseYaml } from '../yaml/parse';
import type { FailureFilters, PausePoint, PointSpec, StepPause, VarEntry } from './step';
import { hostsWord } from './words';

/** A debug run pauses when a host fails, unless turned off; never when unreachable, unless on. */
export const DEFAULT_FAILURES: Required<FailureFilters> = { failed: true, unreachable: false };

/** The filters with their defaults filled in. */
export function failuresOf(f: FailureFilters | undefined): Required<FailureFilters> {
  return {
    failed: f?.failed ?? DEFAULT_FAILURES.failed,
    unreachable: f?.unreachable ?? DEFAULT_FAILURES.unreachable,
  };
}

/** How a pause point pauses, as the popover offers it. */
export type PointHow = 'always' | 'when' | 'log';

/** The popover's choice for a point: log only, a condition, or always (a hit count goes with both). */
export function pointHow(p: PointSpec | undefined): PointHow {
  if (!p || typeof p === 'string') return 'always';
  if (p.log?.trim()) return 'log';
  if (p.condition?.trim()) return 'when';
  return 'always';
}

/** How a point's dot looks: plain, with a condition or a count, or log only. */
export function pointDot(p: PointSpec | undefined): 'on' | 'condition' | 'log' {
  if (!p || typeof p === 'string') return 'on';
  if (p.log?.trim()) return 'log';
  return p.condition?.trim() || p.hits ? 'condition' : 'on';
}

/** A point's settings in words, for its dot's tooltip: "pauses when … after 3 arrivals". */
export function pointWords(p: PointSpec | undefined): string {
  if (!p || typeof p === 'string') return 'Pause point: a run pauses here, also after Continue.';
  const after = p.hits ? ` once it is reached ${p.hits} time${p.hits === 1 ? '' : 's'}` : '';
  if (p.log?.trim()) return `Log point: writes "${p.log.trim()}" per host${after}, never pauses.`;
  if (p.condition?.trim()) return `Pause point: pauses when ${p.condition.trim()}${after}.`;
  return `Pause point: pauses here${after || ', also after Continue'}.`;
}

const list = (hosts: readonly string[], max = 3): string =>
  hosts.length <= max
    ? hosts.join(', ')
    : `${hosts.slice(0, max).join(', ')} and ${hosts.length - max} more`;

/** Whether every failed host of a failure pause was unreachable. */
const allUnreachable = (pause: StepPause): boolean =>
  !!pause.failed?.length && pause.failed.every((f) => f.unreachable);

/**
 * The short reason of a pause: "1 host failed Apply config", "Paused before Apply config". VS Code
 * shows it as the stopped thread's badge, so it stays short.
 */
export function shortReason(pause: StepPause, title: string): string {
  if (pause.kind === 'failure') {
    const n = pause.failed?.length ?? 0;
    return allUnreachable(pause)
      ? `${hostsWord(n)} unreachable at ${title}`
      : `${hostsWord(n)} failed ${title}`;
  }
  return `Paused before ${title}`;
}

/**
 * The reason line of a pause: the step, the count of hosts and why (a step, a pause point, a
 * condition, a failure or unreachable hosts): "1 host failed Apply config (attempt 1)".
 */
export function reasonLine(pause: StepPause, title: string, pointHere = false): string {
  switch (pause.kind) {
    case 'failure': {
      const attempt = ` (attempt ${pause.attempt ?? 1})`;
      return `${shortReason(pause, title)}${attempt}`;
    }
    case 'condition': {
      const m = pause.matched ?? [];
      return `Paused before ${title}: the condition matched ${m.length ? list(m) : 'a host'} · ${hostsWord(pause.hosts.length)} wait`;
    }
    case 'point':
      return `Paused before ${title} at a pause point · ${hostsWord(pause.hosts.length)}`;
    default:
      return `Paused before ${title}${pointHere ? ' at a pause point' : ''} · ${hostsWord(pause.hosts.length)}`;
  }
}

/** The hosts a Retry runs the step again on. */
export const retryHosts = (pause: StepPause): string[] => (pause.failed ?? []).map((f) => f.host);

/** What Retry does, said wherever it is offered. */
export function retryWarning(pause: StepPause, title: string): string {
  const hosts = retryHosts(pause);
  return `Retry runs ${title} again on ${hosts.length ? list(hosts) : 'the failed hosts'}. Changes on hosts are not undone.`;
}

/** Each failed host in a line: "edge-02: Push config: interface rejected the change". */
export function failedLines(pause: StepPause): string[] {
  return (pause.failed ?? []).map(
    (f) =>
      `${f.host}${f.unreachable ? ' (unreachable)' : ''}: ${[f.task, f.msg].filter(Boolean).join(': ') || 'failed'}`,
  );
}

// ---- pause points as VS Code breakpoints ------------------------------------------------------

/** A function breakpoint's name for a step: "<flow key>:<step key path>". */
export const breakpointName = (flowKey: string, path: string): string => `${flowKey}:${path}`;

/** A function breakpoint's name read back: the flow key (when named) and the step's key path. */
export function readBreakpointName(name: string): { flow?: string; path: string } {
  const text = name.trim();
  const colon = text.indexOf(':');
  if (colon <= 0) return { path: text };
  return { flow: text.slice(0, colon).trim(), path: text.slice(colon + 1).trim() };
}

/** A step of the flow by its key path ("push/apply"), when a run can pause there. */
export function stepByPath(model: FlowModel, path: string): Ulid | undefined {
  for (const e of model.nodes.values())
    if (pausableNode(e.node) && keyPath(model, e.node.id) === path) return e.node.id;
  return undefined;
}

/**
 * VS Code's hit condition as a count: "3", "=3", "==3" or ">=3" pause on the 3rd arrival; anything
 * else is refused in words.
 */
export function readHitCondition(text: string | undefined): number | { error: string } | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const m = /^\s*(?:>=|==|=)?\s*(\d+)\s*$/.exec(text);
  const n = m ? Number(m[1]) : Number.NaN;
  if (!Number.isInteger(n) || n < 1)
    return { error: 'A hit count is a whole number: the point pauses on that arrival (3, or >=3)' };
  return n;
}

/** A breakpoint's condition, hit condition and log message as a pause point's settings. */
export function pointFromBreakpoint(
  node: Ulid,
  bp: { condition?: string; hitCondition?: string; logMessage?: string },
): { point: PointSpec } | { error: string } {
  const hits = readHitCondition(bp.hitCondition);
  if (typeof hits === 'object') return hits;
  const p: PausePoint = { node };
  if (bp.condition?.trim()) p.condition = bp.condition.trim();
  if (hits) p.hits = hits;
  if (bp.logMessage?.trim()) p.log = bp.logMessage;
  return { point: p.condition || p.hits || p.log ? p : node };
}

/** The other way: a pause point's settings as a breakpoint's. */
export function breakpointOf(p: PointSpec): {
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
} {
  if (typeof p === 'string') return {};
  return {
    ...(p.condition ? { condition: p.condition } : {}),
    ...(p.hits ? { hitCondition: String(p.hits) } : {}),
    ...(p.log ? { logMessage: p.log } : {}),
  };
}

/**
 * The 1-based line of each node's `key:` in the flow file (where its breakpoint and stack frame
 * show). Nodes the text does not place are left out.
 */
export function keyLines(text: string, model: FlowModel): Map<Ulid, number> {
  const out = new Map<Ulid, number>();
  const file = parseYaml(text);
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const e of model.nodes.values()) {
    const at = locate(file, [...e.path, 'key']);
    const range = (at?.pair?.key as { range?: [number, number, number] } | null)?.range;
    if (range) out.set(e.node.id, lineOf(range[0]));
  }
  return out;
}

// ---- values of inspect answers -----------------------------------------------------------------

const MASK_WORDS: Record<string, string> = {
  vault: 'vault',
  no_log: 'no_log',
  credential: 'credential',
  external: 'external secret',
  name: 'secret-looking name',
};

/** "masked: vault": a masked value says why, never its length. */
export const maskedText = (kind: string | undefined): string =>
  `masked: ${MASK_WORDS[kind ?? ''] ?? kind ?? 'secret'}`;

/** A value inside a container (a marker or plain JSON) as text. */
export function valueText(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const marker = (value as Record<string, unknown>).__afd__;
    if (typeof marker === 'string') {
      const v = value as Record<string, unknown>;
      if (marker === 'masked') return maskedText(String(v.masked ?? ''));
      if (marker === 'template') return `${String(v.text ?? '')}  (template, not rendered)`;
      if (marker === 'lazy') return '(not read while debugging)';
      if (marker === 'bytes') return `(bytes, ${String(v.size ?? 0)})`;
      if (marker === 'deep') return '(too deep to show)';
      return String(v.repr ?? marker);
    }
    return `{${Object.keys(value).length} keys}`;
  }
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === 'string') return JSON.stringify(value);
  return value === undefined ? '' : String(value);
}

/** An entry of a scope or a container as one line of text. */
export function entryText(
  e: Pick<VarEntry, 'type' | 'value' | 'cut' | 'masked' | 'count'>,
): string {
  if (e.type === 'masked') return maskedText(e.masked);
  if (e.type === 'dict') return `{${e.count ?? 0} keys}`;
  if (e.type === 'list') return `[${e.count ?? 0} items]`;
  const text = valueText(e.value);
  return e.cut ? `${text} … (cut: ${e.cut} characters in all)` : text;
}
