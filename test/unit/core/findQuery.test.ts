// AFD-86: Find filters list steps by kind and state across levels (round 1: P9, 16.8 minutes).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { findNodes } from '../../../src/core/view/find';
import { findCompletions, parseFind } from '../../../src/core/view/findQuery';

const doc = parse(
  readFileSync(join(__dirname, '../../../samples/firewall-upgrade.flow.yaml'), 'utf8'),
) as FlowDocument;
const model = buildModel(doc);
const ctx = { openPorts: openFailPorts(model), findings: [] };
const keys = (q: string) => findNodes(model, q, 200, ctx).map((r) => r.key);

describe('parseFind', () => {
  it('words and filters; quoted values; an unknown key or an empty value stays a word', () => {
    expect(parseFind('backup type:task status:Draft')).toEqual({
      words: ['backup'],
      filters: { type: ['task'], status: ['draft'] },
    });
    expect(parseFind('tag:"pre check" foo:bar status:')).toEqual({
      words: ['foo:bar', 'status:'],
      filters: { tag: ['pre check'] },
    });
  });
});

describe('findNodes with filters', () => {
  it('a filter alone lists every step that passes it, on every level', () => {
    const approvals = findNodes(model, 'type:approval', 200, ctx);
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.every((r) => r.type === 'approval')).toBe(true);
    const drafts = findNodes(model, 'status:draft', 200, ctx);
    const all = [...model.nodes.values()].filter(
      (e) => (e.node.status ?? 'draft') === 'draft' && !['start', 'end'].includes(e.node.type),
    );
    expect(drafts.map((r) => r.id).sort()).toEqual(all.map((e) => e.node.id).sort());
    // A step inside a subflow is found with its trail.
    expect(findNodes(model, 'status:specified', 200, ctx).some((r) => r.trail.length > 0)).toBe(
      true,
    );
  });

  it('filters and words together; two values of one filter mean either', () => {
    const both = keys('type:task type:approval');
    expect(both.length).toBe(keys('type:task').length + keys('type:approval').length);
    expect(keys('type:approval approve')).toEqual(
      keys('type:approval').filter((k) => k.includes('approv')),
    );
    expect(keys('open:fail').length).toBe(new Set(ctx.openPorts.map((p) => p.node)).size);
  });

  it('has:no-binding lists the tasks the card calls "not implemented yet", no subflow (AFD-89)', () => {
    const unbound = findNodes(model, 'has:no-binding', 200, ctx);
    const expected = [...model.nodes.values()].filter(
      (e) => e.node.type === 'task' && !e.node.impl,
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(unbound.map((r) => r.id).sort()).toEqual(expected.map((e) => e.node.id).sort());
    expect(unbound.every((r) => r.type === 'task')).toBe(true);
  });
});

describe('findCompletions', () => {
  it('completes a filter name, then its values', () => {
    expect(findCompletions('sta')).toEqual(['status:']);
    expect(findCompletions('backup status:dr')).toEqual(['status:draft']);
    expect(findCompletions('type:')).toContain('type:approval');
    expect(findCompletions('')).toEqual([]);
  });
});
