// Messages between the extension host and the flow editor webview (one request/response scheme).
import type { FlowCommand } from './flow/commands';
import type { OpenPort } from './flow/openPorts';
import type { FlowDocument, Position, Ulid } from './flow/types';
import type { Finding } from './flow/validate';
import type { Path } from './yaml/parse';

export interface Snapshot {
  /** TextDocument version this snapshot was built from. */
  docVersion: number;
  /** Last good model; null if the document never parsed. */
  doc: FlowDocument | null;
  /** The current text does not parse; `doc` is the last good model and commands are refused. */
  stale: boolean;
  parseError?: string;
  findings: Finding[];
  openPorts: OpenPort[];
  /** In-memory positions for nodes the layout block does not place (never written, ADR-0002). */
  autoPositions: Record<Ulid, Position>;
}

export type HostMessage =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'ack'; reqId: number; ok: boolean; error?: string; created?: Ulid }
  | { type: 'reveal'; node: Ulid }
  | { type: 'config'; testMode: boolean }
  /** Test mode: asks the webview for a summary of its DOM. */
  | { type: 'inspect'; reqId: number };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'command'; reqId: number; command: FlowCommand }
  | { type: 'openText'; path?: Path }
  | { type: 'validate' }
  | { type: 'tidyUp' }
  | { type: 'inspectResult'; reqId: number; result: DomSummary }
  | { type: 'perf'; event: 'firstRender' | 'render' | 'roundTrip'; ms: number; docVersion: number }
  | { type: 'cspViolation'; detail: string };

/** What the canvas actually rendered (test mode). */
export interface DomSummary {
  docVersion: number;
  nodes: { id: string; ports: string[] }[];
  edges: number;
  banner: number | null;
}
