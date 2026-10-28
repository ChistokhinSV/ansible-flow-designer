// Writes THIRD_PARTY_NOTICES.md: every production dependency bundled into dist/ with its license.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const tree = JSON.parse(
  execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], { encoding: 'utf8', shell: true }),
);
const seen = new Map();
const walk = (deps = {}) => {
  for (const [name, info] of Object.entries(deps)) {
    const manifest = join('node_modules', name, 'package.json');
    // Optional peers that are not installed (e.g. immer for zustand) are not bundled.
    if (!info.version || !existsSync(manifest)) continue;
    // Type packages are compile-time only.
    if (name.startsWith('@types/') || name === 'csstype') continue;
    const id = `${name}@${info.version}`;
    if (!seen.has(id)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      const license =
        typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see package');
      seen.set(id, { name, version: info.version, license });
    }
    walk(info.dependencies);
  }
};
walk(tree.dependencies);
const rows = [...seen.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, i]) => `| ${i.name} | ${i.version} | ${i.license} |`);
writeFileSync(
  'THIRD_PARTY_NOTICES.md',
  `# Third-party notices

Ansible Flow Designer bundles the following packages into \`dist/\`. Each is used under its own
license; full texts are in each package's repository.

- elkjs is dual-licensed (EPL-2.0 OR GPL-3.0-or-later); it is used under EPL-2.0 and bundled unmodified.
- @vscode/codicons: the icon font is licensed under CC BY 4.0 (Microsoft), the code under MIT.

| Package | Version | License |
|---|---|---|
${rows.join('\n')}
`,
);
console.log(`${seen.size} packages`);
