// AFD-304: Duplicate Flow: the copy gets its own id, key and name, version 1; the nodes stay.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createIdFactory } from '../../../src/core/flow/ids';
import { copiedFlowText, newFlowText } from '../../../src/core/flow/template';
import type { FlowDocument } from '../../../src/core/flow/types';

describe('copiedFlowText', () => {
  it('a copy reads as a flow of its own: new id, key, name, version 1, the same nodes', () => {
    const ids = createIdFactory();
    const original = newFlowText('Patch web servers', 'patch-web', ids).replace(
      'version: 1',
      'version: 7',
    );
    const copy = copiedFlowText(original, 'Patch db: servers', 'patch-db', ids);
    const a = parse(original) as FlowDocument;
    const b = parse(copy) as FlowDocument;
    expect(b?.flow.key).toBe('patch-db');
    expect(b?.flow.name).toBe('Patch db: servers');
    expect(b?.flow.version).toBe(1);
    expect(b?.flow.id).not.toBe(a?.flow.id);
    expect(b?.nodes.map((n) => n.id)).toEqual(a?.nodes.map((n) => n.id));
  });

  it('keeps Windows line ends, and refuses a file that is not a flow', () => {
    const crlf = newFlowText('Hello', 'hello', createIdFactory()).replaceAll('\n', '\r\n');
    const copy = copiedFlowText(crlf, 'Hello again', 'hello-again', createIdFactory());
    expect(copy).toContain('  key: hello-again\r\n');
    expect(() => copiedFlowText('nodes: []\n', 'x', 'x', createIdFactory())).toThrow(
      /no flow header/,
    );
  });
});
