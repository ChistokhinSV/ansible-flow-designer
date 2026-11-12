// AFD-236 (problem badges), AFD-239 (what an undo did), AFD-240 (the outline of a flow as text).
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { parseFlow } from '../../../src/core/flow/document';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import type { Finding } from '../../../src/core/flow/validate';
import { flowOutline, nodeAtOffset } from '../../../src/core/view/outline';
import { problemBadges } from '../../../src/core/view/problemBadges';
import { undoSummary } from '../../../src/core/view/undoSummary';
import { readExample } from './helpers';

const EDGE = readExample('edge-baseline.flow.yaml');
const OS = readExample('os-upgrade.flow.yaml');
const ctx = { newId: createIdFactory() };
const docOf = (text: string) => parse(text) as FlowDocument;
const apply = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx).text;
const all = (text: string): FlowNode[] =>
  [...buildModel(docOf(text)).nodes.values()].map((e) => e.node);
const id = (text: string, key: string) => all(text).find((n) => n.key === key)?.id as string;
const finding = (
  node: string,
  severity: Finding['severity'],
  code = 'from-unresolved',
): Finding => ({
  code,
  severity,
  message: `${code} on ${node}`,
  path: [],
  node,
});

describe('problem badges (AFD-236)', () => {
  const model = buildModel(docOf(OS));

  it('counts errors and warnings on the node; the worst sets the tone', () => {
    const node = id(OS, 'post-checks');
    const badges = problemBadges(model, [
      finding(node, 'warning'),
      finding(node, 'error', 'duplicate-key'),
      finding(node, 'info'),
    ]);
    expect(badges.get(node)).toMatchObject({
      errors: 1,
      warnings: 1,
      inside: 0,
      severity: 'error',
    });
    // The error leads the hover text.
    expect(badges.get(node)?.title.split('\n')[0]).toBe(`duplicate-key on ${node}`);
  });

  it('an open fail port has its own mark: no badge for it', () => {
    const node = id(OS, 'post-checks');
    expect(problemBadges(model, [finding(node, 'warning', 'open-fail-port')]).size).toBe(0);
  });

  it('a problem inside a subflow shows on the subflow too', () => {
    const inner = id(OS, 'reload');
    const badges = problemBadges(model, [finding(inner, 'error')]);
    expect(badges.get(inner)).toMatchObject({ errors: 1, inside: 0 });
    expect(badges.get(id(OS, 'upgrade-os'))).toMatchObject({
      errors: 0,
      warnings: 0,
      inside: 1,
      severity: 'error',
      title: '1 problem in the steps inside',
    });
  });
});

describe('what an undo did (AFD-239)', () => {
  it('a deleted node that comes back, by name, and it is the node to show', () => {
    const node = id(EDGE, 'validate');
    const without = apply(EDGE, { kind: 'deleteNodes', ids: [node], heal: true });
    const said = undoSummary(docOf(without), docOf(EDGE), 'Undid');
    expect(said.text).toMatch(/^Undid: added Validate, /);
    expect(said.text).toContain('wire');
    expect(said.node).toBe(node);
    expect(undoSummary(docOf(EDGE), docOf(without), 'Redid').text).toMatch(
      /^Redid: removed Validate/,
    );
  });

  it('a rename names the field; a move alone is a move', () => {
    const node = id(EDGE, 'validate');
    const renamed = apply(EDGE, { kind: 'updateNode', id: node, patch: { title: 'Validate NTP' } });
    expect(undoSummary(docOf(renamed), docOf(EDGE), 'Undid')).toEqual({
      text: 'Undid: changed Validate (title)',
      node,
    });
    const movedText = apply(EDGE, { kind: 'moveNodes', positions: { [node]: { x: 900, y: 900 } } });
    expect(undoSummary(docOf(movedText), docOf(EDGE), 'Undid')).toEqual({
      text: 'Undid: moved 1 node',
      node,
    });
  });

  it('nothing the flow shows: a change in the text', () => {
    expect(undoSummary(docOf(EDGE), docOf(EDGE), 'Undid').text).toBe('Undid: a change in the text');
  });
});

describe('the outline of a flow (AFD-240)', () => {
  const parsed = parseFlow(OS);
  const outline = flowOutline(parsed.file, buildModel(parsed.doc as FlowDocument));

  it('nodes in file order; a subflow holds its inner nodes', () => {
    expect(outline.map((i) => i.name)).toEqual(docOf(OS).nodes.map((n) => n.title));
    const sub = outline.find((i) => i.id === id(OS, 'upgrade-os'));
    expect(sub?.subflow).toBe(true);
    expect(sub?.children.map((c) => c.id)).toContain(id(OS, 'reload'));
    expect(outline.find((i) => i.id === id(OS, 'pre-checks'))?.detail).toMatch(/^task · /);
    expect(outline[0]?.detail).toBe('start');
  });

  it('a place in the text finds its innermost node', () => {
    const at = OS.indexOf('key: reload');
    expect(at).toBeGreaterThan(0);
    expect(nodeAtOffset(outline, at)).toBe(id(OS, 'reload'));
    expect(nodeAtOffset(outline, OS.indexOf('key: pre-checks'))).toBe(id(OS, 'pre-checks'));
    expect(nodeAtOffset(outline, 0)).toBeUndefined();
  });
});
