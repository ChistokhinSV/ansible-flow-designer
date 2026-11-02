// AFD-68 (product-owner report on 0.42.1): a resize right after a save collapsed to the minimum,
// because a new canvas node object had no `measured` size and React Flow's resizer started from
// 0; a new Section's title (its only handle) could land under a node; Add Section wraps the pick.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type AnnotationView, sectionContents } from '../../../src/core/flow/annotations';
import { canvasMenu } from '../../../src/core/flow/canvasMenu';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { Snapshot } from '../../../src/core/protocol';
import { addAnnotation } from '../../../src/webview/annotationActions';
import { toAnnotationNode } from '../../../src/webview/canvas/FlowCanvas';
import { useUi } from '../../../src/webview/store';
import { levelView } from '../../../src/webview/viewModel';
import { posted } from './setup';

const DOC = parse(
  readFileSync(join(__dirname, '../../fixtures/flows/annotated.flow.yaml'), 'utf8'),
) as FlowDocument;
const nodeId = (key: string) => DOC.nodes.find((n) => n.key === key)?.id as string;
const snapshot = (): Snapshot => ({
  docVersion: 1,
  doc: DOC,
  stale: false,
  findings: [],
  openPorts: openFailPorts(buildModel(DOC)),
  autoPositions: {},
});
const added = () =>
  posted.flatMap((m) => {
    const c = (m as { command?: FlowCommand }).command;
    return (m as { type: string }).type === 'command' && c?.kind === 'addAnnotation' ? [c] : [];
  });

beforeEach(() => {
  posted.length = 0;
  useUi.setState({ snapshot: null, selection: {}, optimistic: {}, mode: 'design', level: 'root' });
  act(() => useUi.getState().setSnapshot(snapshot()));
});

describe('annotations after first use (AFD-68)', () => {
  it('every annotation canvas node says its own measured size', () => {
    const ui = useUi.getState();
    const view = levelView(ui.snapshot as Snapshot, {}, 'root');
    for (const v of view.annotations) {
      const n = toAnnotationNode(v, false, true, new Set(), {});
      expect(n.measured).toEqual({ width: v.width, height: v.height });
    }
  });

  it('Add Section around picked nodes holds them wholly; a palette spot avoids nodes', () => {
    const picked = [nodeId('backup-config'), nodeId('validate')];
    void addAnnotation('section', undefined, undefined, { around: picked });
    const [wrap] = added();
    if (wrap?.kind !== 'addAnnotation') throw new Error('no addAnnotation');
    const a = wrap.annotation;
    expect(a.width).toBeGreaterThan(0);
    // Read back as the canvas would: the picked nodes are inside, so a drag carries them.
    const ui = useUi.getState();
    const view = levelView(ui.snapshot as Snapshot, {}, 'root');
    const width = a.width as number;
    const height = a.height as number;
    const section: AnnotationView = {
      annotation: { id: 'new', key: 'section-9', kind: 'section', text: a.text, x: a.x, y: a.y },
      kind: 'section',
      position: { x: a.x, y: a.y },
      width,
      height,
    };
    const inside = sectionContents(
      { nodes: view.nodes, annotations: [...view.annotations, section] },
      'new',
    ).nodes;
    expect(inside).toEqual(expect.arrayContaining(picked));

    // The menu of several picked nodes offers the same.
    const menu = canvasMenu(
      buildModel(DOC),
      { kind: 'nodes', ids: picked },
      { mode: 'design', level: 'root', stale: false, openPorts: [], hasPlay: () => false },
    );
    expect(menu).toContainEqual(
      expect.objectContaining({
        label: 'Add Section Around',
        action: { do: 'addAnnotation', kind: 'section', around: picked },
      }),
    );

    posted.length = 0;
    const centre = view.nodes.find((n) => n.node.id === nodeId('push-baseline'))?.position;
    void addAnnotation('section', centre, undefined, { near: true });
    const [near] = added();
    if (near?.kind !== 'addAnnotation') throw new Error('no addAnnotation');
    const box = { x: near.annotation.x, y: near.annotation.y, w: 480, h: 320 };
    for (const n of view.nodes)
      expect(
        box.x < n.position.x + n.width &&
          n.position.x < box.x + box.w &&
          box.y < n.position.y + n.height &&
          n.position.y < box.y + box.h,
      ).toBe(false);
  });
});
