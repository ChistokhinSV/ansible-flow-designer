// AFD-26: an imported playbook does what the playbook did. The fictional netops repository's
// site.yml and the flow imported from it (as is) run side by side in each Ansible image, against
// the same simulated switches: every host must write the same files with the same contents, and the
// same hosts must end failed. Opt-in (Docker): `just test-engine`, or `just test-docker-lab engine`.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../src/core/engine/optionA';
import { createIdFactory } from '../../src/core/flow/ids';
import { flowText } from '../../src/core/flow/text';
import type { FlowDocument } from '../../src/core/flow/types';
import { importPlaybook } from '../../src/core/import/playbook';
import { readPlaybook } from '../../src/core/import/source';
import { fsSource, NETOPS } from '../unit/core/helpers';

const IMAGES = (
  process.env.AFD_ENGINE_IMAGES ?? 'ps-probe-env:2.19,ps-probe-env:2.20,ps-probe-env:2.21'
).split(',');

/** Values the prompts and the vault would give; fictional. */
const ENABLE = 'example-enable';
const COMMUNITY = 'public-example-ro';

/** Every file under a folder, relative path → contents. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full).replaceAll('\\', '/')] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

/** Hosts the recap shows failed or unreachable. */
function notOk(output: string): string[] {
  const hosts: string[] = [];
  for (const m of output.matchAll(/^(\S+)\s*:\s*ok=\d+.*?unreachable=(\d+)\s+failed=(\d+)/gm))
    if (Number(m[2]) > 0 || Number(m[3]) > 0) hosts.push(m[1] as string);
  return hosts.sort();
}

describe.each(IMAGES)('imported playbook on %s', (image) => {
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'afd-import-'));
    const repo = join(dir, 'repo');
    cpSync(NETOPS, repo, { recursive: true });
    const read = await readPlaybook(fsSource(repo), 'site.yml');
    if (!read.playbook) throw new Error(read.notes.join('\n'));
    const result = importPlaybook(read.playbook, {
      key: 'site',
      newId: createIdFactory(),
      generatedDir: 'flows/site/generated',
    });
    const text = flowText(result.doc);
    mkdirSync(join(repo, 'flows/site/generated'), { recursive: true });
    writeFileSync(join(repo, 'flows/site/site.flow.yaml'), text);
    const gen = optionA.generate(parse(text) as FlowDocument, { source: 'site.flow.yaml' });
    if (!gen.ok) throw new Error(JSON.stringify(gen.findings));
    for (const f of gen.files) writeFileSync(join(repo, 'flows/site/generated', f.name), f.text);
    writeFileSync(
      join(dir, 'flow-vars.json'),
      JSON.stringify({
        devices: ['edge'],
        out_dir: '/work/flow',
        enable_secret: ENABLE,
        snmp_community: COMMUNITY,
      }),
    );
    writeFileSync(
      join(dir, 'run.sh'),
      [
        '#!/bin/sh',
        'cd /work/repo',
        'export ANSIBLE_CONFIG=/work/repo/ansible.cfg ANSIBLE_HOST_PATTERN_MISMATCH=ignore ANSIBLE_LOCALHOST_WARNING=False',
        `ansible-playbook site.yml -e out_dir=/work/orig -e enable_secret=${ENABLE} --vault-password-file .vault-pass > /work/orig.txt 2>&1; echo $? > /work/orig.rc`,
        'ansible-playbook flows/site/generated/site.yml -e @/work/flow-vars.json > /work/flow.txt 2>&1; echo $? > /work/flow.rc',
      ].join('\n'),
    );
    execFileSync('docker', ['run', '--rm', '-v', `${dir}:/work`, image, 'sh', '/work/run.sh'], {
      stdio: 'pipe',
      timeout: 600_000,
    });
  }, 660_000);

  afterAll(() => {
    if (dir && !process.env.AFD_KEEP) rmSync(dir, { recursive: true, force: true });
  });

  it('both ran (the playbook with the vault, the flow with its inputs)', () => {
    const orig = readFileSync(join(dir, 'orig.txt'), 'utf8');
    const flow = readFileSync(join(dir, 'flow.txt'), 'utf8');
    expect(orig, orig).toContain('PLAY RECAP');
    expect(flow, flow).toContain('PLAY RECAP');
    // The unreachable switch makes both fail: rc 4 (unreachable) for the playbook, 2 for the flow.
    expect(Number(readFileSync(join(dir, 'orig.rc'), 'utf8'))).toBe(4);
    expect(Number(readFileSync(join(dir, 'flow.rc'), 'utf8'))).toBe(2);
  });

  it('every host writes the same files with the same contents', () => {
    const orig = tree(join(dir, 'orig'));
    const flow = tree(join(dir, 'flow'));
    expect(Object.keys(orig).length).toBeGreaterThan(40);
    expect(flow).toEqual(orig);
    // The canary switch went through rescue and always; the others did not roll back.
    expect(orig['sw-edge-04/rollback.txt']).toBe('rolled back\n');
    expect(orig['sw-edge-04/attempt.txt']).toBe('attempted\n');
    expect(orig['sw-edge-01/rollback.txt']).toBeUndefined();
    expect(orig['sw-edge-01/saved.txt']).toBe('saved\n');
    expect(orig['sw-edge-02/aaa.cfg']).toContain('aaa new-model');
  });

  it('the same hosts end failed or unreachable', () => {
    const orig = notOk(readFileSync(join(dir, 'orig.txt'), 'utf8'));
    const flow = notOk(readFileSync(join(dir, 'flow.txt'), 'utf8'));
    expect(orig).toEqual(['sw-edge-05']);
    expect(flow).toEqual(orig);
  });
});

