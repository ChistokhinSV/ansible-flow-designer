// AFD-18: the canvas context menu per target and mode, and deleting a selection in one edit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  type CanvasMenuContext,
  type CanvasMenuEntry,
  type CanvasTarget,
  canvasMenu,
} from '../../../src/core/flow/canvasMenu';
import { CommandError, type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { applyEdits } from '../../../src/core/yaml';

const read = (p: string) => readFileSync(join(__dirname, '../../..', p), 'utf8');
const EDGE = read('examples/edge-baseline.flow.yaml');
const OS = read('examples/os-upgrade.flow.yaml');

function setup(text: string) {
  const doc = parse(text) as FlowDocument;
  const model = buildModel(doc);
  const id = (key: string) =>
    [...model.nodes.values()].find((n) => n.node.key === key)?.node.id as string;
  const ctx = (extra: Partial<CanvasMenuContext> = {}): CanvasMenuContext => ({
    mode: 'design',
    level: ROOT,
    stale: false,
    openPorts: openFailPorts(model),
    hasPlay: () => true,
    ...extra,
  });
  const menu = (target: CanvasTarget, extra: Partial<CanvasMenuContext> = {}) =>
    canvasMenu(model, target, ctx(extra));
  return { doc, model, id, menu };
}

/** Labels as the menu shows them: `—` separators, `Name ▸` submenus. */
const labels = (entries: CanvasMenuEntry[]): string[] =>
  entries.map((e) =>
    e.type === 'separator' ? '—' : e.type === 'submenu' ? `${e.label} ▸` : e.label,
  );
const find = (entries: CanvasMenuEntry[], label: string) =>
  entries.find((e) => e.type !== 'separator' && e.label === label);

describe('canvas menu', () => {
  it('a task with an open fail port: properties, status, the port suggestions, clipboard, delete', () => {
    const { id, menu } = setup(EDGE);
    const entries = menu({ kind: 'node', id: id('precheck') });
    expect(labels(entries)).toEqual([
      'Details…',
      'Binding…',
      '—',
      'Rename',
      'Status ▸',
      'Open Port failed_hosts ▸',
      'Add Next Node…',
      '—',
      'Cut',
      'Copy',
      'Duplicate',
      '—',
      'Open in Text Editor',
      'Peek Code',
      '—',
      'Delete',
    ]);
    const status = find(entries, 'Status');
    expect(
      status?.type === 'submenu' && status.items.map((i) => i.type === 'item' && i.checked),
    ).toEqual([true, false, false, false]);
    const port = find(entries, 'Open Port failed_hosts');
    const portLabels = port?.type === 'submenu' ? labels(port.items) : [];
    expect(portLabels.some((l) => l.startsWith('Rollback'))).toBe(true);
    expect(portLabels).toContain('Accept with Reason…');
  });

  it('a subflow opens first; start has no status, cut or duplicate', () => {
    const { id, menu } = setup(EDGE);
    expect(labels(menu({ kind: 'node', id: id('push-baseline') }))[0]).toBe('Open Subflow');
    const start = labels(menu({ kind: 'node', id: id('start') }));
    for (const l of ['Status ▸', 'Cut', 'Duplicate', 'Details…']) expect(start).not.toContain(l);
    expect(start).toContain('Copy');
  });

  it('Run mode only reads; Implementation edits but has no Rename or Extract', () => {
    const { id, menu } = setup(EDGE);
    const run = labels(menu({ kind: 'node', id: id('precheck') }, { mode: 'run' }));
    expect(run).toEqual(['Details…', '—', 'Copy', '—', 'Open in Text Editor', 'Peek Code']);
    const impl = labels(menu({ kind: 'node', id: id('precheck') }, { mode: 'code' }));
    expect(impl).not.toContain('Rename');
    expect(impl).toContain('Delete');
    const group = { kind: 'nodes' as const, ids: [id('precheck'), id('validate')] };
    expect(labels(menu(group, { mode: 'code' }))).not.toContain('Extract into Subflow…');
    expect(labels(menu(group, { mode: 'run' }))).toEqual(['Copy']);
  });

  it('a group: clipboard, Extract (refused with start or end), Delete', () => {
    const { id, menu } = setup(EDGE);
    const group = menu({ kind: 'nodes', ids: [id('backup-config'), id('push-baseline')] });
    expect(labels(group)).toEqual([
      'Cut',
      'Copy',
      'Duplicate',
      '—',
      'Extract into Subflow…',
      '—',
      'Delete',
    ]);
    const withStart = menu({ kind: 'nodes', ids: [id('start'), id('precheck')] });
    const extract = find(withStart, 'Extract into Subflow…');
    expect(extract?.type === 'item' && extract.disabled).toMatch(/Start and end/);
  });

  it('a wire offers its port edits; boundary wires their own; YAML errors lock edits', () => {
    const { doc, id, menu } = setup(EDGE);
    const wire = doc.edges.find((e) => e.from.node === id('precheck'))?.id as string;
    expect(labels(menu({ kind: 'edge', id: wire }))).toEqual([
      'Insert Node on This Wire',
      'Rewire to Another Node…',
      'Disconnect',
    ]);
    expect(labels(menu({ kind: 'entry', subflow: 'S' }))).toEqual(['Remove Entry']);
    const exit = {
      kind: 'exit' as const,
      subflow: 'S',
      edge: 'x',
      from: { node: 'N', port: 'ok_hosts' },
      port: 'ok_hosts',
    };
    expect(labels(menu(exit))).toEqual(['Edit Reason…', 'Remove Exit']);
    expect(labels(menu(exit, { mode: 'code' }))).toEqual(['Remove Exit']);
    const stale = menu({ kind: 'node', id: id('precheck') }, { stale: true });
    const del = find(stale, 'Delete');
    expect(del?.type === 'item' && del.disabled).toBe('Fix the YAML errors first');
    expect(labels(stale)).not.toContain('Open Port failed_hosts ▸');
  });

  it('empty canvas: paste and add here, view items, Up to Parent inside a subflow', () => {
    const { id, menu } = setup(OS);
    expect(labels(menu({ kind: 'pane' }))).toEqual([
      'Paste Here',
      'Add Node Here…',
      '—',
      'Select All',
      'Tidy Up',
      'Fit View',
    ]);
    const inner = labels(menu({ kind: 'pane' }, { level: id('upgrade-os') }));
    expect(inner.at(-1)).toBe('Up to Parent');
    expect(labels(menu({ kind: 'pane' }, { mode: 'run' }))).toEqual(['Select All', 'Fit View']);
  });
});

describe('deleteNodes', () => {
  const ctx = () => ({ newId: createIdFactory() });
  const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx());

  it('one edit, the same text as deleting one by one, wires included', () => {
    const { doc, id } = setup(EDGE);
    const wire = doc.edges.find((e) => e.from.node === id('start'))?.id as string;
    const r = run(EDGE, {
      kind: 'deleteNodes',
      ids: [id('validate'), id('rollback')],
      edges: [wire],
    });
    expect(applyEdits(EDGE, r.edits)).toBe(r.text);
    let step = run(EDGE, { kind: 'disconnect', edge: wire }).text;
    step = run(step, { kind: 'deleteNode', id: id('validate') }).text;
    step = run(step, { kind: 'deleteNode', id: id('rollback') }).text;
    expect(r.text).toBe(step);
  });

  it('a subflow listed with its inner step, and a wire of a deleted node, are fine', () => {
    const { doc, id } = setup(OS);
    const sub = id('upgrade-os');
    const inner = id('verify-checksum');
    const wire = doc.edges.find((e) => e.from.node === sub)?.id as string;
    const r = run(OS, { kind: 'deleteNodes', ids: [sub, inner], edges: [wire] });
    const after = buildModel(parse(r.text) as FlowDocument);
    expect(after.nodes.has(sub)).toBe(false);
    expect(after.nodes.has(inner)).toBe(false);
  });

  it('nothing to delete is refused', () => {
    expect(() => run(EDGE, { kind: 'deleteNodes', ids: ['01JNOPE000000000000000000'] })).toThrow(
      CommandError,
    );
  });
});
