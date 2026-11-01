// M8 (AFD-13): the five lenses on the lens-e2e fixture, with inventory facts as the probe returns
// them for test/fixtures/lens/inventory (probe contract test), plus the examples as regressions.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import type { FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { lensView, summaryRows } from '../../../src/core/lens';
import {
  appendEntry,
  type HistoryEntry,
  historyEntry,
  timingStats,
} from '../../../src/core/lens/history';
import { inventoryPatterns } from '../../../src/core/lens/inventory';
import { parseRequirements, satisfies } from '../../../src/core/lens/requirements';
import type { CodeFacts, InventoryFacts, LensFacts, LensId } from '../../../src/core/lens/types';
import type { RunView } from '../../../src/core/protocol';
import { applyEdits } from '../../../src/core/yaml';

const ROOT = join(__dirname, '../../..');
const FLOW = readFileSync(
  join(ROOT, 'test/fixtures/lens/flows/lens-e2e/lens-e2e.flow.yaml'),
  'utf8',
);
const doc = parse(FLOW) as FlowDocument;
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
const ORIGIN = 'test/fixtures/lens/inventory/group_vars';

const inventory: InventoryFacts = {
  sources: ['test/fixtures/lens/inventory/hosts.yml'],
  dynamic: [],
  total: 9,
  targets: 'edge_switches',
  patterns: {
    edge_switches: { count: 6, outside: 0, sample: [] },
    'edge_switches,core_spines': { count: 8, outside: 2, sample: ['core-sp-01', 'core-sp-02'] },
    core_spines: { count: 2, outside: 2, sample: ['core-sp-01', 'core-sp-02'] },
    all: { count: 9, outside: 3, sample: ['mgmt-01', 'core-sp-01', 'core-sp-02'] },
  },
  scope: { count: 9, groups: { core_spines: 2, dc_prod: 2, edge_switches: 6 } },
  prod_groups: ['dc_prod'],
  access: {
    edge_switches: { ansible_user: { values: { netops: 6 }, origins: [`${ORIGIN}/all.yml:2`] } },
    core_spines: {
      ansible_user: { values: { 'spine-admin': 2 }, origins: [`${ORIGIN}/core_spines.yml:2`] },
      ansible_become: { values: { true: 2 }, origins: [] },
    },
  },
  vaulted: { spine_enable_secret: `${ORIGIN}/core_spines.yml:3` },
};
const code: CodeFacts = {
  ready: true,
  environment: 'docker: afd-ee:2.19',
  collections: { 'ansible.builtin': '2.19.4', 'cisco.ios': '9.0.3', 'ansible.utils': '5.1.2' },
  requirements: {
    path: 'collections/requirements.yml',
    pins: parseRequirements(
      readFileSync(join(ROOT, 'test/fixtures/lens/collections/requirements.yml'), 'utf8'),
    ),
  },
  nodes: {
    [id('precheck')]: {
      kind: 'module',
      ref: 'ansible.builtin.ping',
      fqcn: 'ansible.builtin.ping',
      collection: 'ansible.builtin',
      version: '2.19.4',
      state: 'ok',
    },
    [id('upgrade')]: {
      kind: 'module',
      ref: 'cisco.ios.ios_config',
      fqcn: 'cisco.ios.ios_config',
      collection: 'cisco.ios',
      version: '9.0.3',
      state: 'ok',
    },
  },
};
const facts: LensFacts = {
  inventory: { state: 'ready', facts: inventory, targets: 'edge_switches' },
  code,
  timing: timingStats([
    {
      id: 'r1',
      at: '2026-10-29T08:00:00Z',
      source: 'local',
      rc: 0,
      timings: {
        [id('precheck')]: 300,
        [id('drain')]: 600,
        [id('upgrade')]: 900,
        [id('post')]: 300,
      },
    },
    {
      id: 'r2',
      at: '2026-10-29T09:00:00Z',
      source: 'awx',
      rc: 0,
      timings: {
        [id('precheck')]: 300,
        [id('drain')]: 600,
        [id('upgrade')]: 1100,
        [id('post')]: 300,
      },
    },
  ]),
};
const view = (lens: LensId, f: LensFacts = facts, run: RunView | null = null, d = doc) =>
  lensView(lens, d, f, run);
