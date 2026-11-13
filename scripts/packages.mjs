// Stages the npm packages other hosts use (ADR-0036) in dist/packages/<name>/, each with a manifest
// written from the root package.json.
//   --check  also packs each one (dry run) and uses it from a plain Node script and a TypeScript
//            file, as another repository would
//   --pack   also writes the tarballs the release publishes to out/npm/
//   --publish  packs, then publishes from this terminal the packages whose version is not on npm
//            yet, with your npm login and its two-factor prompt: for a package's first version
//            (a release publishes by Trusted Publishing, which needs the package to exist)
import { execFileSync, execSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { build, buildSync, transformSync } from 'esbuild';
import { build as viteBuild } from 'vite';

const check = process.argv.includes('--check');
const publish = process.argv.includes('--publish');
const pack = publish || process.argv.includes('--pack');
const root = process.cwd();
const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'));
const OUT = join('dist', 'packages');
const TARBALLS = join('out', 'npm');
const SCOPE = '@ansible-flow';
const DOCS = 'https://github.com/ChistokhinSV/ansible-flow-designer/blob/main/docs/packages.md';
const FIXTURE = resolve('samples/hello.flow.yaml');
const TSC = join('node_modules', 'typescript', 'bin', 'tsc');

/**
 * One row per package, in the order they are published (a package after the ones it depends on).
 *
 * A code package is built from a layer (`src`):
 * - `outside`: folders besides its own whose files it may import and carry (the schemas);
 * - `uses`: layers that are packages of their own; an import into one stays an import of that
 *   package;
 * - `programs`: modules that do their work when loaded, so `--check` does not import them;
 * - `smoke`, `typed`: what `--check` runs and type-checks after importing every module.
 *
 * A files package (`copy`) is folders copied as they are, with an index that says where they are.
 *
 * A web package (`web`) is one browser bundle and its stylesheet, built by Vite as the VSIX's
 * webview is, from another entry; `web.types` are the modules whose types it publishes, the first
 * as the package's own.
 */
const PACKAGES = [
  {
    name: 'core',
    src: 'src/core',
    platform: 'neutral',
    target: 'es2023',
    lib: ['es2023', 'dom', 'dom.iterable'],
    types: [],
    outside: ['schema'],
    uses: [],
    programs: [],
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
const issues = createSchemaValidator()(parsed.doc);
const result = validateFlow(parsed.doc, issues);
const code = engineFor(parsed.doc).generate(parsed.doc, { source: 'hello.flow.yaml' });
if (modelOf(parsed.doc) !== modelOf(parsed.doc)) throw new Error('two models for one document');
if (!code.files.length) throw new Error('no generated files');
// The repository's own sample is a correct flow: reading it wrong would show as errors here.
const errors = result.findings.filter((f) => f.severity === 'error');
if (errors.length) throw new Error('errors in a correct flow: ' + errors[0].message);
console.log('  flow: ' + result.findings.length + ' findings, ' + code.files.length + ' generated files');
`,
    typed: `
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
  {
    name: 'assets',
    copy: [
      { from: 'probe/afd_probe', to: 'probe/afd_probe' },
      { from: 'probe/callback_plugins', to: 'probe/callback_plugins' },
      { from: 'schema', to: 'schema' },
      // AFD-280: the exchanges with Ansible Flow Server both sides replay.
      { from: 'contract', to: 'contract' },
    ],
    description:
      'Ansible Flow Designer files a host passes by path: the Python probe, the run events callback, the JSON schemas and the contract with Ansible Flow Server.',
    smoke: `
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { contractDir, probeDir, schemaDir } from '${SCOPE}/assets';

for (const file of [
  join(probeDir, 'afd_probe', 'serve.py'),
  join(probeDir, 'callback_plugins', 'afd_events.py'),
  join(schemaDir, 'flow.schema.json'),
  join(schemaDir, 'scenarios.schema.json'),
  join(contractDir, 'server-api.json'),
  join(contractDir, 'repo', 'flows', 'hello.flow.yaml'),
]) if (!existsSync(file)) throw new Error('missing ' + file);
console.log('  probe, schemas and contract found by path');
`,
    typed: `
import { contractDir, probeDir, schemaDir } from '${SCOPE}/assets';

export const dirs: string[] = [probeDir, schemaDir, contractDir];
`,
  },
  {
    name: 'node',
    src: 'src/node',
    platform: 'node',
    target: 'node22',
    lib: ['es2023'],
    types: ['node'],
    outside: [],
    uses: [{ dir: 'src/core', name: 'core' }],
    programs: ['ssh/sshRun', 'catalog/catalogWorker'],
    description:
      'Ansible Flow Designer for Node hosts: layout, the probe client, runs, the AWX client, the module catalog and SSH.',
    smoke: `
import { readFileSync } from 'node:fs';
import { parseFlow } from '${SCOPE}/core/flow/document';
import { modelOf, ROOT } from '${SCOPE}/core/flow/model';
import { layoutLevel } from '${SCOPE}/node/autoLayout';
import { KEEP_RUNS } from '${SCOPE}/node/run/storage';

const parsed = parseFlow(readFileSync(process.argv[2], 'utf8'));
if (!parsed.doc) throw new Error('the fixture flow did not parse');
const level = modelOf(parsed.doc).levels.get(ROOT);
const positions = await layoutLevel(level);
if (!Object.keys(positions).length) throw new Error('no positions from the layout');
console.log('  layout: ' + Object.keys(positions).length + ' nodes placed; keeps ' + KEEP_RUNS + ' runs');
`,
    typed: `
import { parseFlow } from '${SCOPE}/core/flow/document';
import { modelOf, ROOT } from '${SCOPE}/core/flow/model';
import { layoutLevel } from '${SCOPE}/node/autoLayout';
import { ProbeClient } from '${SCOPE}/node/env/probeClient';

const doc = parseFlow('').doc;
const level = doc ? modelOf(doc).levels.get(ROOT) : undefined;
export const placed = level ? layoutLevel(level) : undefined;
export type Client = ProbeClient;
`,
  },
  {
    name: 'designer',
    src: 'src/webview',
    web: { entry: 'mount.tsx', types: ['mount', 'transport'] },
    lib: ['es2023', 'dom', 'dom.iterable'],
    types: ['vite/client'],
    uses: [{ dir: 'src/core', name: 'core' }],
    description:
      'Ansible Flow Designer for a web page: the flow canvas and its panels, talking to a host over a transport the page supplies.',
    smoke: `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(import.meta.resolve('${SCOPE}/designer/index.css')), 'utf8');
if (!css.includes('.react-flow')) throw new Error('the stylesheet lacks the canvas styles');
if (!css.includes('codicon')) throw new Error('the stylesheet lacks the icon font');
console.log('  stylesheet has the canvas styles and the icon font');
`,
    typed: `
import { type DesignerTransport, type MountedDesigner, mount } from '${SCOPE}/designer';
import type { HostMessage, WebviewMessage } from '${SCOPE}/core/protocol';

const sent: WebviewMessage[] = [];
const listeners = new Set<(m: HostMessage) => void>();
const transport: DesignerTransport = {
  hostName: 'The server',
  post: (m) => sent.push(m),
  subscribe: (l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  getState: () => undefined,
  setState: () => undefined,
};
export const mounted: MountedDesigner = mount(document.body, { transport, theme: 'auto' });
`,
  },
];

const slash = (path) => path.split(sep).join('/');

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

const inside = (path, dir) => path === dir || path.startsWith(dir + sep);

/** `yaml` of `yaml`, `ajv` of `ajv/dist/2020.js`, `@xyflow/system` of `@xyflow/system/x`. */
const packageOf = (spec) =>
  spec
    .split('/')
    .slice(0, spec.startsWith('@') ? 2 : 1)
    .join('/');

/**
 * The package module an import into another layer means: `../core/yaml` from src/node is
 * `@ansible-flow/core/yaml/index`, because a module is named by its file.
 */
function moduleOf(target, uses) {
  const layer = resolve(root, uses.dir);
  const file = existsSync(`${target}.ts`) ? target : join(target, 'index');
  return `${SCOPE}/${uses.name}/${slash(relative(layer, file))}`;
}

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
          const uses = pkg.uses.find((u) => inside(target, resolve(root, u.dir)));
          if (uses) {
            used.add(`${SCOPE}/${uses.name}`);
            return { path: moduleOf(target, uses), external: true };
          }
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

/** Type files import other layers by relative path; in a package that is the other package. */
function retarget(pkg, dist) {
  if (!pkg.uses.length) return;
  for (const file of files(dist).filter((f) => f.endsWith('.d.ts'))) {
    const source = dirname(resolve(root, pkg.src, relative(dist, file)));
    const text = readFileSync(file, 'utf8');
    const next = text.replace(/(from\s+|import\()(['"])(\.[^'"]*)\2/g, (all, lead, quote, spec) => {
      const target = resolve(source, spec);
      const uses = pkg.uses.find((u) => inside(target, resolve(root, u.dir)));
      return uses ? `${lead}${quote}${moduleOf(target, uses)}${quote}` : all;
    });
    if (next !== text) writeFileSync(file, next);
  }
}

function manifest(pkg, fields) {
  return `${JSON.stringify(
    {
      name: `${SCOPE}/${pkg.name}`,
      version: rootPkg.version,
      description: pkg.description,
      license: rootPkg.license,
      homepage: DOCS,
      repository: rootPkg.repository,
      bugs: rootPkg.bugs,
      type: 'module',
      ...fields,
      publishConfig: { access: 'public' },
    },
    null,
    2,
  )}\n`;
}

function readme(pkg, example) {
  return `# ${SCOPE}/${pkg.name}

${pkg.description}

Built from [Ansible Flow Designer](${rootPkg.repository.url.replace(/\.git$/, '')}) ${rootPkg.version}
and released with it. ${example}

What is in the package, which entry points are documented and what may change:
[docs/packages.md](${DOCS}).
`;
}

async function stageCode(pkg, dir) {
  const dist = join(dir, 'dist');
  const entries = files(pkg.src).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  const used = new Set();
  // Every file is an entry and shared code goes to chunks, so each module exists once however it
  // is imported: modelOf's cache and identity checks need that (ADR-0036).
  const built = await build({
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
    metafile: true,
    logLevel: 'warning',
  });
  // The borders let nothing else in; this says so about what was built, not about the rules.
  const mine = [pkg.src, ...pkg.outside].map((d) => `${d}/`);
  const stray = Object.keys(built.metafile.inputs).filter(
    (f) => !mine.some((d) => f.startsWith(d)),
  );
  if (stray.length) throw new Error(`${pkg.name} carries ${stray.join(', ')}`);

  // Types in the same tree. rootDir is the repository, because the core imports schema/*.json.
  const types = `.types-${pkg.name}`;
  const tsconfig = join(OUT, `tsconfig.${pkg.name}.json`);
  rmSync(join(OUT, types), { recursive: true, force: true });
  writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: slash(relative(OUT, 'tsconfig.base.json')),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: slash(relative(OUT, '.')),
        outDir: types,
        lib: pkg.lib,
        types: pkg.types,
      },
      include: [slash(relative(OUT, pkg.src))],
    }),
  );
  execFileSync(process.execPath, [TSC, '-p', tsconfig], { stdio: 'inherit' });
  cpSync(join(OUT, types, pkg.src), dist, { recursive: true });
  rmSync(join(OUT, types), { recursive: true, force: true });
  rmSync(tsconfig);
  retarget(pkg, dist);

  // Another package of this repository at exactly this version; the rest as the root pins them.
  const dependencies = Object.fromEntries(
    [...used]
      .sort()
      .map((name) => [
        name,
        name.startsWith(`${SCOPE}/`) ? rootPkg.version : rootPkg.dependencies[name],
      ]),
  );
  writeFileSync(
    join(dir, 'package.json'),
    manifest(pkg, {
      exports: {
        './package.json': './package.json',
        './*': { types: './dist/*.d.ts', default: './dist/*.js' },
      },
      files: ['dist'],
      ...(pkg.platform === 'node' ? { engines: { node: '>=22.13' } } : {}),
      dependencies,
    }),
  );
  const modules = entries.map((f) => slash(relative(pkg.src, f)).replace(/\.ts$/, ''));
  writeFileSync(
    join(dir, 'README.md'),
    readme(
      pkg,
      `Modules are imported by their path in the source tree, for example\n\`${SCOPE}/${pkg.name}/${modules[0]}\`.`,
    ),
  );
  console.log(
    `${SCOPE}/${pkg.name} ${rootPkg.version}: ${modules.length} modules, depends on ${Object.keys(dependencies).join(', ') || 'nothing'}`,
  );
  return modules.filter((m) => !pkg.programs.includes(m)).map((m) => `${SCOPE}/${pkg.name}/${m}`);
}

