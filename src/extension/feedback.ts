// Feedback without telemetry (AFD-200, AFD-201): days of real use counted on this machine, one
// notice after a week of it, and commands that open the form or GitHub's issue chooser. The
// extension sends nothing: links open in the browser, and the person decides what to send.
// AFD-263: no page opens by itself. Every ask is a notification; the page opens from its button.
import { promises as fs, unwatchFile, watchFile } from 'node:fs';
import { dirname, join } from 'node:path';
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
  listedAsInstalled,
  rateUrl,
  recordUse,
  shouldAsk,
} from '../core/feedback/feedback';
import { CMD } from './commands/ids';

const STATE = 'afd.feedback';
/** AFD-202 wrote this file next to the extension for its uninstall script; removed when found. */
const OLD_MARKER = '.no-feedback';

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
    return true;
  }

  /**
   * AFD-263: asks why, in this window, when the extension is uninstalled. The editor takes an
   * uninstalled extension off its list at once and leaves it running until the next restart, so
   * there is a moment to ask politely; the page opens only from the button. (Before, a script
   * the editor ran at its next restart opened the page in the browser by itself.)
   *
   * `list`: the editor's list of installed extensions, beside the folder this one is installed
   * in. Not watched when it does not name this extension to begin with (a development host, a
   * profile that keeps its own list): then nothing is known.
   */
  watchUninstall(
    list = join(dirname(this.context.extensionPath), 'extensions.json'),
    id = this.context.extension.id,
    timing = { interval: 3000, settle: 2500 },
  ): vscode.Disposable {
    const listed = async () => {
      try {
        return listedAsInstalled(await fs.readFile(list, 'utf8'), id);
      } catch {
        return undefined;
      }
    };
    let asked = false;
    let stopped = false;
    const check = async () => {
      if (asked || stopped || (await listed()) !== false) return;
      // An update rewrites the list too: only an extension still off it a moment later is gone.
      await new Promise((r) => setTimeout(r, timing.settle));
      if (asked || stopped || (await listed()) !== false) return;
      asked = true;
      await this.askWhyLeaving();
    };
    const onChange = () => void check().catch(() => undefined);
    void listed().then((there) => {
      if (there !== true || stopped) return;
      watchFile(list, { interval: timing.interval }, onChange);
    });
    return {
      dispose: () => {
        stopped = true;
        unwatchFile(list, onChange);
      },
    };
  }

  /** The notice after an uninstall; whether it asked. Not after Don't Ask Again or the setting off. */
  async askWhyLeaving(): Promise<boolean> {
    if (!this.enabled || this.state.never) return false;
    const yes = 'Tell Us Why';
    const pick = await vscode.window.showInformationMessage(
      'Ansible Flow Designer was uninstalled. Sorry it did not fit. If you have a minute, would you tell us what was missing? It shapes the next version. Nothing is sent unless you fill in the form.',
      yes,
      'No, Thanks',
    );
    if (pick === yes) await this.openForm('uninstall');
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

  /** The marker AFD-202 kept for its uninstall script has no reader any more. Never fails. */
  async removeOldMarker(): Promise<void> {
    await fs
      .rm(join(this.context.extensionPath, OLD_MARKER), { force: true })
      .catch(() => undefined);
  }
}

/** Send Feedback… and Report a Problem…, and the ask when the extension is uninstalled. */
export function registerFeedback(feedback: Feedback): vscode.Disposable[] {
  void feedback.removeOldMarker();
  return [
    vscode.commands.registerCommand(CMD.sendFeedback, () => feedback.openForm('command')),
    vscode.commands.registerCommand(CMD.reportIssue, () => feedback.openIssues()),
    feedback.watchUninstall(),
  ];
}
