// Text of a new flow: start → end, a host_list input that seeds the start node, and positions.
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
      layout: { [start]: { x: 0, y: 0 }, [end]: { x: 36, y: 160 } },
    },
    0,
    { eol: '\n', indentUnit: 2, seqIndentless: true },
  );
  return `${[...header, ...body, ...rest].join('\n')}\n`;
}
