// Stages the npm packages other hosts use (ADR-0036) in dist/packages/<name>/, each with a manifest
// written from the root package.json. `--check` also packs each one (dry run) and uses it from a
// plain Node script and a TypeScript file, as another repository would.
import { execFileSync, execSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';

const check = process.argv.includes('--check');
const root = process.cwd();
const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'));
const OUT = join('dist', 'packages');
const SCOPE = '@ansible-flow';
const DOCS = 'https://github.com/ChistokhinSV/ansible-flow-designer/blob/main/docs/packages.md';

/**
 * One row per package. `outside` lists the folders, besides its own, a layer may import from.
 * `smoke` is what `--check` runs after importing every module of the package.
 */
const PACKAGES = [
  {
    name: 'core',
    src: 'src/core',
    platform: 'neutral',
    target: 'es2023',
    lib: ['es2023', 'dom', 'dom.iterable'],
    outside: ['schema'],
    description:
      'Ansible Flow Designer core: the flow model, commands, validation and playbook generation, for any JavaScript host.',
    smoke: `
import { readFileSync } from 'node:fs';
import { engineFor } from '${SCOPE}/core/engine/engines';
import { parseFlow } from '${SCOPE}/core/flow/document';
import { modelOf } from '${SCOPE}/core/flow/model';
import { createSchemaValidator } from '${SCOPE}/core/flow/schema';
import { validateFlow } from '${SCOPE}/core/flow/validate';

const parsed = parseFlow(readFileSync(process.argv[2], 'utf8'));
if (!parsed.doc) throw new Error('the fixture flow did not parse');
const issues = createSchemaValidator()(parsed.file);
const result = validateFlow(parsed.doc, issues);
const code = engineFor(parsed.doc).generate(parsed.doc, { source: 'annotated.flow.yaml' });
if (modelOf(parsed.doc) !== modelOf(parsed.doc)) throw new Error('two models for one document');
if (!code.files.length) throw new Error('no generated files');
console.log('  flow: ' + result.findings.length + ' findings, ' + code.files.length + ' generated files');
`,
    types: `
import { engineFor } from '${SCOPE}/core/engine/engines';
import { parseFlow } from '${SCOPE}/core/flow/document';
import type { FlowDocument } from '${SCOPE}/core/flow/types';
import type { HostMessage } from '${SCOPE}/core/protocol';

const doc: FlowDocument | undefined = parseFlow('').doc;
export const files: string[] = doc
  ? engineFor(doc).generate(doc, { source: 'a.flow.yaml' }).files.map((f) => f.name)
  : [];
export const kind: HostMessage['type'] = 'snapshot';
`,
  },
];

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

const inside = (path, dir) => path === dir || path.startsWith(dir + sep);

/** `yaml` of `yaml`, `ajv` of `ajv/dist/2020`, `@xyflow/system` of `@xyflow/system/x`. */
const packageOf = (spec) =>
  spec
    .split('/')
    .slice(0, spec.startsWith('@') ? 2 : 1)
    .join('/');

/**
 * Keeps a layer inside its borders and notes the packages it needs. A relative import must stay in
 * the layer or in a folder the row allows; a bare import must be a dependency of the root
 * package.json, because that is where its version is read from.
 * @returns {import('esbuild').Plugin}
 */
function borders(pkg, used) {
  const layer = resolve(root, pkg.src);
  const allowed = pkg.outside.map((dir) => resolve(root, dir));
  return {
    name: 'borders',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        const from = relative(root, args.importer);
        if (args.path.startsWith('.')) {
          const target = resolve(args.resolveDir, args.path);
          if (inside(target, layer) || allowed.some((dir) => inside(target, dir))) return undefined;
          return { errors: [{ text: `${from} imports ${args.path}, outside ${pkg.src}` }] };
        }
        const builtin = args.path.startsWith('node:') || builtinModules.includes(args.path);
        if (builtin) {
          if (pkg.platform === 'node') return { external: true };
          return {
            errors: [{ text: `${from} imports ${args.path}: ${pkg.src} runs in a browser` }],
          };
        }
        const name = packageOf(args.path);
        if (!rootPkg.dependencies[name])
          return {
            errors: [{ text: `${from} imports ${name}, not a dependency in package.json` }],
          };
        used.add(name);
        return { external: true };
      });
    },
  };
}

