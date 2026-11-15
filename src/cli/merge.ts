// The git merge driver for flow files (AFD-283), shipped as dist/afd-merge.js. Ansible Flow: Set
// Up Flow Merging puts it into the repository (.afd/afd-merge.js) with, in .gitattributes,
//   *.flow.yaml merge=ansible-flow
// and in the clone's git settings
//   git config merge.ansible-flow.name "Ansible Flow Designer flow merge"
//   git config merge.ansible-flow.driver "node .afd/afd-merge.js %O %A %B %P"
// git calls it with the common version, ours (where the result goes), theirs and the file's path.
// Exit 0: merged. Exit 1: the file is left for a person, with no text markers: a flow the
// designer opens, saying what to choose. A file that is not a flow is merged as text by git.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mergeFlowTexts, removeMergeState, writeMergeState } from '../node/flowMerge';

const [basePath, oursPath, theirsPath, named] = process.argv.slice(2);
if (!basePath || !oursPath || !theirsPath) {
  console.error('Usage: afd-merge.js <base> <ours> <theirs> [<path in the repository>]');
  console.error(
    'A git merge driver: git config merge.ansible-flow.driver "node .afd/afd-merge.js %O %A %B %P"',
  );
  process.exit(2);
}

const file = named ?? oursPath;
const read = (p: string) => readFileSync(p, 'utf8');
const [base, ours, theirs] = [read(basePath), read(oursPath), read(theirsPath)];
const merged = mergeFlowTexts(base, ours, theirs);

if (merged.kind === 'not-flows') {
  // What git would have done: the text, with markers where both sides changed a line.
  console.error(`${file}: ${merged.why}; merged as text`);
  const text = spawnSync(
    'git',
    ['merge-file', '-L', 'ours', '-L', 'base', '-L', 'theirs', oursPath, basePath, theirsPath],
    { stdio: 'inherit' },
  );
  process.exit(text.status === 0 ? 0 : 1);
}

writeFileSync(oursPath, merged.text);
const gitDir = (() => {
  try {
    return resolve(execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim());
  } catch {
    return undefined;
  }
})();
const { conflicts } = merged.merge;
if (!conflicts.length && !merged.broken.length) {
  if (gitDir) removeMergeState(gitDir, file);
  process.exit(0);
}
if (gitDir)
  writeMergeState(gitDir, {
    file,
    base,
    ours,
    theirs,
    choices: {},
    at: new Date().toISOString(),
  });
for (const c of conflicts) console.error(`${file}: ${c.label}`);
for (const b of merged.broken) console.error(`${file}: the merged flow breaks a rule: ${b}`);
console.error(
  `${file}: ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}; open it in the designer to choose (ours is in the file for now)`,
);
process.exit(1);
