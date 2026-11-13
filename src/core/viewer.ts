// A designer that only shows and runs a flow (AFD-270): the messages it may send its host. The
// designer drops every other message before it leaves the page, and a host that asked for a
// viewer refuses them with the same list, because a page can be changed by whoever opens it.
import type { WebviewMessage } from './protocol';

type MessageType = WebviewMessage['type'];

/** What a viewer sends: it shows the flow, starts and stops runs, and reads their results. */
export const VIEWER_MESSAGES: ReadonlySet<MessageType> = new Set<MessageType>([
  'ready',
  // Runs: the launch dialog, a run, stopping it, an earlier run, its output.
  'run',
  'launchCheck',
  'launchRun',
  'launchCancel',
  'stopRun',
  'showRun',
  'runOutput',
  'showRunOutput',
  // AFD-273: deciding an approval of the run shown, where the host lets this person decide.
  'approve',
  // Reading: what a module or role is, text for the clipboard, a link.
  'catalog',
  'copyText',
  'openLink',
  // Answers to the host and reports about the page itself.
  'inspectResult',
  'pngRendered',
  'cspViolation',
  'perf',
]);

/** True when a viewer may send a message of this type. */
export function viewerAllows(type: string): boolean {
  return (VIEWER_MESSAGES as ReadonlySet<string>).has(type);
}

/** What the designer says when a change is asked of a viewer. */
export const VIEWER_REFUSAL = 'This view only shows and runs the flow';