// AFD-28: Tutorial 5's sample playbooks, as the tutorial uses them: imported as is, run for real
// next to site.yml (same files, nobody failed), and run as a skeleton (check mode): every host gets
// through, the canary switch by the rescue path.
describe.each(IMAGES)('the sample playbooks of Tutorial 5 on %s', (image) => {
  let dir = '';
  const SAMPLE = join(__dirname, '../../samples/playbooks/edge-baseline');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'afd-sample-'));
    const repo = join(dir, 'repo');
    cpSync(SAMPLE, repo, { recursive: true });
    const read = await readPlaybook(fsSource(repo), 'site.yml');
    if (!read.playbook) throw new Error(read.notes.join('\n'));
    const result = importPlaybook(read.playbook, {
      key: 'site',
      newId: createIdFactory(),
      generatedDir: 'flows/site/generated',
    });
    const text = flowText(result.doc);
    mkdirSync(join(repo, 'flows/site/generated'), { recursive: true });
    writeFileSync(join(repo, 'flows/site/site.flow.yaml'), text);
    const gen = optionA.generate(parse(text) as FlowDocument, { source: 'site.flow.yaml' });
    if (!gen.ok) throw new Error(JSON.stringify(gen.findings));
    for (const f of gen.files) writeFileSync(join(repo, 'flows/site/generated', f.name), f.text);
    const vars = (out: string) =>
      JSON.stringify({ devices: ['edge'], out_dir: out, enable_secret: ENABLE });
    writeFileSync(join(dir, 'flow-vars.json'), vars('/work/flow'));
    writeFileSync(join(dir, 'check-vars.json'), vars('/work/check'));
    writeFileSync(
      join(dir, 'run.sh'),
      [
        '#!/bin/sh',
        'cd /work/repo',
        'export ANSIBLE_CONFIG=/work/repo/ansible.cfg ANSIBLE_HOST_PATTERN_MISMATCH=ignore ANSIBLE_LOCALHOST_WARNING=False',
        `ansible-playbook site.yml -e out_dir=/work/orig -e enable_secret=${ENABLE} > /work/orig.txt 2>&1; echo $? > /work/orig.rc`,
        'ansible-playbook flows/site/generated/site.yml -e @/work/flow-vars.json > /work/flow.txt 2>&1; echo $? > /work/flow.rc',
        'ansible-playbook flows/site/generated/site.yml --check -e @/work/check-vars.json > /work/check.txt 2>&1; echo $? > /work/check.rc',
      ].join('\n'),
    );
    execFileSync('docker', ['run', '--rm', '-v', `${dir}:/work`, image, 'sh', '/work/run.sh'], {
      stdio: 'pipe',
      timeout: 600_000,
    });
  }, 660_000);

  afterAll(() => {
    if (dir && !process.env.AFD_KEEP) rmSync(dir, { recursive: true, force: true });
  });

  it('runs for real like site.yml: the same files, nobody failed', () => {
    const rc = (name: string) => Number(readFileSync(join(dir, `${name}.rc`), 'utf8'));
    const orig = readFileSync(join(dir, 'orig.txt'), 'utf8');
    expect(rc('orig'), orig).toBe(0);
    expect(rc('flow'), readFileSync(join(dir, 'flow.txt'), 'utf8')).toBe(0);
    const files = tree(join(dir, 'orig'));
    expect(Object.keys(files).length).toBeGreaterThan(40);
    expect(tree(join(dir, 'flow'))).toEqual(files);
    expect(files['sw-edge-04/rollback.txt']).toBe('rolled back\n');
  });

  it('runs as a skeleton: every host gets through, the canary by the rescue, nothing written', () => {
    const out = readFileSync(join(dir, 'check.txt'), 'utf8');
    expect(Number(readFileSync(join(dir, 'check.rc'), 'utf8')), out).toBe(0);
    expect(notOk(out)).toEqual([]);
    // The rescue step's play ran for the canary switch only.
    const rescue = out.split('PLAY [').find((s) => s.startsWith('[record-the-rollback]')) ?? '';
    expect(rescue).toContain('sw-edge-04');
    expect(rescue).not.toContain('sw-edge-01');
    // Only the report folders (check_mode: false); no file is written in check mode.
    expect(Object.keys(tree(join(dir, 'check')))).toEqual([]);
  });
});
