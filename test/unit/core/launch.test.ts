// AFD-82: the launch dialog's fields and what they read as, and the real-run confirmation, which
// says the same words in the dialog as in the Command Palette's modal.
import { describe, expect, it } from 'vitest';
import type { FlowDocument } from '../../../src/core/flow/types';
import {
  checkInputs,
  type LaunchFacts,
  launchFields,
  parsedPreview,
  parseInput,
  readFields,
  realRunLines,
  realRunQuestion,
  sameFacts,
} from '../../../src/core/run/launch';

const doc = {
  schema_version: 2,
  flow: {
    id: '01M5C563009PSD1BVFF8ZZKCAD',
    key: 'ntp-rollout',
    name: 'NTP rollout',
    version: 2,
    status: 'draft',
    inputs: {
      timezone: { type: 'string', required: true },
      devices: { type: 'host_list', targets: true },
      ntp_servers: { type: 'list', required: true },
      change_ticket: { type: 'string', default: 'CHG-0000' },
      enable_secret: { type: 'string', required: true },
      retries: { type: 'integer' },
    },
  },
  nodes: [],
  edges: [],
} as unknown as FlowDocument;

const facts: LaunchFacts = {
  sources: ['inventory/lab.ini'],
  count: 10,
  hosts: [
    'lab-sw-01',
    'lab-sw-02',
    'lab-sw-03',
    'lab-sw-04',
    'lab-sw-05',
    'lab-sw-06',
    'lab-sw-07',
    'lab-sw-08',
    'lab-sw-09',
    'lab-sw-10',
  ],
  unknown: ['lab-sw-99'],
  uses: [{ pattern: 'jump', declared: '{{ jump }}', nodes: ['copy-image'], count: 1, prod: [] }],
  prod: ['prod_core'],
  vault: false,
  environment: 'docker: afd-ee:2.19',
};

describe('launchFields', () => {
  it('required inputs and host lists first, remembered or suggested text, secrets empty', () => {
    const fields = launchFields(
      doc,
      { timezone: 'UTC', enable_secret: 'x', ntp_servers: ['10.20.0.10'] },
      true,
    );
    expect(fields.map((f) => f.name)).toEqual([
      'timezone',
      'devices',
      'ntp_servers',
      'enable_secret',
      'change_ticket',
      'retries',
    ]);
    const by = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(by.timezone?.text).toBe('UTC');
    // A skeleton run suggests localhost for the targets nobody gave yet (AFD-71).
    expect(by.devices).toMatchObject({ text: 'localhost', targets: true, required: true });
    expect(by.ntp_servers?.text).toBe('10.20.0.10');
    // A remembered secret is never shown (and never remembered in the first place).
    expect(by.enable_secret).toMatchObject({ secret: true, text: '' });
    expect(by.change_ticket?.text).toBe('CHG-0000');
  });

  it('with inventory groups to pick, a skeleton run starts with no hosts (AFD-95, X5)', () => {
    const fields = launchFields(doc, {}, true, false);
    expect(fields.find((f) => f.name === 'devices')?.text).toBe('');
    // What was remembered still wins.
    const again = launchFields(doc, { devices: ['lab'] }, true, false);
    expect(again.find((f) => f.name === 'devices')?.text).toBe('lab');
  });
});

