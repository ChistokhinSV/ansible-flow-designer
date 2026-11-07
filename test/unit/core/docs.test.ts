// AFD-22: the user guide, the walkthroughs and the samples stay whole. Links and images resolve,
// every command and setting is documented, command links name real commands, generated pages are
// current, and the samples validate and generate.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GUIDE_NOTE, REPO, vsixReadme } from '../../../scripts/vsix-readme';
import { guideReferenceFiles } from '../../../src/core/ai/reference';
import { optionA } from '../../../src/core/engine/optionA';
import { planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { CURRENT_FORMAT, formatOf } from '../../../src/core/flow/migrate';
import { flowText } from '../../../src/core/flow/text';
import type { FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { importPlaybook } from '../../../src/core/import/playbook';
import { type PlaybookForm, readPlaybook, scanFolder } from '../../../src/core/import/source';
import { HELP } from '../../../src/webview/helpPages';
import { fsSource } from './helpers';

const ROOT = resolve(__dirname, '../../..');
const GUIDE = join(ROOT, 'docs', 'guide');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const contributed = new Set<string>(
  pkg.contributes.commands.map((c: { command: string }) => c.command),
);
/** VS Code's own commands the walkthroughs use. */
const BUILT_IN = new Set(['workbench.action.chat.open', 'workbench.action.openSettings']);
const settings = Object.keys(pkg.contributes.configuration.properties);

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}
const pages = [...markdownFiles(GUIDE), ...markdownFiles(join(ROOT, 'media', 'walkthrough'))];
const rel = (p: string) => relative(ROOT, p).replaceAll('\\', '/');

/** Markdown links and images: [text](target) and ![alt](target). */
function targets(text: string): string[] {
  return [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1] as string);
}

interface Step {
  id: string;
  description: string;
  media: { image?: Record<string, string>; markdown?: string; altText?: string };
  completionEvents?: string[];
}
const walkthroughs: { id: string; steps: Step[] }[] = pkg.contributes.walkthroughs;

function commandLinks(text: string): { id: string; args?: unknown }[] {
  return [...text.matchAll(/\(command:([\w.]+)(?:\?([^)\s]+))?\)/g)].map((m) => ({
    id: m[1] as string,
    args: m[2] ? JSON.parse(decodeURIComponent(m[2])) : undefined,
  }));
}

describe('user guide', () => {
  it('every relative link and image resolves', () => {
    const broken: string[] = [];
    for (const page of pages) {
      for (const target of targets(readFileSync(page, 'utf8'))) {
        if (/^(https?|command|mailto):/.test(target) || target.startsWith('#')) continue;
        const file = target.split('#')[0] as string;
        if (!existsSync(join(dirname(page), file))) broken.push(`${rel(page)} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every page is reachable from the index, and every image is used', () => {
    const linked = new Set<string>();
    const images = new Set<string>();
    for (const page of pages)
      for (const target of targets(readFileSync(page, 'utf8'))) {
        const file = resolve(dirname(page), target.split('#')[0] as string);
        (file.endsWith('.png') ? images : linked).add(rel(file));
      }
    for (const w of walkthroughs)
      for (const s of w.steps) for (const p of Object.values(s.media.image ?? {})) images.add(p);
    const guidePages = markdownFiles(GUIDE)
      .map(rel)
      .filter((p) => p !== 'docs/guide/README.md');
    expect(guidePages.filter((p) => !linked.has(p))).toEqual([]);
    const shots = readdirSync(join(GUIDE, 'images')).map((f) => `docs/guide/images/${f}`);
    expect(shots.filter((s) => !images.has(s))).toEqual([]);
  });

  it('the reference pages name every command and setting', () => {
    const commands = readFileSync(join(GUIDE, 'reference', 'commands.md'), 'utf8');
    expect([...contributed].filter((c) => !commands.includes(`\`${c}\``))).toEqual([]);
    const table = readFileSync(join(GUIDE, 'reference', 'settings.md'), 'utf8');
    expect(settings.filter((s) => !table.includes(`\`${s}\``))).toEqual([]);
  });

  it('the generated reference pages are current (just gen-ai)', () => {
    for (const [name, text] of Object.entries(guideReferenceFiles()))
      expect(readFileSync(join(GUIDE, 'reference', name), 'utf8'), name).toBe(text);
  });
});

