import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import { exampleFlows, readExample } from './helpers';

const validate = createSchemaValidator();

describe('flow schema (v1 + additive fields)', () => {
  it.each(exampleFlows())('accepts $name unchanged', ({ text }) => {
    expect(validate(parse(text))).toEqual([]);
  });

  it('accepts the additive fields of ADR-0004', () => {
    const doc = parse(readExample('edge-baseline.flow.yaml'));
    doc.flow.inputs.devices.targets = true;
    doc.nodes.push(
      { id: '01JC0000000000000000000001', key: 'fan', type: 'parallel', title: 'Fan', branches: 3 },
      {
        id: '01JC0000000000000000000002',
        key: 'merge',
        type: 'join',
        title: 'Merge',
        join_mode: 'any',
      },
    );
    doc.nodes[5].handler = 'rollback';
    doc.edges.push({
      id: '01JC0000000000000000000003',
      from: { node: '01JC0000000000000000000001', port: 'branch_3' },
      to: { node: '01JC0000000000000000000002', port: 'in' },
    });
    expect(validate(doc)).toEqual([]);
  });

  it('rejects unknown node fields, bad enums and bad IDs with pointers', () => {
    const doc = parse(readExample('edge-baseline.flow.yaml'));
    doc.nodes[1].colour = 'red';
    doc.nodes[2].type = 'loop';
    doc.edges[0].id = 'not-a-ulid';
    doc.nodes[3].handler = 'panic';
    const issues = validate(doc);
    const pointers = issues.map((i) => i.pointer);
    expect(pointers).toContain('/nodes/1');
    expect(pointers).toContain('/nodes/2/type');
    expect(pointers).toContain('/edges/0/id');
    expect(pointers).toContain('/nodes/3/handler');
    expect(issues.find((i) => i.pointer === '/nodes/1')?.message).toBe('unknown field "colour"');
  });

  it('allows digits in port names but not a leading digit or uppercase', () => {
    const doc = parse(readExample('edge-baseline.flow.yaml'));
    doc.edges[0].from.port = 'ok_hosts2';
    expect(validate(doc)).toEqual([]);
    doc.edges[0].from.port = '2ok';
    expect(validate(doc).map((i) => i.pointer)).toContain('/edges/0/from/port');
  });
});