const ids = (lens: LensId) => view(lens).findings.map((f) => f.id);

describe('Inventory lens', () => {
  it('asks the probe for the targets, each declared target and its parts', () => {
    expect(inventoryPatterns(doc, 'edge_switches', code).sort()).toEqual(
      ['all', 'core_spines', 'edge_switches', 'edge_switches,core_spines'].sort(),
    );
  });

  it('chips: targets and counts, declared groups beyond the targets marked', () => {
    const v = view('inventory');
    expect(v.chips[id('start')]?.map((c) => c.text)).toEqual(['edge_switches · 6']);
    expect(v.chips[id('precheck')]?.map((c) => c.text)).toEqual(['edge_switches · 6']);
    expect(v.chips[id('drain')]?.map((c) => [c.text, c.tone])).toEqual([
      ['edge_switches · 6', undefined],
      ['+ core_spines · 2', 'warn'],
    ]);
    expect(v.chips[id('rollback')]?.map((c) => c.text)).toEqual(['+ all · 9']);
    expect(Object.values(v.chips).every((c) => c.length <= 2)).toBe(true);
  });

  it('findings: Rollback on all, core_spines not an input, production', () => {
    expect(ids('inventory')).toEqual([
      `inventory:broad-target:${id('rollback')}`,
      'inventory:group-not-input:core_spines',
      'inventory:prod',
    ]);
    const broad = view('inventory').findings[0];
    expect(broad?.title).toBe('Rollback targets all (9)');
    expect(broad?.detail).toContain('failed_hosts');
    expect(broad?.fixes[0]?.label).toBe('Limit to Arriving Hosts');
  });

  it('the fixes are one edit each and clear their finding', () => {
    for (const f of view('inventory').findings.filter((x) => x.fixes.length)) {
      const fix = f.fixes[0];
      if (!fix || !('command' in fix)) continue;
      const r = planCommand(FLOW, fix.command, { newId: createIdFactory() });
      expect(applyEdits(FLOW, r.edits)).toBe(r.text);
      const after = parse(r.text) as FlowDocument;
      expect(view('inventory', facts, null, after).findings.map((x) => x.id)).not.toContain(f.id);
    }
  });

  it('without facts: notes say what is missing, nothing is counted', () => {
    const v = view('inventory', {});
    expect(v.notes.join(' ')).toContain('not been read');
    expect(v.notes.join(' ')).toContain('Enter the flow targets (devices)');
    expect(v.chips[id('start')]?.[0]).toMatchObject({ text: 'devices: not set', tone: 'muted' });
    expect(v.findings.map((f) => f.id)).toEqual([]);
  });

  it('with a run: wires and nodes count the hosts that took them, excluded hosts listed', () => {
    const run: RunView = {
      id: 'r3',
      mode: 'real',
      state: 'done',
      rc: 2,
      startedAt: '2026-10-29T10:00:00Z',
      summary: {
        nodes: {
          [id('precheck')]: {
            ok_hosts: ['edge-sw-01', 'edge-sw-02'],
            failed_hosts: ['edge-sw-03'],
          },
        },
        hosts: ['edge-sw-01', 'edge-sw-02', 'edge-sw-03'],
        outcome: {},
        failures: [],
        unreachable: [],
        stoppedEarly: false,
      },
    };
    const v = view('inventory', facts, run);
    const wire = doc.edges.find(
      (e) => e.from.node === id('precheck') && e.from.port === 'ok_hosts',
    );
    expect(wire && v.wires?.[wire.id]).toBe('ok_hosts · 2');
    expect(v.chips[id('precheck')]?.[0]?.text).toBe('edge_switches · 3');
    const excluded = v.sections.find((s) => s.title === 'Excluded last run');
    expect(excluded?.items.map((i) => [i.label, i.detail])).toEqual([
      ['edge-sw-03', 'Pre-checks · failed_hosts'],
    ]);
  });
});

