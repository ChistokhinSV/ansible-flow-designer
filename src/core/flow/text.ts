// A flow document as the text of a flow file (AFD-37: shared by every writer of new flows: the
// importers, the AI tools, the commands; it lived with the AWX import before).
import { renderBlock, type YamlValue } from '../yaml/render';
import type { FlowDocument } from './types';

/** The flow file's text (block style, two-space indent, indentless sequences as in the examples). */
export function flowText(doc: FlowDocument, eol: '\n' | '\r\n' = '\n'): string {
  const lines = renderBlock(doc as unknown as YamlValue, 0, {
    eol,
    indentUnit: 2,
    seqIndentless: true,
  });
  return `${lines.join(eol)}${eol}`;
}
