// AFD-57: the Changes lens on the canvas, in the lens panel and in Details: chips on changed and
// added nodes, ghosts where removed nodes stood, the base picker, and a node's field changes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { GeneralSection } from '../../../src/webview/details/sections';
import { LensBrowser } from '../../../src/webview/panels/LensPanel';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../examples/edge-baseline.flow.yaml'), 'utf8'),
) as FlowDocument;
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
// The base had another title on validate and a step this version removed.
const base = structuredClone(doc);
(base.nodes.find((n) => n.key === 'validate') as { title: string }).title = 'Check config';
base.nodes.push({
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  key: 'notify-team',
  type: 'task',
  title: 'Notify team',
});
base.layout = { ...base.layout, '01JZZZZZZZZZZZZZZZZZZZZZZZ': { x: 900, y: 40 } };
const refs = [
  { ref: 'HEAD', label: 'HEAD (main)' },
  { ref: 'abc1234def', label: 'abc1234 Add the baseline' },
];

beforeEach(() => {
  posted.length = 0;
  useUi.setState({ snapshot: null, selection: {}, lens: null, lensFacts: {}, lensView: null });
  act(() => {
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: {},
    });
    useUi.getState().setLens('changes');
    useUi.getState().setLensFacts({
      compare: { state: 'ready', ref: 'HEAD', label: 'HEAD (main)', refs, base },
    });
  });
});
afterEach(cleanup);

describe('Changes lens (AFD-57)', () => {
  it('chips the changed node and draws the removed one as a ghost where it stood', () => {
    render(
      <ReactFlowProvider>
        <div style={{ width: 1600, height: 900 }}>
          <FlowCanvas cull={false} />
        </div>
      </ReactFlowProvider>,
    );
    const chips = document
      .querySelector<HTMLElement>(`[data-node-id="${id('validate')}"] [data-lens-chips]`)
      ?.dataset.lensChips?.split('|');
    expect(chips).toEqual(['changed: title']);
    const ghost = document.querySelector('[data-ghost="01JZZZZZZZZZZZZZZZZZZZZZZZ"]');
    expect(ghost?.textContent).toContain('Notify team');
    expect(ghost?.closest('.react-flow__node')?.getAttribute('style')).toContain('900px');
  });

  it('the panel compares with a picked version and lists the changes', () => {
    render(<LensBrowser />);
    const pick = screen.getByLabelText('Compare with') as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(refs.map((r) => r.label));
    fireEvent.change(pick, { target: { value: 'abc1234def' } });
    expect(posted.at(-1)).toEqual({ type: 'compareWith', ref: 'abc1234def' });
    expect(
      document.querySelector('[data-lens-item="01JZZZZZZZZZZZZZZZZZZZZZZZ"]')?.textContent,
    ).toContain('Notify team');
  });

  it('Details shows the node’s field changes since the compared version', () => {
    render(<GeneralSection node={doc.nodes.find((n) => n.key === 'validate') as never} />);
    const box = document.querySelector('[data-node-changes="changed"]');
    expect(box?.textContent).toContain('Since HEAD (main)');
    expect(box?.textContent).toContain('Check config → Validate');
  });
});