function stageFiles(pkg, dir) {
  for (const { from, to } of pkg.copy)
    cpSync(from, join(dir, to), {
      recursive: true,
      filter: (src) => !src.includes('__pycache__') && !src.endsWith('.pyc'),
    });
  const folders = [...new Set(pkg.copy.map((c) => c.to.split('/')[0]))];
  // Hosts hand these folders to Python and to schema tools by path, so the package says where
  // they are instead of each host working it out from its own node_modules.
  writeFileSync(
    join(dir, 'index.js'),
    `import { fileURLToPath } from 'node:url';

${folders.map((f) => `export const ${f}Dir = fileURLToPath(new URL('./${f}', import.meta.url));`).join('\n')}
`,
  );
  writeFileSync(
    join(dir, 'index.d.ts'),
    `${folders.map((f) => `/** The folder \`${f}/\` of this package, as a path. */\nexport declare const ${f}Dir: string;`).join('\n')}\n`,
  );
  writeFileSync(
    join(dir, 'package.json'),
    manifest(pkg, {
      exports: {
        '.': { types: './index.d.ts', default: './index.js' },
        './package.json': './package.json',
      },
      files: ['index.js', 'index.d.ts', ...folders],
      engines: { node: '>=22.13' },
    }),
  );
  writeFileSync(
    join(dir, 'README.md'),
    readme(
      pkg,
      `The folders are found by path: \`import { ${folders.map((f) => `${f}Dir`).join(', ')} } from '${SCOPE}/${pkg.name}'\`.`,
    ),
  );
  const count = folders.reduce((n, f) => n + files(join(dir, f)).length, 0);
  console.log(`${SCOPE}/${pkg.name} ${rootPkg.version}: ${count} files in ${folders.join(', ')}`);
  return [`${SCOPE}/${pkg.name}`];
}

