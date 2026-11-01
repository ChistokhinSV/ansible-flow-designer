// AFD-22: the user guide, the walkthroughs and the samples stay whole. Links and images resolve,
// every command and setting is documented, command links name real commands, generated pages are
// current, and the samples validate and generate.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
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
      '!media/walkthrough/**',
    ])
      expect(ignore).toContain(line);
    expect(existsSync(join(ROOT, pkg.icon))).toBe(true);
    // The screenshots are most of the VSIX (about 3 MB of 4.2): keep it under 5 MB.
    const images = join(GUIDE, 'images');
    const bytes = readdirSync(images).reduce((n, f) => n + statSync(join(images, f)).size, 0);
    expect(bytes).toBeLessThan(3.5 * 1024 * 1024);
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
