// How the designer reaches its host (ADR-0036, AFD-269). In VS Code that is the webview API; in a
// web page the host supplies its own, for example over a WebSocket.
import type { HostMessage, WebviewMessage } from '../core/protocol';

export interface DesignerTransport {
  /** Named when a request goes unanswered ("VS Code did not answer…"). Default: "The host". */
  hostName?: string;
  /** Sends a message to the host. */
  post(message: WebviewMessage): void;
  /** Calls `listener` with every message from the host, until the returned function is called. */
  subscribe(listener: (message: HostMessage) => void): () => void;
  /** UI-only state the host keeps for this designer (viewport, panel widths), or undefined. */
  getState(): unknown;
  setState(state: unknown): void;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** True inside a VS Code webview (and wherever a host defines the same function). */
export const inVsCode = (): boolean => typeof acquireVsCodeApi === 'function';

/** The VS Code webview API as a transport. VS Code hands the API out once: call this once. */
export function vscodeTransport(): DesignerTransport {
  const api = acquireVsCodeApi();
  return {
    hostName: 'VS Code',
    post: (message) => api.postMessage(message),
    subscribe(listener) {
      const onMessage = (event: MessageEvent<HostMessage>) => listener(event.data);
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    },
    getState: () => api.getState(),
    setState: (state) => api.setState(state),
  };
}
