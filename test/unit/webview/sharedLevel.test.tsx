// AFD-60: inside a shared subflow the designer shows where to edit it and takes no edits.
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { subflowsOf } from '../../../src/core/flow/refs';
import type { FlowDocument } from '../../../src/core/flow/types';
import { canEdit } from '../../../src/webview/editActions';
import { useUi } from '../../../src/webview/store';
import { inheritedContext } from '../../../src/webview/viewModel';
import { readExample } from '../core/helpers';

const ctx = { newId: createIdFactory() };
const source = subflowsOf(parse(readExample('os-upgrade.flow.yaml')) as FlowDocument)[0]?.node;
const v2 = planCommand(readExample('edge-baseline.flow.yaml'), { kind: 'upgradeFormat' }, ctx).text;
const text = planCommand(
  v2,
  {
    kind: 'addReference',
    from: '../os/os.flow.yaml#upgrade-os',
    version: 3,
    source: source as never,
  },
  ctx,
).text;
const doc = parse(text) as FlowDocument;
const copy = doc.nodes.find((n) => n.key === 'upgrade-os');

beforeEach(() => {
  act(() => {
    useUi.setState({ mode: 'design', level: 'root' });
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: {},
    });
  });
});
afterEach(() => act(() => useUi.setState({ level: 'root' })));

describe('a shared subflow level (AFD-60)', () => {
  it('says where to edit it and takes no edits; the top level still does', () => {
    expect(canEdit()).toBe(true);
    act(() => useUi.setState({ level: copy?.id as string }));
    expect(canEdit()).toBe(false);
    expect(inheritedContext(doc, copy?.id as string).map((c) => c.label)).toContain(
      'shared from ../os/os.flow.yaml#upgrade-os v3 · edit it there',
    );
  });
});
