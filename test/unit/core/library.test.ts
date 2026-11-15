// AFD-295: shared subflows from an Ansible Flow Server library: `afs://` sources, pinned to the
// library flow's version and commit, checked against the library as the server lists it; the
// local check leaves them alone.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { type LibrarySubflow, libraryFindings, usesLibrary } from '../../../src/core/flow/library';
import { buildModel } from '../../../src/core/flow/model';
import { parseLibraryRef, refDesign, subflowsOf } from '../../../src/core/flow/refs';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { sharedFindings } from '../../../src/node/sharedRefs';
import { readExample } from './helpers';

const ctx = { newId: createIdFactory() };
const schema = createSchemaValidator();
const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx);
const doc = (text: string) => parse(text) as FlowDocument;
const SOURCE = doc(readExample('os-upgrade.flow.yaml'));
const upgradeOs = subflowsOf(SOURCE).find((s) => s.path === 'upgrade-os')?.node as FlowNode;
const TARGET = run(readExample('edge-baseline.flow.yaml'), { kind: 'upgradeFormat' }).text;
const FROM = 'afs://platform/library/flows/os-upgrade.flow.yaml#upgrade-os';
const COMMIT = '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b';
const NEWER = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';
const node = (text: string, key: string) =>
  [...buildModel(doc(text)).nodes.values()].find((e) => e.node.key === key)?.node as FlowNode;
const offered = (version: number, commit = COMMIT): LibrarySubflow => ({
  from: FROM,
  workspace: 'platform',
  project: 'library',
  file: 'flows/os-upgrade.flow.yaml',
  path: 'upgrade-os',
  title: 'Upgrade OS',
  flow: 'OS upgrade',
  version,
  commit,
});

describe('library subflows (AFD-295)', () => {
  it('reads an afs:// source: workspace, project, file and key path', () => {
    expect(parseLibraryRef(FROM)).toEqual({
      workspace: 'platform',
      project: 'library',
      file: 'flows/os-upgrade.flow.yaml',
      key: 'upgrade-os',
    });
    expect(parseLibraryRef('../x.flow.yaml#a')).toBeUndefined();
    expect(parseLibraryRef('afs://platform/x.flow.yaml#a')).toBeUndefined();
  });

  it('a copy from the library is pinned to its version and commit; Update takes a newer one', () => {
    const added = run(TARGET, {
      kind: 'addReference',
      from: FROM,
      version: 3,
      source: upgradeOs,
      commit: COMMIT,
    });
    const copy = node(added.text, 'upgrade-os');
    expect(copy.ref).toEqual({ from: FROM, version: 3, design: refDesign(copy), commit: COMMIT });
    expect(schema(doc(added.text))).toEqual([]);
    expect(usesLibrary(doc(added.text))).toBe(true);

    // The library as listed: same version, nothing; newer, information; gone, a warning.
    expect(libraryFindings(doc(added.text), [offered(3)])).toEqual([]);
    expect(libraryFindings(doc(added.text), [offered(4, NEWER)])).toEqual([
      expect.objectContaining({ code: 'shared-source', severity: 'info', node: copy.id }),
    ]);
    expect(libraryFindings(doc(added.text), [])).toEqual([
      expect.objectContaining({ code: 'shared-source', severity: 'warning' }),
    ]);
    // Without a listing (no server, out of reach) nothing is said.
    expect(libraryFindings(doc(added.text), undefined)).toEqual([]);
    // The local check leaves library copies to the library.
    expect(sharedFindings('/repo/flows/edge/edge.flow.yaml', doc(added.text), '/repo')).toEqual([]);

    const updated = run(added.text, {
      kind: 'updateReference',
      id: copy.id,
      version: 4,
      source: upgradeOs,
      commit: NEWER,
    });
    expect(node(updated.text, 'upgrade-os').ref).toMatchObject({ version: 4, commit: NEWER });
    expect(() =>
      run(TARGET, { kind: 'addReference', from: FROM, version: 3, source: upgradeOs, commit: 'x' }),
    ).toThrow(/not a commit/);
  });
});
