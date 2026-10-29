// Messages between the extension host and the flow editor webview (one request/response scheme).
import type { FlowCommand } from './flow/commands';
import type { OpenPort } from './flow/openPorts';
import type { FlowDocument, Position, Ulid } from './flow/types';
import type { Finding } from './flow/validate';
import type { RunSummary } from './run/events';
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
  /** Generated play per node (ADR-0009); absent while the flow has errors. */
  plays?: Record<Ulid, string>;
}

/** A skeleton or real run of the flow and what it did per node (M3; full Run mode is M7). */
export interface RunView {
  id: string;
  mode: 'check' | 'real';
  state: 'running' | 'done' | 'error';
  startedAt: string;
  finishedAt?: string;
  rc?: number;
  error?: string;
  environment?: string;
  summary?: RunSummary;
}

export type HostMessage =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'run'; run: RunView | null }
  | { type: 'ack'; reqId: number; ok: boolean; error?: string; created?: Ulid }
  | { type: 'reveal'; node: Ulid }
  /** Opens a level on the canvas: `root` or a subflow node id (M4; tests and commands). */
  | { type: 'openLevel'; level: string }
  | { type: 'config'; testMode: boolean }
  /** Test mode: asks the webview for a summary of its DOM. */
  | { type: 'inspect'; reqId: number };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'command'; reqId: number; command: FlowCommand }
  | { type: 'openText'; path?: Path }
  | { type: 'validate' }
  | { type: 'tidyUp'; level?: string }
  | { type: 'run'; mode: 'check' | 'real' }
  | { type: 'generate' }
  | { type: 'showRunOutput' }
  /** Opens the node's generated play (a subflow: its level file) in a text editor (D-22). */
  | { type: 'peekCode'; node: Ulid }
  | { type: 'inspectResult'; reqId: number; result: DomSummary }
  | { type: 'perf'; event: 'firstRender' | 'render' | 'roundTrip'; ms: number; docVersion: number }
  | { type: 'cspViolation'; detail: string };

/** What the canvas actually rendered (test mode). */
export interface DomSummary {
  docVersion: number;
  /** Level on the canvas: `root` or the open subflow's node id (M4). */
  level: string;
  /** Per node: every port of its type, the enabled ones, and those shown at rest (D-14). */
  nodes: { id: string; legal: string[]; ports: string[]; rest: string[] }[];
  edges: number;
  banner: number | null;
  /** Inside a subflow: frame ports shown (enabled ones) and boundary wires drawn. */
  frame: { ports: string[]; wires: number } | null;
}
