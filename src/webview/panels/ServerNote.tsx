// AFD-284: the flow changed on Ansible Flow Server's branch beyond this clone's HEAD. Show changes
// pulls and opens the Changes lens against the version shown before; Update only pulls; Dismiss
// puts the note away until the branch moves on.
import { send } from '../bus';
import { useUi } from '../store';

export function ServerNote() {
  const change = useUi((s) => s.serverChange);
  if (!change) return null;
  return (
    <div className="afd-server-note" role="status" data-server-change={change.commit}>
      <span className="codicon codicon-cloud" aria-hidden="true" /> <span>{change.text}</span>{' '}
      {change.removed ? null : (
        <>
          <button
            type="button"
            className="link"
            onClick={() => send({ type: 'serverUpdate', show: true })}
            title="Pull the server's commits, then compare with the version you had"
          >
            Show changes
          </button>{' '}
          <button
            type="button"
            className="link"
            onClick={() => send({ type: 'serverUpdate', show: false })}
            title="Pull the server's commits (fast-forward only)"
          >
            Update
          </button>{' '}
        </>
      )}
      <button type="button" className="link" onClick={() => send({ type: 'serverDismiss' })}>
        Dismiss
      </button>
    </div>
  );
}
