// AFD-323: repositories of flows inside a folder that is not one, found to offer them as workspace
// folders: a server project's clone and a repository with flows; not a repository without flows,
// not what is inside a repository, nothing when the folder is a repository itself.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nestedRepoOf, nestedRepos } from '../../../src/node/runner/nestedRepos';

describe('nestedRepos', () => {
  let root = '';
  const at = (...parts: string[]) => join(root, ...parts);
  const repo = (path: string) => mkdirSync(at(path, '.git'), { recursive: true });
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'afd-323-'));
    // A server project's clone, two levels down, with JSONC settings.
    repo('newfolder/test-sample');
    mkdirSync(at('newfolder/test-sample/.vscode'), { recursive: true });
    writeFileSync(
      at('newfolder/test-sample/.vscode/settings.json'),
      '{\n  // the server\n  "afd.runner.url": "https://flows.example.net:9443",\n  "afd.runner.project": "network/edge",\n}\n',
    );
    // A repository with a flow and no server.
    repo('afdtest');
    mkdirSync(at('afdtest/flows/fw'), { recursive: true });
    writeFileSync(at('afdtest/flows/fw/fw.flow.yaml'), 'schema_version: 2\n');
    // A repository without flows, and a flow inside a repository's own folder.
    repo('notes');
    repo('afdtest/vendor/inner');
    writeFileSync(at('loose.flow.yaml'), 'schema_version: 2\n');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds the clone of a server project and a repository with flows, nothing else', () => {
    expect(nestedRepos(root).map((r) => [r.name, r.server, r.project])).toEqual([
      ['afdtest', undefined, undefined],
      ['test-sample', 'https://flows.example.net:9443', 'network/edge'],
    ]);
  });

  it("AFD-324: a file's repository below the workspace folder, not the folder's own", () => {
    expect(nestedRepoOf(at('afdtest/flows/fw/fw.flow.yaml'), root)).toBe(at('afdtest'));
    expect(nestedRepoOf(at('newfolder/test-sample'), root)).toBe(at('newfolder/test-sample'));
    expect(nestedRepoOf(at('loose.flow.yaml'), root)).toBeUndefined();
    // Inside a repository that is the workspace folder: that one is VS Code's to read.
    expect(nestedRepoOf(at('afdtest/flows/fw/fw.flow.yaml'), at('afdtest'))).toBeUndefined();
  });

  it('answers nothing for a repository, and stops at the depth', () => {
    expect(nestedRepos(at('afdtest'))).toEqual([]);
    expect(nestedRepos(root, 1).map((r) => r.name)).toEqual(['afdtest']);
  });
});