describe('Data lens', () => {
  it('derives data wires from from: references, labeled with the variable', () => {
    const v = view('data');
    expect(v.dataWires?.map((w) => [w.from, w.to, w.label])).toEqual([
      [id('start'), id('precheck'), 'devices'],
      [id('start'), id('drain'), 'devices'],
    ]);
    expect(v.chips[id('precheck')]?.map((c) => c.text)).toEqual(['in: devices', 'out: report']);
  });

  it('findings: an unresolved input, an unused output', () => {
    expect(ids('data')).toEqual([
      `data:unresolved:${id('post')}.ref`,
      `data:unused-output:${id('precheck')}.report`,
    ]);
  });

  it('edge-baseline: every from: resolves, outputs feed later nodes', () => {
    const edge = parse(
      readFileSync(join(ROOT, 'examples/edge-baseline.flow.yaml'), 'utf8'),
    ) as FlowDocument;
    const v = lensView('data', edge, {}, null);
    expect(v.findings.filter((f) => f.severity === 'warning')).toEqual([]);
    expect(v.dataWires?.some((w) => w.label === 'backup_ref')).toBe(true);
  });
});

describe('Code lens', () => {
  it('chips: binding with its collection version, and the environment', () => {
    expect(view('code').chips[id('upgrade')]?.map((c) => c.text)).toEqual([
      'ios_config 9.0.3',
      'afd-ee:2.19',
    ]);
    expect(view('code').chips[id('drain')]?.map((c) => c.text)).toEqual([
      'TODO stub',
      'afd-ee:2.19',
    ]);
  });

  it('findings: requirements ask for a newer cisco.ios; a missing module', () => {
    expect(ids('code')).toEqual(['code:outdated:cisco.ios']);
    const missing: CodeFacts = {
      ...code,
      nodes: {
        ...code.nodes,
        [id('upgrade')]: {
          kind: 'module',
          ref: 'cisco.ios.ios_config',
          state: 'not-in-ee',
          collection: 'cisco.ios',
        },
      },
    };
    expect(view('code', { code: missing }).findings.map((f) => f.id)).toContain(
      `code:not-in-ee:${id('upgrade')}`,
    );
  });

  it('galaxy version specs', () => {
    expect(satisfies('9.0.3', '>=10.0.0,<11.0.0')).toBe(false);
    expect(satisfies('10.2.0', '>=10.0.0,<11.0.0')).toBe(true);
    expect(satisfies('5.1.2', '*')).toBe(true);
    expect(satisfies('1.4.1', '==1.4.1')).toBe(true);
    expect(satisfies('3.0.0', '!=3.0.0')).toBe(false);
    expect(satisfies('2.0.0-rc1', '>=2.0.0')).toBe(false);
    expect(parseRequirements('collections:\n  - cisco.nxos\n  - name: ./local.tar.gz\n')).toEqual({
      'cisco.nxos': '*',
    });
  });
});

describe('Access lens', () => {
  it('chips: credential first, then become; inventory user where no credential', () => {
    const v = view('access');
    expect(v.chips[id('upgrade')]?.map((c) => c.text)).toEqual(['netops-admin', 'become']);
    expect(v.chips[id('precheck')]?.map((c) => c.text)).toEqual(['user netops']);
  });

  it('findings: another credential than both neighbours, become alone, vault, AWX-only names', () => {
    expect(ids('access')).toEqual([
      `access:credential:${id('upgrade')}`,
      `access:become:${id('upgrade')}`,
      'access:awx-only',
      'access:vault',
    ]);
    expect(view('access').findings[0]?.title).toBe(
      'Upgrade OS uses netops-admin, its neighbours use netops-rw',
    );
    const vault = view('access').sections.find((s) => s.title === 'Vaulted variables');
    expect(vault?.items[0]).toMatchObject({ label: 'spine_enable_secret', nodes: [id('upgrade')] });
  });
});

