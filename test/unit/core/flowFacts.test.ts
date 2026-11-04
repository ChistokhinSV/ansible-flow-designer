// AFD-86: the Flows view's facts per flow (problems, code state) and its folders.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { engineFor } from '../../../src/core/engine/engines';
import { parseFlow } from '../../../src/core/flow/document';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import { factsLine, flowFacts, flowTree } from '../../../src/core/view/flowFacts';

const schema = createSchemaValidator();
const text = readFileSync(join(__dirname, '../../../samples/hello.flow.yaml'), 'utf8');
const doc = parseFlow(text).doc;
const files = engineFor(doc as NonNullable<typeof doc>).generate(doc as NonNullable<typeof doc>, {
  source: 'hello.flow.yaml',
}).files;
const dirOf = (entries: Record<string, string>) => ({
  read: async (name: string) => entries[name],
  list: async () => Object.keys(entries),
});
const current = Object.fromEntries(files.map((f) => [f.name, f.text]));
const facts = (entries: Record<string, string>, t = text) =>
  flowFacts(t, schema, dirOf(entries), { source: 'hello.flow.yaml' });

describe('flowFacts', () => {
  it('a flow whose code matches says nothing more than its name', async () => {
    const f = await facts(current);
    expect(f).toMatchObject({ name: 'Hello, Ansible', errors: 0, code: 'current' });
    expect(factsLine(f)).toBe('');
  });

  it('no code yet, code out of date, code edited by hand', async () => {
    expect((await facts({})).code).toBe('no code yet');
    // Code generated from an older version of the flow, untouched since: a save rewrites it.
    const older = parseFlow(text.replace('Say hello', 'Say hi')).doc as NonNullable<typeof doc>;
    const was = engineFor(older).generate(older, { source: 'hello.flow.yaml' }).files;
    const stale = await facts(Object.fromEntries(was.map((f) => [f.name, f.text])));
    expect(stale.code).toBe('out of date');
    expect(factsLine(stale)).toBe('code out of date');
    // A generated file changed in an editor: its checksum no longer matches, a save leaves it alone.
    const root = files[0]?.name as string;
    const hand = await facts({ ...current, [root]: `${current[root]}# changed by hand\n` });
    expect(hand).toMatchObject({ code: 'edited by hand', kept: [root] });
    expect(factsLine(hand)).toBe('code edited by hand');
  });

  it('errors block the code; a file that does not parse says so', async () => {
    const broken = await facts({}, 'flow: [');
    expect(broken.broken).toBeTruthy();
    expect(factsLine(broken)).toBe('does not parse');
    const bad = await facts(current, text.replace(/port: in\b/, 'port: nowhere'));
    expect(bad.errors).toBeGreaterThan(0);
    expect(bad.code).toBe('blocked');
    expect(factsLine(bad)).toMatch(/^\d+ errors?/);
  });
});

describe('flowTree', () => {
  it('folders, with the New Flow layout (a folder named after its flow) folded into its parent', () => {
    const tree = flowTree([
      'flows/hello/hello.flow.yaml',
      'flows/network/ntp-baseline.flow.yaml',
      'flows/network/branch-health.flow.yaml',
      'site.flow.yaml',
    ]);
    expect(tree.flows).toEqual(['site.flow.yaml']);
    const flows = tree.folders[0];
    expect(flows?.name).toBe('flows');
    expect(flows?.flows).toEqual(['flows/hello/hello.flow.yaml']);
    expect(flows?.folders.map((f) => [f.path, f.flows.length])).toEqual([['flows/network', 2]]);
  });
});
