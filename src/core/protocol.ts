// Messages between the extension host and the flow editor webview (one request/response scheme).
import type { CatalogOption, CatalogPlugin, PluginType, SearchHit } from './catalog/types';
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

/** The environment's catalog as the properties view shows it (M5). */
export interface CatalogStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  /** What is happening while loading ("Reading plugin docs…"), or the error. */
  message?: string;
  /** The environment label (`docker: ee-network:1.4`). */
  environment?: string;
  core?: string;
  plugins?: number;
  modules?: number;
  collections?: number;
  /** Collections whose docs could not be read. */
  failed?: string[];
  /** Search context: platform collections of the inventory, collections in use. */
  platforms?: string[];
  used?: string[];
}

/** A repository role and its entry points (meta/argument_specs.yml). */
export interface RoleInfo {
  name: string;
  path: string;
  entry_points: Record<
    string,
    { short_description: string; description: string; options: Record<string, CatalogOption> }
  >;
  tasks: string[];
}

/** Plugin docs plus the indexed version of its collection (stored as collection_version). */
export type CatalogDoc = CatalogPlugin & { collection_version?: string };

/** A repository playbook and its plays (a playbook binding imports it, ADR-0011). */
export interface PlaybookInfo {
  path: string;
  plays: { name?: string; hosts?: string }[];
}

export type CatalogRequest =
  | { op: 'search'; query: string; types?: PluginType[] }
  | { op: 'doc'; fqcn: string; type?: PluginType }
  | { op: 'roles' }
  | { op: 'playbooks' }
  | { op: 'rebuild' };

/** What each request answers. */
export interface CatalogResults {
  search: SearchHit[];
  doc: CatalogDoc | null;
  roles: RoleInfo[];
  playbooks: PlaybookInfo[];
  rebuild: CatalogStatus;
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
  | { type: 'inspect'; reqId: number }
  | { type: 'catalogStatus'; status: CatalogStatus }
  /** Opens a node's properties page (tests and commands). */
  | {
      type: 'openProperties';
      node: Ulid;
      tab?: 'general' | 'implementation' | 'io' | 'ports' | 'execution';
    }
  | { type: 'catalogReply'; reqId: number; ok: boolean; result?: unknown; error?: string };

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
  | { type: 'cspViolation'; detail: string }
  | { type: 'catalog'; reqId: number; request: CatalogRequest };

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
