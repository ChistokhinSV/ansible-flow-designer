// Message bus to the extension host: commands are requests answered by `ack`.
import type { DriftAction } from '../core/drift/types';
import type { FlowCommand } from '../core/flow/commands';
import type { HostMessage, WebviewMessage } from '../core/protocol';
import type { ScenarioRequest } from '../core/scenario/edit';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export interface Ack {
  ok: boolean;
  error?: string;
  created?: string;
  pasted?: string[];
}

const api: VsCodeApi = acquireVsCodeApi();
const listeners = new Set<(m: HostMessage) => void>();
const pending = new Map<number, (a: Ack) => void>();
let nextReq = 1;
const inFlight = new Set<(n: number) => void>();
const told = () => {
  for (const l of inFlight) l(pending.size);
};

/** How many requests wait for their answer, each time it changes (AFD-46: "Saving…"). */
export function onInFlight(listener: (n: number) => void): () => void {
  inFlight.add(listener);
  return () => inFlight.delete(listener);
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const m = event.data;
  if (!m || typeof m !== 'object' || !('type' in m)) return;
  if (m.type === 'ack') {
    pending.get(m.reqId)?.({ ok: m.ok, error: m.error, created: m.created, pasted: m.pasted });
    pending.delete(m.reqId);
    told();
  }
  for (const l of listeners) l(m);
});

export function send(message: WebviewMessage): void {
  api.postMessage(message);
}

export function onHostMessage(listener: (m: HostMessage) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A drift action the host carries out (M6: stubs, specs, re-sync), answered by `ack`. */
export function hostAction(action: DriftAction): Promise<Ack> {
  const reqId = nextReq++;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    told();
    send({ type: 'driftAction', reqId, action });
  });
}

function request(make: (reqId: number) => WebviewMessage): Promise<Ack> {
  const reqId = nextReq++;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    told();
    send(make(reqId));
  });
}

/** AFD-116: a change to the flow's scenarios file, one edit, answered by `ack`. */
export const scenarioRequest = (req: ScenarioRequest) =>
  request((reqId) => ({ type: 'scenarioEdit', reqId, request: req }));

/** AFD-116: takes back the last scenario change made from the designer. */
export const scenarioUndo = () => request((reqId) => ({ type: 'scenarioUndo', reqId }));

export function command(cmd: FlowCommand): Promise<Ack> {
  const reqId = nextReq++;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    told();
    send({ type: 'command', reqId, command: cmd });
  });
}

/** UI-only state kept by VS Code while the panel is hidden (viewport, panel widths). */
export function loadState<T>(): Partial<T> {
  return (api.getState() as Partial<T> | undefined) ?? {};
}

export function saveState<T>(state: T): void {
  api.setState(state);
}
