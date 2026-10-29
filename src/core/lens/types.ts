// Lenses (D-18, 04 §7, M8): one category of facts across the whole canvas. A lens fills the node
// chips (two at most, D-19), may label wires, and adds a side panel with findings. Pure data: the
// host gathers facts (inventory, catalog, run history), the webview computes the view.
import type { FlowCommand } from '../flow/commands';
import type { Ulid } from '../flow/types';

export type LensId = 'inventory' | 'data' | 'code' | 'access' | 'timing';

export const LENSES: readonly { id: LensId; label: string }[] = [
  { id: 'inventory', label: 'Inventory' },
  { id: 'data', label: 'Data' },
  { id: 'code', label: 'Code' },
  { id: 'access', label: 'Access' },
  { id: 'timing', label: 'Timing' },
];

export interface LensChip {
  text: string;
  title?: string;
  tone?: 'warn' | 'muted';
}

/** A side panel row; hovering it highlights `nodes` and dims the rest (04 §7). */
export interface LensItem {
  key: string;
  label: string;
  value?: string;
  detail?: string;
  nodes: Ulid[];
  tone?: 'warn' | 'muted';
}

export interface LensSection {
  title: string;
  items: LensItem[];
  empty?: string;
}

/** A one-edit fix (a canvas command), or a jump to the node's properties. */
export type FindingFix =
  | { label: string; command: FlowCommand }
  | { label: string; properties: Ulid };

export interface LensFinding {
  /** Stable across documents (`inventory:broad-target:<node>`), the key of `finding_accepted`. */
  id: string;
  lens: LensId;
  severity: 'warning' | 'info';
  title: string;
  detail: string;
  /** The node an acceptance is attached to (deleted with it). */
  node?: Ulid;
  nodes: Ulid[];
  fixes: FindingFix[];
  accepted?: { reason: string; by?: string };
}

/** Data lens (decision 14): derived from `from:` references, never stored as edges. */
export interface DataWire {
  id: string;
  from: Ulid;
  to: Ulid;
  label: string;
  title: string;
}

export interface LensView {
  lens: LensId;
  chips: Record<Ulid, LensChip[]>;
  /** Wire labels by edge id (Inventory: hosts that took the wire in the last run). */
  wires?: Record<string, string>;
  dataWires?: DataWire[];
  stats: { label: string; value: string }[];
  sections: LensSection[];
  findings: LensFinding[];
  /** What the lens cannot show yet and why (no inventory read, no catalog, no runs). */
  notes: string[];
}

// ---- Facts the host gathers -------------------------------------------------------------------

/** One host pattern resolved against the inventory (probe `inventory_lens`). */
export interface PatternFacts {
  count: number;
  /** Hosts the flow targets do not include. */
  outside: number;
  /** A few of those hosts, for the finding text. */
  sample: string[];
}

/** Inventory variables that decide access, aggregated over a pattern's hosts. */
export interface AccessVar {
  /** Value → host count; booleans as `true`/`false`. Vaulted values are never read. */
  values: Record<string, number>;
  /** Where the values come from (`group_vars/all.yml:2`); booleans carry no origin. */
  origins: string[];
  vault?: boolean;
}

export interface InventoryFacts {
  sources: string[];
  /** Sources that are inventory plugins or scripts (read on demand, with a timeout). */
  dynamic: string[];
  total: number;
  /** The flow targets this was resolved for (the targets input as last entered). */
  targets: string;
  patterns: Record<string, PatternFacts>;
  /** Hosts in any pattern, and the groups they belong to. */
  scope: { count: number; groups: Record<string, number> };
  prod_groups: string[];
  /** Per pattern: ansible_user, ansible_become, ansible_become_user, ansible_connection. */
  access: Record<string, Record<string, AccessVar>>;
  /** Vaulted variable names of the hosts in scope, with their origin (never the value). */
  vaulted: Record<string, string>;
}

export interface InventoryState {
  state: 'idle' | 'loading' | 'ready' | 'error';
  facts?: InventoryFacts;
  error?: string;
  /** The targets pattern the user entered (remembered with the run inputs). */
  targets?: string;
  inventory?: string;
}

export interface CodeNodeFacts {
  kind: 'module' | 'role' | 'playbook';
  ref: string;
  fqcn?: string;
  collection?: string;
  version?: string;
  state: 'ok' | 'not-in-ee' | 'removed' | 'deprecated' | 'unknown';
  why?: string;
  /** Playbook bindings: the `hosts:` of the imported plays. */
  hosts?: string[];
}

export interface CodeFacts {
  /** False until a catalog of the environment exists (opening a flow never starts the probe). */
  ready: boolean;
  environment: string;
  /** Installed collection → version. */
  collections: Record<string, string>;
  /** `collections/requirements.yml` pins, collection → version spec. */
  requirements?: { path: string; pins: Record<string, string> };
  nodes: Record<Ulid, CodeNodeFacts>;
}

export interface NodeTiming {
  runs: number;
  /** Seconds. */
  avg: number;
  p95: number;
  last: number;
}

/** Local run history (decision M8-2): the last 20 runs started from VS Code. */
export interface TimingFacts {
  runs: number;
  nodes: Record<Ulid, NodeTiming>;
}

export interface LensFacts {
  inventory?: InventoryState;
  code?: CodeFacts;
  timing?: TimingFacts;
}
