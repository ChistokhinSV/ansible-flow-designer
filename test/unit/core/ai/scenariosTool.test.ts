// AFD-117: flow_scenarios: scenario tests for AI assistants by key. List and check in the
// simulation; add (expectations from the simulation), update, accept new ends and delete write the
// file; a scenario that does not fit is not written; describe and validate mention scenarios.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type FlowIO, runTool } from '../../../../src/core/ai/handlers';
import { createIdFactory } from '../../../../src/core/flow/ids';
import { createSchemaValidator } from '../../../../src/core/flow/schema';

const FLOW = 'routing-levels.flow.yaml';
const read = (p: string) => readFileSync(join(__dirname, '../../../fixtures/engine', p), 'utf8');

function memoryIO(scenarios?: string) {
  const files = new Map<string, string>([[FLOW, read(FLOW)]]);
  if (scenarios !== undefined) files.set('routing-levels.scenarios.yaml', scenarios);
  const io: FlowIO & { files: Map<string, string> } = {
    files,
    list: async () => [FLOW],
    read: async (p) => {
      const t = files.get(p);
      if (t === undefined) throw new Error(`No flow ${p}`);
      return t;
    },
    write: async (p, _b, after) => {
      files.set(p, after);
      return { text: after, notes: [] };
    },
    create: async () => {
      throw new Error('no');
    },
    ops: () => ({ newId: createIdFactory() }),
    schema: createSchemaValidator(),
    readScenarios: async (_p, key) => files.get(`${key}.scenarios.yaml`),
    writeScenarios: async (_p, key, before, after) => {
      expect(files.get(`${key}.scenarios.yaml`)).toBe(before);
      files.set(`${key}.scenarios.yaml`, after);
      return ['Saved.'];
    },
  };
  return io;
}
const tool = (io: FlowIO, input: Record<string, unknown>) =>
  runTool(io, 'flow_scenarios', { path: FLOW, ...input });

describe('flow_scenarios (AFD-117)', () => {
  it('adds a scenario with the simulated ends, and lists it with what it plants', async () => {
    const io = memoryIO();
    expect((await tool(io, {})).text).toContain('no scenarios yet (routing-levels.scenarios.yaml');
    const add = await tool(io, {
      action: 'add',
      name: 'gate fails for h02',
      hosts: ['h01', 'h02'],
      force: { gate: { failed: ['h02'] } },
    });
    expect(add.isError).toBeUndefined();
    expect(add.text).toContain(
      'Added "gate fails for h02" (created routing-levels.scenarios.yaml):',
    );
    expect(add.text).toContain(
      "Expect: h01 → done (Done), h02 → gate.failed_hosts (Gate's open failed_hosts).",
    );
    expect(add.text).toContain('Saved.');
    expect(io.files.get('routing-levels.scenarios.yaml')).toContain('devices: [h01, h02]');
    const list = await tool(io, { action: 'list' });
    expect(list.text).toContain(
      '1 scenario(s) in routing-levels.scenarios.yaml: all pass (simulated).',
    );
    expect(list.text).toContain('- "gate fails for h02": pass. Hosts: h01, h02.');
    expect(list.text).toContain('Plants: gate failed [h02].');
  });

  it('says where a host now ends when the scenario fails, and accepts the new ends', async () => {
    const io = memoryIO(read('routing-levels.scenarios.yaml'));
    const third = 'a failed stage is handled, a failed gate stops the host there';
    const upd = await tool(io, {
      action: 'update',
      name: third,
      expect: { h01: 'done', h02: 'failed', h03: 'done', h04: 'done', h05: 'done' },
    });
    expect(upd.text).toContain(
      "h03 ends at gate.failed_hosts (Gate's open failed_hosts); expected done (Done).",
    );
    expect(upd.text).toContain('3 scenario(s), 1 failing (simulated).');
    const accept = await tool(io, { action: 'update', name: third, accept_ends: true });
    expect(accept.text).toContain('all pass (simulated)');
    const renamed = await tool(io, { action: 'update', name: third, rename: 'stage and gate' });
    expect(renamed.text).toContain('Updated "stage and gate"');
    const del = await tool(io, { action: 'delete', name: 'stage and gate' });
    expect(del.text).toContain('Deleted "stage and gate".');
    expect(del.text).toContain('2 scenario(s), all pass');
  });

  it('writes nothing that does not fit the flow', async () => {
    const io = memoryIO();
    const bad = await tool(io, {
      action: 'add',
      name: 'x',
      hosts: ['h01'],
      force: { nowhere: { failed: ['h01'] } },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Not written; the scenario does not fit the flow:');
    expect(bad.text).toContain('No step nowhere');
    expect(io.files.has('routing-levels.scenarios.yaml')).toBe(false);
    expect((await tool(io, { action: 'add', name: 'x' })).text).toContain('Give the hosts');
    expect((await tool(io, { action: 'delete', name: 'x' })).text).toContain('No scenario "x"');
    expect((await tool(io, { action: 'verify' })).text).toContain('not available here');
  });

  it('flow_describe says how the scenarios stand; flow_validate names a failing one', async () => {
    const io = memoryIO(
      read('routing-levels.scenarios.yaml').replace('h03: gate.failed_hosts', 'h03: done'),
    );
    const d = await runTool(io, 'flow_describe', { path: FLOW });
    expect(d.text).toContain('Scenarios: 3 (1 failing, simulated); flow_scenarios lists them.');
    const v = await runTool(io, 'flow_validate', { path: FLOW });
    expect(v.text).toContain('Scenarios:');
    expect(v.text).toContain(
      '- warning scenario-miss: "a failed stage is handled, a failed gate stops the host there" fails in the simulation: h03 ends at gate.failed_hosts',
    );
    // No scenarios file: nothing about them.
    expect((await runTool(memoryIO(), 'flow_describe', { path: FLOW })).text).not.toContain(
      'Scenarios:',
    );
  });
});
