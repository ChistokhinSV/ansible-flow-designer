// Messages between the extension host and the flow editor webview (one request/response scheme).
import type { CatalogOption, CatalogPlugin, PluginType, SearchHit } from './catalog/types';
import type { CodeScan, DriftAction } from './drift/types';
import type { FlowCommand } from './flow/commands';
import type { OpenPort } from './flow/openPorts';
import type { FlowDocument, Position, Ulid } from './flow/types';
import type { Finding } from './flow/validate';
import type { LensFacts, LensId } from './lens/types';
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
  /** The file has no YAML content yet (empty, or comments only): the page offers a flow (AFD-16). */
  empty?: boolean;
  /** The file's name, for the page shown when it is not a flow. */
  file?: string;
  findings: Finding[];
  openPorts: OpenPort[];
  /** In-memory positions for nodes the layout block does not place (never written, ADR-0002). */
  autoPositions: Record<Ulid, Position>;
  /** Generated play per node (ADR-0009); absent while the flow has errors. */
  plays?: Record<Ulid, string>;
  /**
   * Written by hand (AFD-19): this many IDs are missing or nodes are named by key. `doc` then shows
   * the flow with the gaps filled for display, and edits wait for Complete IDs.
   */
  idGaps?: number;
}

/** A skeleton or real run of the flow and what it did per node (M3; full Run mode is M7). */
/** Why a run did not start or stopped, when a command can fix it (AFD-37). */
export type RunErrorCode = 'cancelled' | 'awx-url' | 'awx-token' | 'awx-template';

export interface RunView {
  id: string;
  mode: 'check' | 'real';
  state: 'running' | 'done' | 'error';
  startedAt: string;
  finishedAt?: string;
  rc?: number;
  error?: string;
  /** What kind of error, so the host offers the fix (AFD-37). */
  errorCode?: RunErrorCode;
  environment?: string;
  summary?: RunSummary;
  /** Where it ran: a local terminal task (M3) or an AWX job (M7). */
  source?: 'local' | 'awx';
  /** flow.version the run executed (decision 15: `tested` is per version). */
  flowVersion?: number;
  /** Each node's design fingerprint when the run started (decision 15: `tested` is for what ran). */
  design?: Record<Ulid, string>;
  awx?: AwxRunInfo;
}

export interface AwxRunInfo {
  jobId: number;
  /** The job's output page in AWX. */
  url: string;
  template: string;
  status: string;
  /** Commit the project update checked out. */
  revision?: string;
  /** AWX ran another commit than the local HEAD (unpushed or uncommitted changes). */
  revisionMismatch?: boolean;
  /** An AWX workflow split at approvals (AFD-11): `jobId` and `url` are the workflow job's. */
  workflow?: boolean;
  /** Per approval node: its AWX approval and where to decide it. */
  approvals?: Record<Ulid, AwxApproval>;
  /** The segment jobs in the order AWX ran them. */
  segments?: { name: string; job: number; status: string }[];
}

