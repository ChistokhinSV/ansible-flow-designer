// Message bus to the host: commands are requests answered by `ack`. The host is reached through a
// transport (transport.ts): VS Code's webview API, or what a web page gave mount().
import type { DriftAction } from '../core/drift/types';
import type { FlowCommand } from '../core/flow/commands';
import type { HostMessage, WebviewMessage } from '../core/protocol';
import type { ScenarioRequest } from '../core/scenario/edit';
import { VIEWER_REFUSAL, viewerAllows } from '../core/viewer';
import { type DesignerTransport, inVsCode, vscodeTransport } from './transport';

export interface Ack {
  ok: boolean;
  error?: string;
  created?: string;
  pasted?: string[];
}

let transport: DesignerTransport | undefined;
let unsubscribe: (() => void) | undefined;
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

function receive(m: HostMessage): void {
  if (!m || typeof m !== 'object' || !('type' in m)) return;
  if (m.type === 'ack') {
    pending.get(m.reqId)?.({ ok: m.ok, error: m.error, created: m.created, pasted: m.pasted });
    pending.delete(m.reqId);
    told();
  }
  for (const l of listeners) l(m);
}

/**
 * The host the designer talks to from now on. In VS Code it is set when this module loads, as
 * before; a web page sets its own before the designer renders (mount.tsx).
 */
export function setTransport(next: DesignerTransport): void {
  unsubscribe?.();
  transport = next;
  unsubscribe = next.subscribe(receive);
}

if (inVsCode()) setTransport(vscodeTransport());

function host(): DesignerTransport {
  if (!transport) throw new Error('The designer has no host: call setTransport() first');
  return transport;
}

let viewer = false;

/**
 * AFD-270: from now on only a viewer's messages leave the designer (core/viewer.ts). The screen
 * hides what a viewer cannot do; this is what makes a missed button do nothing.
 */
export function restrictToViewer(): void {
  viewer = true;
}

export function send(message: WebviewMessage): void {
  if (viewer && !viewerAllows(message.type)) return;
  host().post(message);
}

export function onHostMessage(listener: (m: HostMessage) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * AFD-152: how long a request may go unanswered. The host answers every request now, even when
 * its handler fails; this is the backstop, so "Saving…" never stays for good.
 */
export const REQUEST_TIMEOUT_MS = 120_000;

function request(make: (reqId: number) => WebviewMessage): Promise<Ack> {
  const reqId = nextReq++;
  // A viewer's request is answered here: the host never sees it.
  if (viewer && !viewerAllows(make(reqId).type))
    return Promise.resolve({ ok: false, error: VIEWER_REFUSAL });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.delete(reqId)) return;
      told();
      resolve({
        ok: false,
        error: `${transport?.hostName ?? 'The host'} did not answer in 2 minutes: the change may not have been made`,
      });
    }, REQUEST_TIMEOUT_MS);
    pending.set(reqId, (a) => {
      clearTimeout(timer);
      resolve(a);
    });
    told();
    send(make(reqId));
  });
}

/** A drift action the host carries out (M6: stubs, specs, re-sync), answered by `ack`. */
export const hostAction = (action: DriftAction): Promise<Ack> =>
  request((reqId) => ({ type: 'driftAction', reqId, action }));

/** AFD-116: a change to the flow's scenarios file, one edit, answered by `ack`. */
export const scenarioRequest = (req: ScenarioRequest) =>
  request((reqId) => ({ type: 'scenarioEdit', reqId, request: req }));

/** AFD-116: takes back the last scenario change made from the designer. */
export const scenarioUndo = () => request((reqId) => ({ type: 'scenarioUndo', reqId }));

export const command = (cmd: FlowCommand): Promise<Ack> =>
  request((reqId) => ({ type: 'command', reqId, command: cmd }));

/** UI-only state kept by the host while the designer is hidden (viewport, panel widths). */
export function loadState<T>(): Partial<T> {
  return (host().getState() as Partial<T> | undefined) ?? {};
}

export function saveState<T>(state: T): void {
  host().setState(state);
}
