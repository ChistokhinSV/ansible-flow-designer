// AFD-320: the history reader, on git's own output and on a real repository made for the test.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commitMatches,
  parseLog,
  readLog,
  repositoryRoot,
  textAtCommit,
} from '../../../../src/node/history/gitLog';

const commit = (fields: string[], files: string) => `\x1e${fields.join('\x1f')}\x1f\x00\n${files}`;

describe('parseLog', () => {
  it('reads commits, merges without files, renames and a body', () => {
    const text =
      commit(
        [
          'a'.repeat(40),
          'b'.repeat(40),
          'Dana Ops',
          'dana@example.net',
          '2026-11-12T10:00:00+01:00',
          'Rename the check',
          'Line one\nLine two\n',
        ],
        'M\0flows/a/a.flow.yaml\0R087\0flows/a/old.scenarios.yaml\0flows/a/a.scenarios.yaml\0',
      ) +
      commit(
        [
          'b'.repeat(40),
          `${'c'.repeat(40)} ${'d'.repeat(40)}`,
          'Sam Net',
          'sam@example.net',
          '2026-11-11T09:00:00+01:00',
          "Merge branch 'x'",
          '',
        ],
        '',
      );
    const [first, merge] = parseLog(text);
    expect(first?.parents).toEqual(['b'.repeat(40)]);
    expect(first?.body).toBe('Line one\nLine two');
    expect(first?.files).toEqual([
      { status: 'M', path: 'flows/a/a.flow.yaml' },
      { status: 'R', path: 'flows/a/a.scenarios.yaml', from: 'flows/a/old.scenarios.yaml' },
    ]);
    expect(merge?.parents).toHaveLength(2);
    expect(merge?.files).toEqual([]);
  });

  it('filters on every word, in message, author, hash or path', () => {
    const [c] = parseLog(
      commit(
        ['abc1234', '', 'Dana Ops', 'dana@example.net', '2026-11-12', 'Add rollback', ''],
        'A\0flows/fw/fw.flow.yaml\0',
      ),
    );
    expect(c && commitMatches(c, 'dana fw.flow')).toBe(true);
    expect(c && commitMatches(c, 'ROLLBACK abc12')).toBe(true);
    expect(c && commitMatches(c, 'dana sam')).toBe(false);
  });
});

describe('readLog on a repository', () => {
  let root = '';
  const run = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'afd-320-'));
    run('init', '-q', '-b', 'main');
    for (const [k, v] of [
      ['user.name', 'Dana Ops'],
      ['user.email', 'dana@example.net'],
      ['core.autocrlf', 'false'],
    ] as const)
      run('config', k, v);
    writeFileSync(join(root, 'a.flow.yaml'), 'one\n');
    writeFileSync(join(root, 'notes.txt'), 'n\n');
    run('add', '.');
    run('commit', '-q', '-m', 'First');
    writeFileSync(join(root, 'a.flow.yaml'), 'two\n');
    run('commit', '-q', '-am', 'Second');
    writeFileSync(join(root, 'notes.txt'), 'm\n');
    run('commit', '-q', '-am', 'Notes only');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('pages, narrows to paths, and reads a file at a commit and before it', async () => {
    const all = await readLog(root);
    expect(all.map((c) => c.subject)).toEqual(['Notes only', 'Second', 'First']);
    expect((await readLog(root, { skip: 1, max: 1 })).map((c) => c.subject)).toEqual(['Second']);
    const flow = await readLog(root, { paths: ['a.flow.yaml', 'a.scenarios.yaml'] });
    expect(flow.map((c) => c.subject)).toEqual(['Second', 'First']);
    const second = flow[0]?.hash as string;
    expect(await textAtCommit(root, second, 'a.flow.yaml')).toBe('two\n');
    expect(await textAtCommit(root, `${second}^`, 'a.flow.yaml')).toBe('one\n');
    expect(await textAtCommit(root, '--output=x', 'a.flow.yaml')).toBeUndefined();
    expect(await textAtCommit(root, second, 'missing.txt')).toBeUndefined();
    expect((await repositoryRoot(root))?.toLowerCase().replace(/\\/g, '/')).toBe(
      root.toLowerCase().replace(/\\/g, '/'),
    );
  });

  it('answers no commits for a repository without any', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'afd-320-empty-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: empty });
      expect(await readLog(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
