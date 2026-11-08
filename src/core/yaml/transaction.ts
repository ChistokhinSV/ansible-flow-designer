// Composes several YAML ops on one text: each op is applied and the text re-parsed before the next,
// then the whole change is reported as minimal edits against the original text.
import { applyEdits, diffEdits, type TextEdit } from './edits';
import type { OpResult } from './ops';
import { parseYaml, type YamlFile } from './parse';

export class YamlEditError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'YamlEditError';
  }
}

export class YamlTransaction {
  private file: YamlFile;

  /** `parsed` may be passed when the caller already holds the parse of `original` (saves a parse). */
  constructor(
    readonly original: string,
    parsed?: YamlFile,
  ) {
    this.file = parsed?.text === original ? parsed : parseYaml(original);
    if (this.file.errors.length > 0) {
      throw new YamlEditError('parse', `document has YAML errors: ${this.file.errors[0]?.message}`);
    }
  }

  get current(): YamlFile {
    return this.file;
  }

  apply(op: (file: YamlFile) => OpResult): this {
    return this.applyAll([op]);
  }

  /**
   * Applies independent ops computed against the same parse, then re-parses once. Parsing dominates
   * command latency, so commands batch whatever does not depend on an earlier op's result. The ops
   * must touch disjoint regions (inserts at one offset keep their order).
   */
  applyAll(ops: readonly ((file: YamlFile) => OpResult)[]): this {
    if (ops.length === 0) return this;
    const edits = ops.flatMap((op) => {
      const result = op(this.file);
      if (!result.ok) throw new YamlEditError(result.code, result.reason);
      return result.edits;
    });
    let text: string;
    try {
      text = applyEdits(this.file.text, edits);
    } catch (e) {
      // AFD-160: two ops on one region are a command's bug; report it as an edit error, which
      // callers turn into a message, not a plain Error.
      throw new YamlEditError('overlap', (e as Error).message);
    }
    const next = parseYaml(text);
    // Never hand VS Code text that no longer parses.
    if (next.errors.length > 0) {
      throw new YamlEditError('broken', `edit would break the YAML: ${next.errors[0]?.message}`);
    }
    this.file = next;
    return this;
  }

  get text(): string {
    return this.file.text;
  }

  edits(): TextEdit[] {
    return diffEdits(this.original, this.file.text);
  }
}
