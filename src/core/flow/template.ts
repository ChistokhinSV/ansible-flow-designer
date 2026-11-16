// Text of a new flow: start → end and a host_list input that seeds the start node. No positions:
// the canvas lays the flow out until the first move or Tidy up writes them (AFD-23).
import { renderBlock, renderScalar } from '../yaml/render';
import { CURRENT_FORMAT } from './format';
import type { IdFactory } from './ids';

export function newFlowText(name: string, key: string, newId: IdFactory): string {
  const [flowId, start, end, edge] = [newId(), newId(), newId(), newId()];
  const header = [
    `schema_version: ${CURRENT_FORMAT}`,
    'flow:',
    `  id: ${flowId}`,
    `  key: ${key}`,
    `  name: ${renderScalar(name)}`,
    '  version: 1',
  ];
  const body = renderBlock(
    {
      inputs: { devices: { type: 'host_list', required: true, targets: true } },
    },
    2,
    { eol: '\n', indentUnit: 2, seqIndentless: true },
  );
  const rest = renderBlock(
    {
      nodes: [
        { id: start, key: 'start', type: 'start', title: 'Start' },
        { id: end, key: 'done', type: 'end', title: 'Done', outcome: 'success' },
      ],
      edges: [{ id: edge, from: { node: start, port: 'ok_hosts' }, to: { node: end, port: 'in' } }],
    },
    0,
    { eol: '\n', indentUnit: 2, seqIndentless: true },
  );
  return `${[...header, ...body, ...rest].join('\n')}\n`;
}

/**
 * AFD-304: a flow's text as a copy of it: its own id, key and name, version 1. Only the `flow:`
 * header changes; the nodes keep their ids (they are the flow's own).
 */
export function copiedFlowText(text: string, name: string, key: string, newId: IdFactory): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^flow:\s*$/.test(l.replace(/\r$/, '')));
  if (start < 0) throw new Error('This file has no flow header');
  let end = start + 1;
  while (end < lines.length && /^(\s|\r?$)/.test(lines[end] ?? '')) end++;
  const set = (field: string, value: string) => {
    for (let i = start + 1; i < end; i++) {
      const line = lines[i] ?? '';
      if (line.startsWith(`  ${field}:`)) {
        lines[i] = `  ${field}: ${value}${line.endsWith('\r') ? '\r' : ''}`;
        return;
      }
    }
  };
  set('id', newId());
  set('key', key);
  set('name', renderScalar(name));
  set('version', '1');
  return lines.join('\n');
}
