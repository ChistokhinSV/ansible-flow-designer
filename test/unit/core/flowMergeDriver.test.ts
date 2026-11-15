// AFD-283: the merge driver's parts: three texts merged into ours's text, a file that is not a
// flow handed back to git's text merge, the merge left for a person kept in the git folder, and
// the .gitattributes lines added once.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { messageProblem } from '../../../src/core/messageCheck';
import {
  mergeFlowTexts,
  mergeStatePath,
  readMergeState,
  removeMergeState,
  withMergeAttributes,
  writeMergeState,
} from '../../../src/node/flowMerge';
import { readExample } from './helpers';

const BASE = readExample('edge-baseline.flow.yaml');
const retitle = (text: string, from: string, to: string) =>
  text.replace(`  title: ${from}\n`, `  title: ${to}\n`);
const dir = mkdtempSync(join(tmpdir(), 'afd-merge-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the merge driver (AFD-283)', () => {
  it('merges three texts into ours, and says what needs a person', () => {
    const ours = `# ours\n${retitle(BASE, 'Validate', 'Validate it')}`;
    const theirs = retitle(BASE, 'Backup config', 'Back up the config');
    const clean = mergeFlowTexts(BASE, ours, theirs);
    expect(clean.kind).toBe('merged');
    if (clean.kind !== 'merged') return;
    expect(clean.merge.conflicts).toEqual([]);
    expect(clean.broken).toEqual([]);
    expect(clean.text).toContain('# ours\n');
    expect(clean.text).toContain('title: Back up the config');
    expect(clean.text).toContain('title: Validate it');

    const both = mergeFlowTexts(BASE, ours, retitle(BASE, 'Validate', 'Check it'));
    if (both.kind !== 'merged') throw new Error('not merged');
    expect(both.merge.conflicts.map((c) => c.label)).toEqual(['Validate it: title']);
    expect(both.text).toContain('title: Validate it');
    expect(both.text).not.toContain('<<<<');
    const id = both.merge.conflicts[0]?.id as string;
    const chosen = mergeFlowTexts(BASE, ours, retitle(BASE, 'Validate', 'Check it'), {
      [id]: 'theirs',
    });
    expect(chosen.kind === 'merged' && chosen.text).toContain('title: Check it');
  });

  it('a text that is not a flow goes back to git', () => {
    expect(mergeFlowTexts(BASE, 'flow: [broken\n', BASE)).toEqual({
      kind: 'not-flows',
      why: 'ours is not a flow this can read',
    });
  });

  it('a merge left for a person waits in the git folder, never the work tree', () => {
    const state = {
      file: 'flows/edge-baseline.flow.yaml',
      base: BASE,
      ours: BASE,
      theirs: BASE,
      choices: { 'node:x:title': 'theirs' as const },
      at: '2026-11-15T10:00:00Z',
    };
    writeMergeState(dir, state);
    expect(mergeStatePath(dir, state.file)).toBe(
      join(dir, 'afd-merge', 'flows%2Fedge-baseline.flow.yaml.json'),
    );
    expect(readMergeState(dir, state.file)).toEqual(state);
    removeMergeState(dir, state.file);
    expect(readMergeState(dir, state.file)).toBeUndefined();
  });

  it('.gitattributes gets the flow lines once, keeping what it had', () => {
    const once = withMergeAttributes('*.png binary\n');
    expect(once).toBe(
      '*.png binary\n# Flows merge by their steps, not their lines (Ansible Flow Designer)\n*.flow.yaml merge=ansible-flow\n*.flow.yml merge=ansible-flow\n',
    );
    expect(withMergeAttributes(once as string)).toBeUndefined();
    expect(withMergeAttributes('')).toMatch(/^# Flows merge/);
  });

  it('a choice from the designer must name a side', () => {
    expect(messageProblem({ type: 'mergeChoose', id: 'node:x:title', side: 'theirs' })).toBe(
      undefined,
    );
    expect(messageProblem({ type: 'mergeChoose', id: 'node:x:title', side: 'both' })).toBe(
      'mergeChoose: bad choice',
    );
  });
});
