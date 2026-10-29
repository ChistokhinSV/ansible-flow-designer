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

export interface GenerateResult {
  ok: boolean;
  files: GeneratedFile[];
  findings: Finding[];
  routes: Record<string, Route>;
  plays: Record<Ulid, PlayRange>;
}

export interface Engine {
  readonly id: string;
  generate(doc: FlowDocument, options: GenerateOptions): GenerateResult;
}