export interface AwxApproval {
  status: 'waiting' | 'approved' | 'denied' | 'timed out';
  /** The approval in the AWX UI. */
  url: string;
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
  | {
      type: 'ack';
      reqId: number;
      ok: boolean;
      error?: string;
      created?: Ulid;
      /** Every node a paste created (AFD-17). */
      pasted?: Ulid[];
    }
  | { type: 'reveal'; node: Ulid }
  /** Opens a level on the canvas: `root` or a subflow node id (M4; tests and commands). */
  | { type: 'openLevel'; level: string }
  /** Switches the canvas mode (tests and commands, M7). */
  | { type: 'setMode'; mode: 'design' | 'code' | 'run' }
  | { type: 'config'; testMode: boolean }
  /** Test mode: asks the webview for a summary of its DOM. */
  | { type: 'inspect'; reqId: number }
  | { type: 'catalogStatus'; status: CatalogStatus }
  /** Shows a node's Details on a tab (tests and commands, AFD-43). */
  | {
      type: 'openDetails';
      node: Ulid;
      tab?: 'general' | 'binding' | 'io' | 'ports' | 'execution';
    }
  | { type: 'catalogReply'; reqId: number; ok: boolean; result?: unknown; error?: string }
  /** Code sync (M6): the last scan of the working tree, or where a re-sync stands. */
  | { type: 'sync'; state: 'syncing' | 'done' | 'error'; scan?: CodeScan; error?: string }
  /** Lens facts (M8): inventory, catalog view of the bindings, run history; merged into the store. */
  | { type: 'lensFacts'; facts: LensFacts }
  /** Switches the lens (tests and commands, M8). */
  | { type: 'setLens'; lens: LensId | null }
  /** AFD-17 palette commands: copy the selected nodes, or paste text the host read. */
  | { type: 'clipboard'; action: 'copy' }
  /** `at`: the spot on the canvas where the context menu's Paste here was chosen (AFD-18). */
  | { type: 'clipboard'; action: 'paste'; text: string; at?: Position }
  /** AFD-25 PNG export: draw this SVG (light, `width` x `height` px) on a canvas and send the PNG. */
  | { type: 'renderPng'; reqId: number; svg: string; width: number; height: number };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'command'; reqId: number; command: FlowCommand }
  | { type: 'openText'; path?: Path }
  /** AFD-16: fill an empty file with the New Flow template. */
  | { type: 'initFlow' }
  /** AFD-19: real IDs for a flow written by hand, in one edit. */
  | { type: 'completeIds' }
  | { type: 'validate' }
  /** AFD-22: a page of the user guide (docs/guide), README.md when none. */
  | { type: 'openGuide'; page?: string }
  | { type: 'tidyUp'; level?: string }
  | { type: 'run'; mode: 'check' | 'real' }
  | { type: 'generate' }
  /** The run's output; with `approval`, that approval node's page in AWX (AFD-11). */
  | { type: 'showRunOutput'; approval?: Ulid }
  /** Opens the node's generated play (a subflow: its level file) in a text editor (D-22). */
  | { type: 'peekCode'; node: Ulid }
  | { type: 'inspectResult'; reqId: number; result: DomSummary }
  | { type: 'perf'; event: 'firstRender' | 'render' | 'roundTrip'; ms: number; docVersion: number }
  | { type: 'cspViolation'; detail: string }
  | { type: 'catalog'; reqId: number; request: CatalogRequest }
  /** Re-sync from git (M6). */
  | { type: 'sync' }
  /** Launch the flow's AWX job template (M7). */
  | { type: 'launchAwx' }
  /** AFD-39: stop the run going (terminal task or AWX job). */
  | { type: 'stopRun' }
  /** Opens a repository file at a line (drift "Open code"). */
  | { type: 'openCode'; path: string; line?: number }
  /** Drift actions the host carries out (stubs, specs, re-sync), answered by `ack`. */
  | { type: 'driftAction'; reqId: number; action: DriftAction }
  /** A lens was picked (M8): the host gathers its facts; `refresh` reads the inventory again. */
  | { type: 'lens'; lens: LensId | null; refresh?: boolean }
  /** Asks for the flow targets the Inventory lens counts (remembered with the run inputs). */
  | { type: 'setTargets' }
  /** AFD-17: nodes as text for the system clipboard (Copy buttons, the palette command). */
  | { type: 'copyText'; text: string; count: number }
  /** AFD-18: Paste here in the context menu; the host reads the clipboard and answers this panel. */
  | { type: 'requestPaste'; at?: Position }
  /** AFD-25: the "…" menu's exports; images cover the level open on the canvas. */
  | { type: 'export'; format: 'drawio' | 'image'; level: string }
  /** AFD-25: the PNG drawn for `renderPng`, base64. */
  | { type: 'pngRendered'; reqId: number; data?: string; error?: string };

/** What the canvas actually rendered (test mode). */
export interface DomSummary {
  docVersion: number;
  /** Level on the canvas: `root` or the open subflow's node id (M4). */
  level: string;
  /** Per node: every port of its type, the enabled ones, and those shown at rest (D-14). */
  nodes: { id: string; legal: string[]; ports: string[]; rest: string[] }[];
  edges: number;
  banner: number | null;
  /** AFD-19: items the written-by-hand banner says need IDs (null: no banner). */
  idGaps: number | null;
  /** Inside a subflow: frame ports shown (enabled ones) and boundary wires drawn. */
  frame: { ports: string[]; wires: number } | null;
  /** Run mode (M7): each node's run state and each wire's label as drawn. */
  run?: { nodes: Record<string, string>; wires: Record<string, string> };
  /** Lens (M8): chips per node, finding ids, data wires, highlighted nodes, the open card's rows. */
  lens?: {
    lens: string;
    chips: Record<string, string[]>;
    findings: string[];
    dataWires: number;
    highlighted: string[];
    card: string[];
  };
}