async function stageWeb(pkg, dir) {
  const dist = join(dir, 'dist');
  // The VSIX's webview build (vite.config.mts) with the entry a web page uses.
  await viteBuild({
    configFile: 'vite.config.mts',
    mode: 'production',
    logLevel: 'warn',
    build: {
      outDir: resolve(dist),
      emptyOutDir: true,
      lib: {
        entry: pkg.web.entry,
        formats: ['es'],
        fileName: () => 'index.js',
        cssFileName: 'index',
      },
    },
  });
  // As build.mjs does for the VSIX (AFD-223): library mode leaves whitespace and comments in.
  const bundle = join(dist, 'index.js');
  writeFileSync(
    bundle,
    transformSync(readFileSync(bundle, 'utf8'), { minify: true, format: 'esm', target: 'es2023' })
      .code,
  );

  // A page loads this one file: it must export mount and import nothing.
  const [shape] = Object.values(
    buildSync({
      entryPoints: [bundle],
      bundle: true,
      write: false,
      metafile: true,
      packages: 'external',
      format: 'esm',
      logLevel: 'silent',
    }).metafile.outputs,
  );
  if (!shape.exports.includes('mount')) throw new Error(`${pkg.name}: the bundle has no mount`);
  if (shape.imports.length)
    throw new Error(
      `${pkg.name}: the bundle imports ${shape.imports.map((i) => i.path).join(', ')}`,
    );

  // Types of the entry and what its signature names; the core's types come from the core package.
  const types = `.types-${pkg.name}`;
  const tsconfig = join(OUT, `tsconfig.${pkg.name}.json`);
  rmSync(join(OUT, types), { recursive: true, force: true });
  writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: slash(relative(OUT, 'tsconfig.base.json')),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: slash(relative(OUT, '.')),
        outDir: types,
        lib: pkg.lib,
        jsx: 'react-jsx',
        types: pkg.types,
      },
      files: [slash(relative(OUT, join(pkg.src, pkg.web.entry)))],
    }),
  );
  execFileSync(process.execPath, [TSC, '-p', tsconfig], { stdio: 'inherit' });
  const [own, ...others] = pkg.web.types;
  copyFileSync(join(OUT, types, pkg.src, `${own}.d.ts`), join(dist, 'index.d.ts'));
  for (const name of others)
    copyFileSync(join(OUT, types, pkg.src, `${name}.d.ts`), join(dist, `${name}.d.ts`));
  rmSync(join(OUT, types), { recursive: true, force: true });
  rmSync(tsconfig);
  retarget(pkg, dist);
  // The entry imports its stylesheets for their effect; a type file has no use for that.
  for (const f of files(dist).filter((f) => f.endsWith('.d.ts')))
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^import\s+['"][^'"]+['"];\r?\n/gm, ''));
  const left = files(dist)
    .filter((f) => f.endsWith('.d.ts'))
    .flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/from\s+['"](\.[^'"]*)['"]/g)]
        .map((m) => m[1])
        .filter((spec) => !existsSync(join(dirname(f), `${spec}.d.ts`)))
        .map((spec) => `${relative(dist, f)} imports ${spec}`),
    );
  if (left.length) throw new Error(`${pkg.name}: types not in the package: ${left.join('; ')}`);

  writeFileSync(
    join(dir, 'package.json'),
    manifest(pkg, {
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './index.css': './dist/index.css',
        './package.json': './package.json',
      },
      files: ['dist', 'THIRD_PARTY_NOTICES.md'],
      // For the types of the messages only: the bundle carries the code it runs.
      dependencies: { [`${SCOPE}/core`]: rootPkg.version },
    }),
  );
  copyFileSync('THIRD_PARTY_NOTICES.md', join(dir, 'THIRD_PARTY_NOTICES.md'));
  writeFileSync(
    join(dir, 'README.md'),
    readme(
      pkg,
      `Load \`${SCOPE}/${pkg.name}/index.css\` and call \`mount(element, { transport })\` from \`${SCOPE}/${pkg.name}\`.
The designer is made to be the whole page: give it a page or an iframe of its own.`,
    ),
  );
  const size = (f) => Math.round(statSync(join(dist, f)).size / 1024);
  console.log(
    `${SCOPE}/${pkg.name} ${rootPkg.version}: index.js ${size('index.js')} KB, index.css ${size('index.css')} KB`,
  );
  return [];
}

