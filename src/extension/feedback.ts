// Feedback without telemetry (AFD-200, AFD-201): days of real use counted on this machine, one
// notice after a week of it, and commands that open the form or GitHub's issue chooser. The
// extension sends nothing: links open in the browser, and the person decides what to send.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  afterAnswer,
  dayOf,
  editorOf,
  type FeedbackAnswer,
  type FeedbackSource,
  type FeedbackState,
  feedbackUrl,
  ISSUES_URL,
  rateUrl,
  recordUse,
  shouldAsk,
} from '../core/feedback/feedback';
import { CMD } from './commands/ids';

const STATE = 'afd.feedback';
/**
 * AFD-202: the uninstall script cannot read VS Code's state; this file next to it says "no page"
 * (Don't Ask Again, or the setting off). Updates install a new folder: activation writes it again.
 */
export const NO_FEEDBACK_MARKER = '.no-feedback';

export interface FeedbackOptions {
  /** Tests fix the clock. */
  now?: () => Date;
  /** Tests record the links instead of opening a browser. */
  open?: (url: string) => Thenable<unknown>;
}

export class Feedback {
  private readonly now: () => Date;
  private readonly open: (url: string) => Thenable<unknown>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    options: FeedbackOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.open = options.open ?? ((url) => vscode.env.openExternal(vscode.Uri.parse(url)));
  }

  get state(): FeedbackState {
    return this.context.globalState.get<FeedbackState>(STATE) ?? {};
  }

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('afd.feedback').get<boolean>('prompt', true);
  }

  private get version(): string {
    return String(this.context.extension.packageJSON.version ?? '');
  }

  /** A day the designer showed a flow with steps; one write a day at most. */
  async noteUse(): Promise<void> {
    const before = this.state;
    const after = recordUse(before, dayOf(this.now()));
    if (after !== before) await this.context.globalState.update(STATE, after);
  }

  /** The notice, when its time has come; whether it asked. */
  async maybeAsk(): Promise<boolean> {
    // Today counts, whether or not the designer's own write has landed yet.
    await this.noteUse();
    if (!this.enabled || !shouldAsk(this.state, dayOf(this.now()))) return false;
    const pick = await vscode.window.showInformationMessage(
      'How is Ansible Flow Designer working for you? A rating or a few words help it get better.',
      'Rate It',
      'Tell Us More',
      'Not Now',
      'Don’t Ask Again',
    );
    const answer: FeedbackAnswer | undefined =
      pick === 'Rate It'
        ? 'rate'
        : pick === 'Tell Us More'
          ? 'more'
          : pick === 'Don’t Ask Again'
            ? 'never'
            : pick === 'Not Now'
              ? 'later'
              : undefined;
    await this.context.globalState.update(
      STATE,
      afterAnswer(this.state, answer, dayOf(this.now())),
    );
    if (answer === 'rate') await this.openRating();
    else if (answer === 'more') await this.openForm('prompt');
    await this.syncMarker();
    return true;
  }

  /** The form page, with the occasion, the version and the editor. */
  async openForm(source: FeedbackSource): Promise<void> {
    await this.open(feedbackUrl({ source, version: this.version, editor: editorOf(vscode.env) }));
  }

  /** GitHub's issue chooser: a bug report or an idea. */
  async openIssues(): Promise<void> {
    await this.open(ISSUES_URL);
  }

  private async openRating(): Promise<void> {
    await this.open(rateUrl(editorOf(vscode.env)));
  }

  /** The uninstall page's marker matches Don't Ask Again and the setting. Never fails. */
  async syncMarker(): Promise<void> {
    const marker = join(this.context.extensionPath, NO_FEEDBACK_MARKER);
    try {
      if (this.state.never || !this.enabled) await fs.writeFile(marker, 'no feedback page\n');
      else await fs.rm(marker, { force: true });
    } catch {
      // A read-only install (a system folder, a store package): the page opens as usual.
    }
  }
}

/** Send Feedback… and Report a Problem…, and the setting's effect on the marker. */
export function registerFeedback(feedback: Feedback): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(CMD.sendFeedback, () => feedback.openForm('command')),
    vscode.commands.registerCommand(CMD.reportIssue, () => feedback.openIssues()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('afd.feedback.prompt')) void feedback.syncMarker();
    }),
  ];
}