describe('parseInput', () => {
  it('a list takes items separated by commas or a JSON list (round 1: W10)', () => {
    expect(parseInput('list', '10.20.0.10, 10.20.0.11')).toEqual({
      value: ['10.20.0.10', '10.20.0.11'],
    });
    expect(parseInput('list', '["a", 2]')).toEqual({ value: ['a', 2] });
    expect(parseInput('list', '[broken')).toHaveProperty('error');
    expect(parsedPreview('list', '10.20.0.10, 10.20.0.11')).toBe(
      '2 items: "10.20.0.10", "10.20.0.11"',
    );
  });

  it('host lists, dicts, numbers and booleans read as their type or say what they expect', () => {
    expect(parseInput('host_list', 'lab, lab-sw-01 core')).toEqual({
      value: ['lab', 'lab-sw-01', 'core'],
    });
    expect(parseInput('dict', 'vlan: 10\nname: users')).toEqual({
      value: { vlan: 10, name: 'users' },
    });
    expect(parseInput('dict', '{"a": 1}')).toEqual({ value: { a: 1 } });
    expect(parseInput('dict', '- not a dict')).toHaveProperty('error');
    expect(parseInput('integer', '12')).toEqual({ value: 12 });
    expect(parseInput('integer', '1.5')).toEqual({ error: 'a whole number' });
    expect(parseInput('boolean', 'no')).toEqual({ value: false });
    expect(parseInput('boolean', 'maybe')).toEqual({ error: 'true or false' });
  });
});

describe('readFields', () => {
  const fields = launchFields(doc, {}, false);

  it('names the first field that is missing or does not read', () => {
    expect(readFields(fields, { timezone: 'UTC' })).toEqual({
      error: 'devices is required',
      field: 'devices',
    });
    expect(
      readFields(fields, {
        timezone: 'UTC',
        devices: 'lab',
        ntp_servers: 'a, b',
        enable_secret: 's',
        retries: 'many',
      }),
    ).toEqual({ error: 'retries: expected a whole number', field: 'retries' });
  });

  it('checkInputs counts the hosts while other fields are empty; only a host list holds it (AFD-91)', () => {
    // Round 2 (S5): devices set, ntp_servers still empty.
    expect(checkInputs(fields, { timezone: 'UTC', devices: 'lab' })).toEqual({
      inputs: { timezone: 'UTC', devices: ['lab'], change_ticket: 'CHG-0000' },
    });
    expect(checkInputs(fields, { timezone: 'UTC', ntp_servers: 'a' })).toEqual({
      error: 'devices is required',
      field: 'devices',
    });
  });

  it('every field read: optional empty ones left out', () => {
    expect(
      readFields(fields, {
        timezone: 'UTC',
        devices: 'lab',
        ntp_servers: 'a, b',
        enable_secret: 's',
      }),
    ).toEqual({
      inputs: {
        timezone: 'UTC',
        devices: ['lab'],
        ntp_servers: ['a', 'b'],
        enable_secret: 's',
        change_ticket: 'CHG-0000',
      },
    });
  });
});

describe('the real-run confirmation', () => {
  it('says what 0.52.0 said in its modal, line for line', () => {
    expect(realRunQuestion('NTP rollout', facts)).toBe(
      'Run "NTP rollout" for real on 10 host(s) and 1 inventory_target host(s)?',
    );
    expect(realRunLines(facts)).toEqual([
      'This is not check mode: bound nodes change the devices.',
      'Inventory: inventory/lab.ini',
      'Hosts: 10 (lab-sw-01, lab-sw-02, lab-sw-03, lab-sw-04, lab-sw-05, lab-sw-06, lab-sw-07, lab-sw-08, …)',
      'Not in the inventory: lab-sw-99',
      'Also on inventory_target jump: 1 host(s) ([copy-image])',
      'Production-looking: prod_core',
      'Environment: docker: afd-ee:2.19',
    ]);
    expect(realRunLines({ ...facts, unknown: [], uses: [], prod: [] })).toContain(
      'No production-looking groups or hosts',
    );
  });

  it('other facts at Run: another host, another count or another environment', () => {
    expect(sameFacts(facts, { ...facts, hosts: [...facts.hosts].reverse() })).toBe(true);
    expect(sameFacts(facts, { ...facts, count: 11 })).toBe(false);
    expect(sameFacts(facts, { ...facts, prod: [] })).toBe(false);
    expect(sameFacts(facts, { ...facts, environment: 'local' })).toBe(false);
  });
});
