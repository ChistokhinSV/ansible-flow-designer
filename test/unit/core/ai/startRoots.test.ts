// AFD-173: where the MCP server works when the agent sends no roots. Cursor starts global servers
// in the home folder; walking it listed flows of other projects and took 19 s.
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startRoots } from '../../../../src/mcp/fsIO';
import { CURSOR_WORKSPACE } from '../../../../src/node/ai/writers';

const home = resolve('/home/u');
const work = join(home, 'repo');
const sep = process.platform === 'win32' ? ';' : ':';
const dirs = new Set([work, join(home, 'other')]);
const isDir = (p: string) => dirs.has(p);

describe('startRoots', () => {
  it('takes AFD_MCP_ROOTS, leaving out unresolved variables and missing folders', () => {
    expect(
      startRoots(
        [CURSOR_WORKSPACE, work, join(home, 'gone'), join(home, 'other')].join(sep),
        home,
        home,
        isDir,
      ),
    ).toEqual([work, join(home, 'other')]);
  });

  it('works in the working directory when it is a project folder', () => {
    expect(startRoots(undefined, work, home, isDir)).toEqual([work]);
    expect(startRoots(CURSOR_WORKSPACE, work, home, isDir)).toEqual([work]);
  });

  it('has no folder in the home folder or a drive root', () => {
    expect(startRoots(undefined, home, home, isDir)).toEqual([]);
    expect(startRoots('', resolve('/'), home, isDir)).toEqual([]);
  });
});
