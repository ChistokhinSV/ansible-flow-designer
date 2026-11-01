// AFD-49: a format 1 flow shows the format banner with Upgrade Flow Format; the button sends the
// upgrade as one command; a current flow, a broken file or a closed banner shows none.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CURRENT_FORMAT } from '../../../src/core/flow/migrate';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { FormatBanner } from '../../../src/webview/panels/Banner';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const v1 = parse(
  readFileSync(join(__dirname, '../../../examples/edge-baseline.flow.yaml'), 'utf8'),
) as FlowDocument;

function show(doc: FlowDocument, stale = false) {
  act(() =>
    useUi.getState().setSnapshot({
      docVersion: Date.now(),
      doc,
      stale,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: {},
    }),
  );
}

beforeEach(() => {
  posted.length = 0;
  useUi.setState({ snapshot: null, formatDismissed: false });
});
afterEach(cleanup);

describe('the format banner', () => {
  it('offers Upgrade Flow Format on a format 1 flow and sends one command', () => {
    show(v1);
    render(<FormatBanner />);
    const banner = document.querySelector('[data-format-banner]') as HTMLElement;
    expect(banner.textContent).toContain('Flow format 1.');
    expect(banner.textContent).toContain('One undo step reverts it.');
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade Flow Format' }));
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'command', command: { kind: 'upgradeFormat' } }),
    );
  });

  it('is not there on a current flow, on a broken file, or once closed', () => {
    show({ ...v1, schema_version: CURRENT_FORMAT as 2 });
    const { rerender } = render(<FormatBanner />);
    expect(document.querySelector('[data-format-banner]')).toBeNull();
    show(v1, true);
    rerender(<FormatBanner />);
    expect(document.querySelector('[data-format-banner]')).toBeNull();
    show(v1);
    rerender(<FormatBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide the format message' }));
    expect(document.querySelector('[data-format-banner]')).toBeNull();
  });
});
