// Types of the flow document (schema/flow.schema.json, schema_version 1 plus the additive fields of ADR-0004).

export type Ulid = string;

export const NODE_TYPES = [
  'start',
  'end',
  'task',
  'subflow',
  'decision',
  'approval',
  'parallel',
  'join',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_STATUSES = ['draft', 'specified', 'implemented', 'tested'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export type ContractType = 'string' | 'integer' | 'boolean' | 'list' | 'dict' | 'host_list' | 'any';

export interface ContractField {
  type: ContractType;
  required?: boolean;
  default?: unknown;
  /** `node_key.output_name`, `flow.input_name`, or an impl return path. */
  from?: string;
  /** Flow inputs only: this host_list seeds the start node. */
  targets?: boolean;
}

export type Contract = Record<string, ContractField>;

export interface PortRef {
  node: Ulid;
  port: string;
}

export interface Edge {
  id: Ulid;
  from: PortRef;
  to: PortRef;
}

export interface ImplBinding {
  kind: 'module' | 'role' | 'playbook';
  ref: string;
  collection_version?: string;
  params?: Record<string, unknown>;
  register?: string;
  /** Ansible task keywords written on the generated task as they are (AFD-26): when, loop, ... */
  keywords?: Record<string, unknown>;
}

export interface NodeSettings {
  max_fail_percentage?: number;
  serial?: string | number;
  /**
   * Subflows (AFD-55): hosts per batch through every step inside, one batch after another (a
   * number or a percentage); the steps run in one play with this serial.
   */
  rolling?: string | number;
  timeout?: string;
  retries?: number;
  /** Seconds between tries (Ansible `delay`, default 5). */
  delay?: number;
  /** Jinja test without braces: retry until it holds; reads the registered result (AFD-21). */
  until?: string;
  become?: boolean;
  /** Format 2 (AFD-52): whom to become; format 1 writes it as a task keyword. */
  become_user?: string;
  credential?: string;
  execution_environment?: string;
  inventory_target?: string;
  tags?: string[];
}

export type HandlerKind = 'rollback' | 'notify' | 'retry' | 'exclude';
export type JoinMode = 'all' | 'any';

export interface SubflowBody {
  nodes?: FlowNode[];
  edges?: Edge[];
  layout?: Layout;
  boundary?: {
    in?: Ulid;
    outputs?: Record<string, BoundaryExit[]>;
  };
}

/** An inner port that leaves the subflow through the parent's port of the same `outputs` key. */
export interface BoundaryExit extends PortRef {
  /** Why hosts leave here (mockup 10 "SSH timeout"), shown on the exit wire (ADR-0010). */
  reason?: string;
}

/**
 * The evidence for `tested` (format 2, AFD-50): a passing run of a flow version, or a reason
 * given by hand, with who gave it and when.
 */
export interface TestedRecord {
  run?: string;
  flow_version?: number;
  commit?: string;
  reason?: string;
  by?: string;
  at?: string;
}

export interface FlowNode {
  id: Ulid;
  key: string;
  type: NodeType;
  title: string;
  intent?: string;
  status?: NodeStatus;
  /** Format 2: why the node counts as tested (AFD-50); format 1 has no such field. */
  tested?: TestedRecord;
  inputs?: Contract;
  outputs?: Contract;
  /** Optional ports enabled beyond the type defaults. */
  ports?: string[];
  impl?: ImplBinding | null;
  undo?: ImplBinding | null;
  condition?: string;
  outcome?: 'success' | 'failed';
  settings?: NodeSettings;
  join_mode?: JoinMode;
  branches?: number;
  /** Format 1 name of `purpose`, which reads like an Ansible handler (AFD-52). */
  handler?: HandlerKind;
  /** Format 2: what the node is for when it handles failures (rollback, notify, retry, exclude). */
  purpose?: HandlerKind;
  subflow?: SubflowBody;
}

export interface Position {
  x: number;
  y: number;
}

export type Layout = Record<Ulid, Position>;

export type Decision =
  | { node: Ulid; port: string; kind: 'open_on_purpose'; reason?: string; by?: string }
  /** A drift item kept as it is (M6, D-29: drift is never auto-resolved, so ignoring is explicit). */
  | { node: Ulid; kind: 'drift_ignored'; item: string; port?: never; reason?: string; by?: string }
  /** A lens finding reviewed and kept as expected (M8); `finding` is its stable id. */
  | {
      kind: 'finding_accepted';
      finding: string;
      node?: Ulid;
      port?: never;
      item?: never;
      reason?: string;
      by?: string;
    }
  /**
   * Format 2 (AFD-51): the one kind. `finding` says what is accepted: `port:<port>`,
   * `drift:<item>`, `lens:<finding id>` or `check:<code>[:<subject>]` (core/flow/decisions.ts).
   */
  | {
      kind: 'accepted';
      finding: string;
      node?: Ulid;
      port?: never;
      item?: never;
      reason?: string;
      by?: string;
      at?: string;
    };

export interface FlowHeader {
  id: Ulid;
  key: string;
  name: string;
  version: number;
  goal?: string;
  owner?: string;
  runtime?: {
    kind?: 'awx_workflow' | 'awx_job' | 'ansible_playbook';
    template?: string;
    /** Format 2 (AFD-52): the AWX template's credentials and execution environment, by name. */
    credentials?: string[];
    execution_environment?: string;
  };
  /** Where an imported flow came from (M9, AFD-26): a one-time copy, kept for reference only. */
  imported_from?: {
    kind: 'awx_workflow' | 'awx_job_template' | 'playbook';
    template?: string;
    id?: number;
    path?: string;
  };
  /** Longest time the flow may take (`4h`, `2h30m`), checked by the Timing lens (M8). */
  maintenance_window?: string;
  inputs?: Contract;
}

export interface FlowDocument {
  /** 1 or 2; Upgrade Flow Format moves a 1 to 2 (AFD-49, ADR-0025). */
  schema_version: 1 | 2;
  flow: FlowHeader;
  nodes: FlowNode[];
  edges: Edge[];
  layout?: Layout;
  decisions?: Decision[];
}
