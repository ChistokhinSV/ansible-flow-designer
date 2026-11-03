// A "?" link to the guide page about where it sits (AFD-73).
import { send } from '../bus';
import { HELP, type HelpTopic } from '../helpPages';

export function HelpLink({ topic, about }: { topic: HelpTopic; about: string }) {
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