async function stage(pkg) {
  const dir = join(OUT, pkg.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const modules = pkg.copy
    ? stageFiles(pkg, dir)
    : pkg.web
      ? await stageWeb(pkg, dir)
      : await stageCode(pkg, dir);
  copyFileSync('LICENSE', join(dir, 'LICENSE'));
  return { dir, modules };
}

/** Packs the package (dry run) and uses it by name from Node and from TypeScript. */
function verify(pkg, staged) {
  const packed = JSON.parse(
    execSync('npm pack --dry-run --json', { cwd: staged.dir, encoding: 'utf8' }),
  )[0];
  if (!packed.files.some((f) => f.path.endsWith('.d.ts')))
    throw new Error(`${pkg.name}: the packed files have no types`);
  console.log(`  packed: ${packed.files.length} files, ${Math.round(packed.size / 1024)} KB`);

  // node_modules/@ansible-flow/<name> beside the staged packages, so they resolve by name; their
  // other dependencies resolve from the repository's node_modules, further up.
  const scope = join(OUT, 'node_modules', SCOPE);
  mkdirSync(scope, { recursive: true });
  rmSync(join(scope, pkg.name), { recursive: true, force: true });
  symlinkSync(resolve(staged.dir), join(scope, pkg.name), 'junction');

  // A browser bundle has no modules to load in Node; its smoke reads the built files instead.
  const every = join(OUT, `smoke-${pkg.name}-modules.mjs`);
  writeFileSync(every, `${staged.modules.map((m) => `await import('${m}');`).join('\n')}\n`);
  if (staged.modules.length) {
    execFileSync(process.execPath, [every], { stdio: 'inherit' });
    console.log(`  imported ${staged.modules.length} modules in Node`);
  }

  const smoke = join(OUT, `smoke-${pkg.name}.mjs`);
  writeFileSync(smoke, pkg.smoke);
  execFileSync(process.execPath, [smoke, FIXTURE], { stdio: 'inherit' });

  const typed = join(OUT, `smoke-${pkg.name}.ts`);
  writeFileSync(typed, pkg.typed);
  const tsconfig = join(OUT, `tsconfig.smoke-${pkg.name}.json`);
  writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: slash(relative(OUT, 'tsconfig.base.json')),
      compilerOptions: { lib: pkg.lib ?? ['es2023'], types: pkg.types ?? ['node'] },
      files: [`smoke-${pkg.name}.ts`],
    }),
  );
  execFileSync(process.execPath, [TSC, '-p', tsconfig], { stdio: 'inherit' });
  console.log('  type-checked a file that imports it');
  for (const file of [every, smoke, typed, tsconfig]) rmSync(file);
}

