// Code sync and drift (M6, ADR-0012): what the probe compiled from the repository, and the drift
// items computed from it and the flow (03 "Drift record": computed, never stored). Pure types.
import type { ContractField, Ulid } from '../flow/types';
import type { RoleInfo } from '../protocol';

export interface CodeOrigin {
  /** Repository-relative path (forward slashes), or absolute outside the repository. */
  path: string;
  line?: number;
}

export interface CodeTask {
  name: string;
  action: string;
  tags: string[];
  origin: CodeOrigin | null;
  register: string[];
  /** Keys a set_fact sets. */
  facts: string[];
  /** Keys a set_stats publishes. */
  stats: string[];
  role: string | null;
  section: 'block' | 'rescue' | 'always';
  /** include_tasks / include_role: not expanded at compile time (07 §5). */
  dynamic: boolean;
  /** Added by Ansible (validate_argument_spec): never drift. */
  auto: boolean;
}

export interface CodePlay {
  name: string;
  hosts: string;
  tags: string[];
  origin: CodeOrigin | null;
  tasks: CodeTask[];
}

export interface CompiledPlaybook {
  path: string;
  error?: string;
  plays: CodePlay[];
}

export interface CompiledRole {
  name: string;
  tasks_from: string | null;
  error?: string;
  tasks: CodeTask[];
}

export interface GitState {
  branch?: string;
  /** Short commit hash. */
  commit?: string;
  /** Full commit hash (compared with the revision AWX ran, M7). */
  sha?: string;
  /** ISO time of the commit. */
  when?: string;
  /** Repository-relative paths with uncommitted changes that matter to this flow. */
  dirty: string[];
}

/** One sync (Re-sync from git): the working tree as the probe compiled it (decision M6-1). */
export interface CodeScan {
  /** ISO time of the scan. */
  at: string;
  environment: string;
  git?: GitState;
  /** The flow's root generated playbook (with its imported levels and playbook bindings). */
  generated: CompiledPlaybook;
  roles: CompiledRole[];
  /** Bound playbooks, compiled on their own (a missing one would break the generated scan). */
  playbooks: CompiledPlaybook[];
  roleInfo: RoleInfo[];
  /** Return keys of bound modules, from the catalog when it is loaded. */
  moduleReturns?: Record<string, string[]>;
}

export type DriftKind = 'contract_mismatch' | 'code_without_design' | 'design_without_code';

export type DriftAction =
  | { kind: 'renameOutput'; node: Ulid; from: string; to: string }
  | { kind: 'removeOutput'; node: Ulid; name: string }
  | { kind: 'setOutputFrom'; node: Ulid; name: string; from: string }
  | { kind: 'addInput'; node: Ulid; name: string; field: ContractField }
  | { kind: 'removeInput'; node: Ulid; name: string }
  | { kind: 'openCode'; path: string; line?: number }
  | { kind: 'addToSubflow'; subflow: Ulid; role: string; tasksFrom: string }
  | { kind: 'ignore'; node: Ulid; item: string }
  | { kind: 'unignore'; node: Ulid; item: string }
  | { kind: 'generateStub'; node: Ulid; role: string }
  | { kind: 'writeSpecs'; node: Ulid }
  | { kind: 'bind'; node: Ulid; bindKind: 'module' | 'role' | 'playbook' }
  | { kind: 'regenerate' }
  | { kind: 'resync' };

export interface DriftItem {
  /** Stable key of the item: what a drift_ignored decision names. */
  id: string;
  kind: DriftKind;
  node?: Ulid;
  /** The node's title (mockup 04 "Validate · outputs differ"). */
  title: string;
  label: string;
  detail: string;
  severity: 'warning' | 'info';
  /** Design side first, code side second (D-29: both ways); Ignore last. */
  actions: { label: string; action: DriftAction }[];
  ignored?: { reason?: string; by?: string };
}

/** What a node runs, as the code says (Implementation mode node chips, 04 §6). */
export interface NodeCode {
  node: Ulid;
  /** `role: netops.backup`, `module: cisco.ios.ios_config`, `playbook: precheck.yml`, `not bound`. */
  artifact: string;
  /** Tasks of the binding without Ansible's own (validate_argument_spec). */
  tasks: CodeTask[];
  /** Dynamic includes among them: their tasks are not counted. */
  dynamic: number;
  /** A play of the generated code carries `node_<ULID>` (D-28). */
  matched: boolean;
  /** Where the node's generated play starts. */
  play?: CodeOrigin;
  /** The binding's code is missing or broken. */
  missing?: string;
}

export interface DriftReport {
  items: DriftItem[];
  nodes: Record<Ulid, NodeCode>;
  matched: number;
  /** Nodes that generate plays (everything but start and end). */
  matchable: number;
}
