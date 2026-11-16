// AFD-303: which flows of a connected folder are the server project's.
import { describe, expect, it } from 'vitest';
import { porcelainPaths, sameText, serverFlows } from '../../../src/core/view/serverFlows';

describe('serverFlows', () => {
  it('says same, changed here, newer on the server, only here, and what the folder lacks', () => {
    const r = serverFlows(
      ['flows/a.flow.yaml', 'flows/b.flow.yaml', 'flows/c.flow.yaml', 'mine.flow.yaml'],
      ['flows/a.flow.yaml', 'flows/b.flow.yaml', 'flows/c.flow.yaml', 'flows/z.flow.yaml'],
      new Set(['flows/b.flow.yaml', 'flows/c.flow.yaml']),
      new Set(['flows/b.flow.yaml', 'mine.flow.yaml']),
    );
    expect(Object.fromEntries(r.states)).toEqual({
      'flows/a.flow.yaml': 'same',
      'flows/b.flow.yaml': 'changed',
      'flows/c.flow.yaml': 'newer',
      'mine.flow.yaml': 'local',
    });
    expect(r.missing).toEqual(['flows/z.flow.yaml']);
  });

  it('text is the same whatever line ends git checked out', () => {
    expect(sameText('a: 1\r\nb: 2\r\n', 'a: 1\nb: 2\n')).toBe(true);
    expect(sameText('a: 1\n', 'a: 2\n')).toBe(false);
  });
});

describe('porcelainPaths', () => {
  it('reads changed, untracked and both sides of a rename, a leading space kept', () => {
    const z = ' M flows/a.flow.yaml\0?? new.flow.yaml\0R  b2.flow.yaml\0b.flow.yaml\0';
    expect(porcelainPaths(z)).toEqual([
      'flows/a.flow.yaml',
      'new.flow.yaml',
      'b2.flow.yaml',
      'b.flow.yaml',
    ]);
  });
});
