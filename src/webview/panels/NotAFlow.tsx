// The page for a *.flow.yaml that is not a flow yet (AFD-16): it says this is the Ansible Flow
// Designer and why the file opened here. An empty file can become a flow in one click; a file with
// content only shows why it does not parse, and is never overwritten.
import type { Snapshot } from '../../core/protocol';
import { send } from '../bus';

export function NotAFlow({ snapshot }: { snapshot: Snapshot }) {
  const file = snapshot.file ?? 'This file';
  return (
    <div className="afd-not-a-flow" data-not-a-flow={snapshot.empty ? 'empty' : 'invalid'}>
      <h1>
        <span className="codicon codicon-type-hierarchy" aria-hidden="true" /> Ansible Flow Designer
      </h1>
      <p className="muted">
        Files named <code>*.flow.yaml</code> open here, as a flow you design on a canvas.
      </p>
      {snapshot.empty ? (
        <>
          <p>
            <code>{file}</code> is empty. Create a flow in it: a start, an end and a{' '}
            <code>devices</code> input for the target hosts, named after the file.
          </p>
          <div className="afd-not-a-flow-actions">
            <button type="button" onClick={() => send({ type: 'initFlow' })}>
              <span className="codicon codicon-add" aria-hidden="true" /> Create a flow here
            </button>
            <button type="button" className="secondary" onClick={() => send({ type: 'openText' })}>
              Open as text
            </button>
          </div>
        </>
      ) : (
        <>
          <p role="alert">
            <code>{file}</code> is not a flow document yet:
          </p>
          <pre className="afd-not-a-flow-error">{snapshot.parseError}</pre>
          <p className="muted">
            Fix it as text, or start a new flow with <em>Ansible Flow: New Flow…</em> in the Command
            Palette.
          </p>
          <div className="afd-not-a-flow-actions">
            <button type="button" onClick={() => send({ type: 'openText' })}>
              Open as text
            </button>
          </div>
        </>
      )}
    </div>
  );
}
