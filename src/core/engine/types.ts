// Code generation behind an engine interface (ADR-0003): Option A now, an Option B runner later.
import type { FlowDocument, Ulid } from '../flow/types';
import type { Finding } from '../flow/validate';

export interface GenerateOptions {
  /** Flow file name; generated files sit in `generated/` next to it and point at `../<source>`. */
  source: string;
  eol?: '\n' | '\r\n';
  /** Adds `afd_simulate` hooks so runs can send chosen hosts down failure paths (engine tests). */
  simulate?: boolean;
  /**
   * Scenario tests (AFD-58), with `simulate`: every step runs as its stub, so no binding runs, and a
   * decision takes true unless afd_simulate forces false (the steps feeding its condition are stubs).
   */
  stubAll?: boolean;
  /**
   * The repository root relative to `generated/` (forward slashes), for playbook bindings, whose
   * refs are repository paths. Default `../../..`: flows/<key>/generated (decision 8).
   */
  root?: string;
}

export interface GeneratedFile {
  /** File name inside `generated/`. */
  name: string;
  text: string;
  /** Flow level the file compiles (`root` or the subflow node id). */
  level: string;
}

/** Lines of one node's play in its file (0-based, end exclusive). */
export interface PlayRange {
  file: string;
  start: number;
  end: number;
}

/** What a routing group means: the hosts that left `node` through `port`. */
export interface Route {
  node: Ulid;
  port: string;
}

/** One playbook of an AWX workflow split at top-level approvals (AFD-11, ADR-0016). */
export interface SegmentFile {
  name: string;
  /** File name inside `generated/`. */
  file: string;
  /** The approval that ends it: AWX asks there, then runs `<gate>-approved` or `-rejected`. */
  gate?: Ulid;
  entry?: { approval: Ulid; outcome: 'approved' | 'rejected' };
  parent?: string;
  /** Runs the outcome only, when no host reached a gate. */
  finish?: boolean;
}

export interface GenerateResult {
  ok: boolean;
  /** Level files first (the root playbook is files[0]), then AWX segment files. */
  files: GeneratedFile[];
  /** Present when top-level approvals split the flow for AWX. */
  segments?: SegmentFile[];
  findings: Finding[];
  routes: Record<string, Route>;
  plays: Record<Ulid, PlayRange>;
  /** With `simulate`: the root playbook's plays as a plan the scenario simulator runs (AFD-114). */
  plan?: RunPlan;
}

/**
 * What the root playbook of a simulate build does, play by play in run order (AFD-114, ADR-0032):
 * the scenario simulator runs it over host sets instead of Ansible running the YAML. It is the
 * generator's own routing (wiring, subflow exits, bubbling), so the two cannot disagree on where a
 * port leads; only how a play treats its hosts is the simulator's.
 */
export interface RunPlan {
  /** The flow input the start pattern reads (the targets input). */
  start?: string;
  steps: PlanStep[];
  /** The outcome play's entries in order: a host fails at the first whose groups hold it. */
  outcome: { groups: string[]; name: string; msg: string }[];
}

/** A pattern part of a play's `hosts`: a routing group, or the hosts the run starts on. */
export type HostTerm = { group: string } | { start: true };

interface StepBase {
  node: Ulid;
  /** The node run events are recorded on (a rolling subflow's steps: the subflow, AFD-55). */
  attribute: Ulid;
  /** Key path (`sub/step`) the scenario's `force` and `approvals` name it by. */
  key: string;
  /** `[key] title`, as the task names in the generated code read. */
  label: string;
  hosts: HostTerm[];
  /** Each output port the play routes into, with the group it routes to (resolved). */
  ports: Record<string, string>;
  /** `serial` set on the play (batches). */
  serial: boolean;
}

export type PlanStep =
  | (StepBase & {
      kind: 'task';
      /** The stub's message, `TODO: intent`, recorded on a failed host. */
      todo: string;
      /** max_fail_percentage: the limit and the groups counted against it. */
      maxFail?: { limit: number; groups: string[] };
    })
  | (StepBase & { kind: 'decision' })
  | (StepBase & { kind: 'approval' })
  | (StepBase & { kind: 'parallel' })
  | (StepBase & {
      kind: 'join';
      mode: 'all' | 'any';
      /** The groups a host must be in for `all` (sources other than start). */
      members: string[];
    })
  | (StepBase & {
      kind: 'target';
      /** The inventory_target pattern the work runs on (AFD-14). */
      pattern: string;
      todo: string;
      maxFail?: number;
    });

export interface Engine {
  readonly id: string;
  generate(doc: FlowDocument, options: GenerateOptions): GenerateResult;
}