mkdirSync(OUT, { recursive: true });
if (pack) {
  rmSync(TARBALLS, { recursive: true, force: true });
  mkdirSync(TARBALLS, { recursive: true });
}
const order = [];
for (const pkg of PACKAGES) {
  const staged = await stage(pkg);
  if (check) verify(pkg, staged);
  if (pack) {
    const [{ filename }] = JSON.parse(
      execSync(`npm pack --json --pack-destination "${resolve(TARBALLS)}"`, {
        cwd: staged.dir,
        encoding: 'utf8',
      }),
    );
    order.push(`${SCOPE}/${pkg.name}@${rootPkg.version} ${filename}`);
  }
}
// The release publishes the tarballs in this order, a package after the ones it depends on. Each
// line is `<name>@<version> <file>`.
if (pack) writeFileSync(join(TARBALLS, 'order.txt'), `${order.join('\n')}\n`);
console.log(`Staged in ${OUT}${pack ? `, packed in ${TARBALLS}` : ''}`);

if (publish) {
  for (const line of order) {
    const [spec, tarball] = line.split(' ');
    let onNpm = true;
    try {
      execSync(`npm view ${spec} version`, { stdio: 'ignore' });
    } catch {
      onNpm = false;
    }
    if (onNpm) {
      console.log(`${spec} is already on npm; left as is`);
      continue;
    }
    // npm asks for the second factor itself; nothing is read or kept here.
    execSync(`npm publish "${join(TARBALLS, tarball)}" --access public`, { stdio: 'inherit' });
  }
}
