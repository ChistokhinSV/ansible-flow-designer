// A "?" link to the guide page about where it sits (AFD-73).
import { send } from '../bus';
import { HELP, type HelpTopic } from '../helpPages';
import { useUi } from '../store';

export function HelpLink({ topic, about }: { topic: HelpTopic; about: string }) {
  // AFD-270: the guide opens in the editor; a viewer's host has no such place.
  const viewer = useUi((s) => s.viewer);
  if (viewer) return null;
  return (
    <button
      type="button"
      className="icon afd-help-link"
      aria-label={`Help: ${about}`}
      title={`The guide on ${about}`}
      onClick={() => send({ type: 'openGuide', page: HELP[topic] })}
    >
      <span className="codicon codicon-question" aria-hidden="true" />
    </button>
  );
}