describe('Timing lens', () => {
  it('chips: serial and timeout, then the average', () => {
    expect(view('timing').chips[id('precheck')]?.map((c) => c.text)).toEqual([
      'serial 2 · 10m',
      'avg 5 min 00 s',
    ]);
  });

  it('the slowest path does not fit the 30m window', () => {
    const v = view('timing');
    expect(v.stats.find((s) => s.label === 'estimate')?.value).toBe('36 min 40 s');
    expect(ids('timing')).toContain('timing:window');
    const wide = { ...doc, flow: { ...doc.flow, maintenance_window: '1h' } };
    expect(view('timing', facts, null, wide).findings.map((f) => f.id)).not.toContain(
      'timing:window',
    );
  });

  it('history keeps 20 real runs; p95 by nearest rank', () => {
    const runs: HistoryEntry[] = Array.from({ length: 25 }, (_, i) => ({
      id: `r${i}`,
      at: '',
      source: 'local',
      timings: { n: i + 1 },
    }));
    const entries = runs.reduce<HistoryEntry[]>((acc, e) => appendEntry(acc, e), []);
    expect(entries).toHaveLength(20);
    const s = timingStats(entries).nodes.n;
    expect(s).toMatchObject({ runs: 20, last: 25, p95: 24, avg: 15.5 });
    const skeleton: RunView = {
      id: 'x',
      mode: 'check',
      state: 'done',
      startedAt: '',
      summary: {
        nodes: {},
        hosts: [],
        outcome: {},
        failures: [],
        unreachable: [],
        stoppedEarly: false,
        timings: { n: { start: 0, end: 3 } },
      },
    };
    expect(historyEntry(skeleton)).toBeUndefined();
    expect(historyEntry({ ...skeleton, mode: 'real' })?.timings).toEqual({ n: 3 });
  });
});

describe('Mark expected (finding_accepted)', () => {
  it('is one edit with a reason, marks the finding, and Reopen removes it', () => {
    const ctx = { newId: createIdFactory() };
    const finding = 'inventory:group-not-input:core_spines';
    const r = planCommand(
      FLOW,
      {
        kind: 'acceptFinding',
        finding,
        reason: 'Spines drain by design',
        by: 'Fictional Engineer',
      },
      ctx,
    );
    expect(applyEdits(FLOW, r.edits)).toBe(r.text);
    const after = parse(r.text) as FlowDocument;
    expect(after.decisions).toEqual([
      {
        kind: 'finding_accepted',
        finding,
        reason: 'Spines drain by design',
        by: 'Fictional Engineer',
      },
    ]);
    const f = view('inventory', facts, null, after).findings.find((x) => x.id === finding);
    expect(f?.accepted).toEqual({ reason: 'Spines drain by design', by: 'Fictional Engineer' });
    expect(view('inventory', facts, null, after).findings.at(-1)?.id).toBe(finding);
    expect(validateFlow(after).findings.filter((x) => x.code.includes('decision'))).toEqual([]);
    const back = planCommand(r.text, { kind: 'clearFindingAccept', finding }, ctx);
    expect(back.text).toBe(FLOW);
    expect(() => planCommand(FLOW, { kind: 'acceptFinding', finding, reason: ' ' }, ctx)).toThrow(
      /why/,
    );
  });

  it('maintenance_window is set in one edit, normalized, and validated', () => {
    const ctx = { newId: createIdFactory() };
    const r = planCommand(
      FLOW,
      { kind: 'updateFlow', patch: { maintenance_window: '2h 30m' } },
      ctx,
    );
    expect((parse(r.text) as FlowDocument).flow.maintenance_window).toBe('2h30m');
    expect(() =>
      planCommand(FLOW, { kind: 'updateFlow', patch: { maintenance_window: 'soon' } }, ctx),
    ).toThrow(/duration/);
  });
});

describe('Semantic zoom summary (D-19)', () => {
  it('rows for the card: hosts, limit, data, binding, collection, access, limits, duration', () => {
    const rows = summaryRows(doc, doc.nodes.find((n) => n.key === 'upgrade') as never, facts, null);
    expect(rows.map((r) => `${r.label}: ${r.value}`)).toEqual([
      'hosts: edge_switches · 6',
      'limit: ok_hosts from Drain traffic',
      'inputs: image, secret',
      'module: cisco.ios.ios_config 9.0.3',
      'collection: cisco.ios 9.0.3',
      'credential: netops-admin',
      'become: yes',
      'serial: timeout 20m',
      'duration: avg 16 min 40 s · p95 18 min 20 s',
    ]);
  });

  it('the examples render every lens without errors', () => {
    for (const f of ['examples/os-upgrade.flow.yaml', 'examples/edge-baseline.flow.yaml']) {
      const d = parse(readFileSync(join(ROOT, f), 'utf8')) as FlowDocument;
      for (const lens of ['inventory', 'data', 'code', 'access', 'timing'] as const) {
        const v = lensView(lens, d, {}, null);
        expect(
          Object.values(v.chips).every((c) => c.length <= 2),
          `${f} ${lens}`,
        ).toBe(true);
      }
    }
  });
});