describe('walkthroughs', () => {
  it('ids are unique, media exist, and command links name real commands and guide pages', () => {
    const ids = walkthroughs.flatMap((w) => [w.id, ...w.steps.map((s) => `${w.id}#${s.id}`)]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const w of walkthroughs)
      for (const s of w.steps) {
        const media = [...Object.values(s.media.image ?? {}), s.media.markdown].filter(Boolean);
        expect(media.length, `${w.id}#${s.id} media`).toBeGreaterThan(0);
        for (const m of media) expect(existsSync(join(ROOT, m as string)), m).toBe(true);
        if (s.media.image) {
          expect(Object.keys(s.media.image).sort()).toEqual(['dark', 'hc', 'hcLight', 'light']);
          expect(s.media.altText).toBeTruthy();
        }
        for (const link of commandLinks(s.description)) {
          expect(contributed.has(link.id) || BUILT_IN.has(link.id), link.id).toBe(true);
          const page = (link.args as string[] | undefined)?.[0] ?? 'README.md';
          if (link.id === 'afd.help.openGuide')
            expect(existsSync(join(GUIDE, page)), page).toBe(true);
        }
      }
  });

  it('completion events are commands we contribute, settings we have, or tour context keys', () => {
    const tour = readFileSync(join(ROOT, 'src', 'extension', 'tour.ts'), 'utf8');
    for (const w of walkthroughs)
      for (const s of w.steps)
        for (const e of s.completionEvents ?? []) {
          const [kind, value = ''] = e.split(/:(.*)/s);
          if (kind === 'onCommand')
            expect(contributed.has(value) || BUILT_IN.has(value), e).toBe(true);
          else if (kind === 'onSettingChanged') expect(settings, e).toContain(value);
          else if (kind === 'onContext') {
            expect(value, e).toMatch(/^afd\.tour\.[a-zA-Z]+$/);
            expect(tour, e).toContain(`'${value.slice('afd.tour.'.length)}'`);
          } else throw new Error(`unexpected completion event ${e}`);
        }
  });

  it('the shipped files are in the VSIX', () => {
    const ignore = readFileSync(join(ROOT, '.vscodeignore'), 'utf8');
    for (const line of [
      '!docs/guide/**',
      '!samples/**',
      '!media/icon.png',
      // AFD-73: the Ansible Flows view's Activity Bar icon.
      '!media/flows.svg',
      '!media/walkthrough/**',
      // What the extension reads at run time beside its bundle (AFD-58: the CI runner, the schema).
      '!dist/afd-scenarios.js',
      '!schema/scenarios.schema.json',
    ])
      expect(ignore).toContain(line);
    // Every yamlValidation schema ships (Red Hat YAML reads it from the extension folder).
    for (const v of pkg.contributes.yamlValidation as { url: string }[])
      expect(ignore).toContain(`!${v.url.replace(/^\.\//, '')}`);
    expect(existsSync(join(ROOT, pkg.icon))).toBe(true);
    // The screenshots are most of the VSIX: 256 colours since AFD-118 (scripts/quantize-png.py,
    // run by docs-shots), about 1.6 MB. A full-colour shot slipping in shows here.
    const images = join(GUIDE, 'images');
    const bytes = readdirSync(images).reduce((n, f) => n + statSync(join(images, f)).size, 0);
    expect(bytes).toBeLessThan(2.5 * 1024 * 1024);
    // PNG colour type 3 (palette), byte 25 of the IHDR chunk.
    const fullColour = readdirSync(images).filter(
      (f) => f.endsWith('.png') && readFileSync(join(images, f))[25] !== 3,
    );
    expect(fullColour, 'run scripts/quantize-png.py on these').toEqual([]);
  });

  // AFD-79: the guide opens in the Markdown preview from the extension folder, outside the
  // workspace, where the preview loads only the page's own folder unless an extension contributes
  // a preview style: then its whole folder is a root, and how-to pages show ../images.
  it('guide pages in subfolders can show their images in the Markdown preview', () => {
    const styles = pkg.contributes['markdown.previewStyles'] as string[];
    expect(styles).toEqual(['./media/guide-preview.css']);
    expect(readFileSync(join(ROOT, '.vscodeignore'), 'utf8')).toContain('!media/guide-preview.css');
    const nested = pages.filter((p) => dirname(p) !== GUIDE && rel(p).startsWith('docs/guide/'));
    expect(nested.some((p) => readFileSync(p, 'utf8').includes('](../images/'))).toBe(true);
  });

  // AFD-79: the extension's page in the Extensions view shows only https images and opens no
  // relative link. AFD-113: the VSIX README points them at the public repository instead.
  it('the VSIX README has no relative image or link: they point at the repository', () => {
    const readme = vsixReadme(readFileSync(join(ROOT, 'README.md'), 'utf8'));
    const targets = [
      ...[...readme.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1] ?? ''),
      ...[...readme.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1] ?? ''),
    ];
    expect(targets.filter((t) => !/^(https?:|mailto:|#)/.test(t))).toEqual([]);
    expect(readme).toContain(GUIDE_NOTE);
    expect(readme).toContain(
      '![A firewall firmware upgrade designed as a flow](https://raw.githubusercontent.com/ChistokhinSV/ansible-flow-designer/main/docs/guide/images/canvas-dark.png)',
    );
    expect(readme).toContain(
      '(https://github.com/ChistokhinSV/ansible-flow-designer/blob/main/docs/guide/tutorials/01-first-flow.md)',
    );
    // Every image it names is in the repository, so the page shows it once main is pushed.
    for (const t of targets.filter((x) => x.startsWith('https://raw.githubusercontent.com/')))
      expect(
        existsSync(
          join(ROOT, t.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\//, '')),
        ),
      ).toBe(true);
    expect(pkg.repository.url).toBe(`${REPO}.git`);
    expect(readFileSync(join(ROOT, '.vscodeignore'), 'utf8')).not.toMatch(/^!README\.md$/m);
    expect(readFileSync(join(ROOT, 'justfile'), 'utf8')).toContain(
      '--readme-path out/vsix/README.md',
    );
  });
});

describe('Ansible Flows view (AFD-73)', () => {
  it('its welcome links run commands we contribute or VS Code has', () => {
    const welcome = pkg.contributes.viewsWelcome as {
      view: string;
      contents: string;
      when: string;
    }[];
    expect(welcome.map((w) => w.when)).toEqual([
      'workbenchState == empty',
      'workbenchState != empty',
    ]);
    for (const w of welcome)
      for (const [, id] of w.contents.matchAll(/\]\(command:([\w.]+)/g))
        expect(
          contributed.has(id as string) || id === 'workbench.action.files.openFolder',
          id,
        ).toBe(true);
  });
});

describe('"?" links (AFD-73)', () => {
  it('every page a "?" opens is in the guide', () => {
    for (const page of Object.values(HELP)) expect(existsSync(join(GUIDE, page)), page).toBe(true);
  });
});

describe('samples', () => {
  const samples = readdirSync(join(ROOT, 'samples')).filter((f) => f.endsWith('.flow.yaml'));

  it.each(samples)('%s validates without errors and generates', (name) => {
    const doc = parse(readFileSync(join(ROOT, 'samples', name), 'utf8')) as FlowDocument;
    const { findings } = validateFlow(doc);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(optionA.generate(doc, { source: name }).ok).toBe(true);
  });

  it('firewall-upgrade has no warnings; edge-baseline is the example, with its three open ports', () => {
    const problems = (name: string) =>
      validateFlow(parse(readFileSync(join(ROOT, 'samples', name), 'utf8')) as FlowDocument)
        .findings.filter((f) => f.severity === 'warning')
        .map((f) => f.code);
    expect(problems('firewall-upgrade.flow.yaml')).toEqual([]);
    // AFD-74: the first sample a newcomer opens shows no problem at all.
    const hello = parse(
      readFileSync(join(ROOT, 'samples', 'hello.flow.yaml'), 'utf8'),
    ) as FlowDocument;
    expect(validateFlow(hello).findings).toEqual([]);
    expect(hello.nodes.filter((n) => n.type === 'task').every((n) => n.impl?.ref)).toBe(true);
    // Tutorial 1 and the walkthrough's "handle every failure" step use these open ports.
    expect(problems('edge-baseline.flow.yaml')).toEqual([
      'open-fail-port',
      'open-fail-port',
      'open-fail-port',
    ]);
    // The sample ships in the current format: the example (format 1, for the v1 tests) upgraded.
    const upgraded = planCommand(
      readFileSync(join(ROOT, 'examples', 'edge-baseline.flow.yaml'), 'utf8'),
      { kind: 'upgradeFormat' },
      { newId: createIdFactory() },
    ).text;
    expect(readFileSync(join(ROOT, 'samples', 'edge-baseline.flow.yaml'), 'utf8')).toBe(upgraded);
    expect(formatOf(parse(upgraded))).toBe(CURRENT_FORMAT);
  });
});

describe('sample playbooks to import (Tutorial 5)', () => {
  const dir = join(ROOT, 'samples', 'playbooks', 'edge-baseline');

  it('import as is the way the tutorial says: clean, the same steps, only the prompt noted', async () => {
    const io = fsSource(dir);
    const scan = await scanFolder(io, '');
    expect(scan.playbooks.map((p) => [p.path, p.entry])).toEqual([
      ['rollback.yml', true],
      ['site.yml', true],
      ['baseline.yml', false],
      ['prechecks.yml', false],
    ]);
    const read = await readPlaybook(io, 'site.yml');
    // Fixed IDs: the result is the golden file the guide's screenshots show (the harness loads it).
    let i = 0;
    const seq = () => `01JDSMP${String(++i).padStart(19, '0')}`;
    const r = importPlaybook(
      read.playbook as PlaybookForm,
      { key: 'site', newId: seq, generatedDir: 'flows/site/generated' },
      read.notes,
    );
    const golden = join(ROOT, 'test/fixtures/import/sample-site.flow.yaml');
    if (process.env.AFD_UPDATE_GOLDEN) writeFileSync(golden, flowText(r.doc));
    expect(flowText(r.doc)).toBe(readFileSync(golden, 'utf8'));
    expect(r.counts).toEqual({ steps: 20, implemented: 20, drafts: 0 });
    expect(r.notes).toEqual([
      'Imported by name only (vault, prompted or secret-looking): enable_secret. Give them when running.',
    ]);
    const doc = parse(flowText(r.doc)) as FlowDocument;
    const findings = validateFlow(doc).findings;
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(findings.map((f) => f.code)).toEqual(['open-fail-port', 'open-fail-port']);
    expect(optionA.generate(doc, { source: 'site.flow.yaml' }).ok).toBe(true);
    // The tutorial walks through these.
    const keys = (nodes: FlowDocument['nodes']): string[] =>
      nodes.flatMap((n) => [n.key, ...keys(n.subflow?.nodes ?? [])]);
    expect(keys(doc.nodes)).toEqual(
      expect.arrayContaining([
        'pre-checks',
        'baseline',
        'edge-baseline',
        'report',
        'load-baseline-yml',
        'netops-backup',
        'push-the-baseline',
        'record-the-rollback',
        'record-the-attempt',
        'record-the-attempt-after-failure',
        'verify-ntp',
        'apply-the-ntp-and-aaa-baseline',
        'save-config',
        'gather-facts',
      ]),
    );
  });
});