async function stage(pkg) {
  const dir = join(OUT, pkg.name);
  const dist = join(dir, 'dist');
  rmSync(dir, { recursive: true, force: true });
  const entries = files(pkg.src).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  const used = new Set();
  // Every file is an entry and shared code goes to chunks, so each module exists once however it
  // is imported: modelOf's cache and identity checks need that (ADR-0036).
  await build({
    entryPoints: entries,
    outbase: pkg.src,
    outdir: dist,
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: pkg.platform,
    target: pkg.target,
    plugins: [borders(pkg, used)],
    sourcemap: 'linked',
    logLevel: 'warning',
  });

  // Types in the same tree. rootDir is the repository, because the core imports schema/*.json.
  const types = join(OUT, `.types-${pkg.name}`);
  rmSync(types, { recursive: true, force: true });
  const tsconfig = join(OUT, `tsconfig.${pkg.name}.json`);
  writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: relative(OUT, 'tsconfig.base.json').split(sep).join('/'),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: relative(OUT, '.').split(sep).join('/'),
        outDir: `.types-${pkg.name}`,
        lib: pkg.lib,
        types: [],
      },
      include: [relative(OUT, pkg.src).split(sep).join('/')],
    }),
  );
  execFileSync(
    process.execPath,
    [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', tsconfig],
    {
      stdio: 'inherit',
    },
  );
  cpSync(join(types, pkg.src), dist, { recursive: true });
  rmSync(types, { recursive: true, force: true });
  rmSync(tsconfig);

  const dependencies = Object.fromEntries(
    [...used].sort().map((name) => [name, rootPkg.dependencies[name]]),
  );
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: `${SCOPE}/${pkg.name}`,
        version: rootPkg.version,
        description: pkg.description,
        license: rootPkg.license,
        homepage: DOCS,
        repository: rootPkg.repository,
        bugs: rootPkg.bugs,
        type: 'module',
        exports: {
          './package.json': './package.json',
          './*': { types: './dist/*.d.ts', default: './dist/*.js' },
        },
        files: ['dist'],
        ...(pkg.platform === 'node' ? { engines: { node: '>=22.13' } } : {}),
        dependencies,
        publishConfig: { access: 'public', provenance: true },
      },
      null,
      2,
    )}\n`,
  );
  copyFileSync('LICENSE', join(dir, 'LICENSE'));
  writeFileSync(
    join(dir, 'README.md'),
    `# ${SCOPE}/${pkg.name}

${pkg.description}

Built from [Ansible Flow Designer](${rootPkg.repository.url.replace(/\.git$/, '')}) ${rootPkg.version}
and released with it. Modules are imported by their path in the source tree, for example
\`${SCOPE}/${pkg.name}/${relative(pkg.src, entries[0]).split(sep).join('/').replace(/\.ts$/, '')}\`.

What is in the package, which entry points are documented and what may change:
[docs/packages.md](${DOCS}).
`,
  );
  const modules = entries.map((f) =>
    relative(pkg.src, f).split(sep).join('/').replace(/\.ts$/, ''),
  );
  console.log(
    `${SCOPE}/${pkg.name} ${rootPkg.version}: ${modules.length} modules, depends on ${Object.keys(dependencies).join(', ') || 'nothing'}`,
  );
  return { dir, modules };
}

/** Packs the package (dry run) and uses it by name from Node and from TypeScript. */
function verify(pkg, staged) {
  const packed = JSON.parse(
    execSync('npm pack --dry-run --json', { cwd: staged.dir, encoding: 'utf8' }),
  )[0];
  if (!packed.files.some((f) => f.path.startsWith('dist/') && f.path.endsWith('.d.ts')))
    throw new Error(`${pkg.name}: the packed files have no types`);
  console.log(`  packed: ${packed.files.length} files, ${Math.round(packed.size / 1024)} KB`);

  // node_modules/@ansible-flow/<name> beside the staged packages, so they resolve by name; their
  // own dependencies resolve from the repository's node_modules, further up.
  const scope = join(OUT, 'node_modules', SCOPE);
  mkdirSync(scope, { recursive: true });
  rmSync(join(scope, pkg.name), { recursive: true, force: true });
  symlinkSync(resolve(staged.dir), join(scope, pkg.name), 'junction');

  const every = join(OUT, `smoke-${pkg.name}-modules.mjs`);
  writeFileSync(
    every,
    `${staged.modules.map((m) => `await import('${SCOPE}/${pkg.name}/${m}');`).join('\n')}\n`,
  );
  execFileSync(process.execPath, [every], { stdio: 'inherit' });
  console.log(`  imported ${staged.modules.length} modules in Node`);

  const smoke = join(OUT, `smoke-${pkg.name}.mjs`);
  writeFileSync(smoke, pkg.smoke);
  execFileSync(process.execPath, [smoke, resolve('test/fixtures/flows/annotated.flow.yaml')], {
    stdio: 'inherit',
  });

  const typed = join(OUT, `smoke-${pkg.name}.ts`);
  writeFileSync(typed, pkg.types);
  const tsconfig = join(OUT, `tsconfig.smoke-${pkg.name}.json`);
  writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: relative(OUT, 'tsconfig.base.json').split(sep).join('/'),
      compilerOptions: { lib: pkg.lib, types: [] },
      files: [`smoke-${pkg.name}.ts`],
    }),
  );
  execFileSync(
    process.execPath,
    [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', tsconfig],
    {
      stdio: 'inherit',
    },
  );
  console.log('  type-checked a file that imports it');
  for (const file of [every, smoke, typed, tsconfig]) rmSync(file);
}

mkdirSync(OUT, { recursive: true });
for (const pkg of PACKAGES) {
  const staged = await stage(pkg);
  if (check) verify(pkg, staged);
}
console.log(`Staged in ${OUT}`);
