// AFD-283: a merge git left to the designer: the Merge note lists each conflict with Mine and
// Theirs, says which is chosen, shows the step, and Finish asks the host to take the file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { MergeNote } from '../../../src/webview/panels/MergeNote';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../samples/hello.flow.yaml'), 'utf8'),
) as FlowDocument;
const hello = doc.nodes.find((n) => n.key === 'say-hello')?.id as string;

beforeEach(() => {
  posted.length = 0;
  useUi.setState({ snapshot: null, merge: null, highlight: null, mode: 'design' });
  act(() => {
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: Object.fromEntries(doc.nodes.map((n, i) => [n.id, { x: 0, y: i * 140 }])),
    });
    useUi.getState().setMerge({
      file: 'flows/hello.flow.yaml',
      conflicts: [
        {
          id: `node:${hello}:title`,
          kind: 'value',
          node: hello,
          field: 'title',
          label: 'Say hello: title',
          base: 'Say hello',
          ours: 'Say hello to the team',
          theirs: 'Greet everyone',
          chosen: 'ours',
        },
        {
          id: 'flow:goal',
          kind: 'value',
          field: 'goal',
          label: 'The flow: goal',
          ours: 'Greet',
          theirs: 'Say hi',
          chosen: 'theirs',
        },
      ],
      broken: [],
    });
  });
});
afterEach(cleanup);

describe('the Merge note (AFD-283)', () => {
  it('lists each conflict with Mine and Theirs, the choice pressed', () => {
    render(<MergeNote />);
    const note = screen.getByRole('region', { name: 'Merge' });
    expect(note.textContent).toContain('2 places both sides changed');
    const [first, second] = within(note).getAllByRole('listitem');
    const mine = within(first as HTMLElement).getByRole('button', { name: /^Mine:/ });
    expect(mine.getAttribute('aria-pressed')).toBe('true');
    expect(mine.textContent).toContain('Say hello to the team');
    const theirs = within(second as HTMLElement).getByRole('button', { name: /^Theirs:/ });
    expect(theirs.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(first as HTMLElement).getByRole('button', { name: /^Theirs:/ }));
    expect(posted).toContainEqual({
      type: 'mergeChoose',
      id: `node:${hello}:title`,
      side: 'theirs',
    });
    // The step's name shows it on the canvas.
    fireEvent.click(within(first as HTMLElement).getByRole('button', { name: 'Say hello: title' }));
    expect(useUi.getState().highlight).toEqual([hello]);

    fireEvent.click(within(note).getByRole('button', { name: 'Finish merge' }));
    expect(posted).toContainEqual({ type: 'mergeFinish' });
  });

  it('no merge, no note', () => {
    act(() => useUi.getState().setMerge(null));
    render(<MergeNote />);
    expect(screen.queryByRole('region', { name: 'Merge' })).toBeNull();
  });
});
