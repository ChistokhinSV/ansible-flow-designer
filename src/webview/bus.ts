// Message bus to the extension host: commands are requests answered by `ack`.
import type { DriftAction } from '../core/drift/types';
import type { FlowCommand } from '../core/flow/commands';
import type { HostMessage, WebviewMessage } from '../core/protocol';

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
}

const api: VsCodeApi = acquireVsCodeApi();
const listeners = new Set<(m: HostMessage) => void>();
const pending = new Map<number, (a: Ack) => void>();
let nextReq = 1;

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const m = event.data;
  if (!m || typeof m !== 'object' || !('type' in m)) return;
  if (m.type === 'ack') {
    pending.get(m.reqId)?.({ ok: m.ok, error: m.error, created: m.created });
    pending.delete(m.reqId);
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
    send({ type: 'driftAction', reqId, action });
  });
}

export function command(cmd: FlowCommand): Promise<Ack> {
  const reqId = nextReq++;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
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
