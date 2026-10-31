// Text of a new flow: start → end and a host_list input that seeds the start node. No positions:
// the canvas lays the flow out until the first move or Tidy up writes them (AFD-23).
import { renderBlock, renderScalar } from '../yaml/render';
import type { IdFactory } from './ids';

export function newFlowText(name: string, key: string, newId: IdFactory): string {
  const [flowId, start, end, edge] = [newId(), newId(), newId(), newId()];
  const header = [
    'schema_version: 1',
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
