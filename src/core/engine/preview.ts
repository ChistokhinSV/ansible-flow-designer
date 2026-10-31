// What a node compiles to, for the inspector (mockup 03), plus the engine's findings for the canvas.
import type { FlowDocument, Ulid } from '../flow/types';
import type { Finding } from '../flow/validate';
import { engineFor } from './engines';

export interface CodePreview {
  /** Generated play text per node (its own lines from its level file). */
  plays: Record<Ulid, string>;
  /** Engine findings the validator does not already report. */
  findings: Finding[];
}

export function codePreview(doc: FlowDocument, source: string): CodePreview {
  const result = engineFor(doc).generate(doc, { source });
  const plays: Record<Ulid, string> = {};
  for (const [node, range] of Object.entries(result.plays)) {
    const file = result.files.find((f) => f.name === range.file);
    if (file) plays[node] = file.text.split('\n').slice(range.start, range.end).join('\n');
  }
  return {
    plays,
    findings: result.findings.filter((f) => f.code !== 'codegen-no-targets'),
  };
}
