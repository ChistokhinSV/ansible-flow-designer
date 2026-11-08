// Flow documents' lifecycle (AFD-37: out of activate): a session per open flow, refreshed on
// edits; on save, the version bump and the tested drop-back (ADR-0006), then generated code
// (ADR-0009).
import * as vscode from 'vscode';
import { parseFlow } from '../core/flow/document';
import { planSave } from '../core/flow/save';
import type { Notice } from '../core/protocol';
import { applyEdits } from '../core/yaml/edits';
import { type CodegenOutcome, generateFlow } from './codegen';
import { announceImplementedAgain, type SessionDeps } from './flowSession';
import { headText } from './gitHead';
import { type Host, isFlow } from './host';
import { logChannel } from './log';
import { saveFollowed } from './run/scenarioFollow';

export function registerDocuments(host: Host): vscode.Disposable[] {
  const { sessions, lastSaved, savedCode, deps } = host;
  for (const doc of vscode.workspace.textDocuments) if (isFlow(doc)) void prefetchHead(doc.uri);
  return [
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!isFlow(doc)) return;
      void host.sessionFor(doc).refresh();
      // AFD-164: the save participant has a short budget; HEAD's text is read ahead of it.
      prefetchHead(doc.uri);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0) sessions.get(e.document.uri.toString())?.changed(e.reason);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString();
      sessions.get(key)?.dispose();
      sessions.delete(key);
      lastSaved.delete(key);
      heads.delete(key);
      // AFD-93: closed, its Problems come from the workspace index again.
      if (isFlow(doc)) void host.index.republish(doc.uri);
    }),
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (isFlow(e.document))
        e.waitUntil(
          saveEdits(e.document, lastSaved.get(e.document.uri.toString()), (text) =>
            sessions.get(e.document.uri.toString())?.expectOwn(text),
          ),
        );
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isFlow(doc)) return;
      lastSaved.set(doc.uri.toString(), doc.getText());
      // AFD-115: a scenarios file the flow's edits changed is saved with it.
      void saveFollowed(doc.uri);
      // AFD-92: saved in the designer, this is what it shows (save edits included).
      const session = sessions.get(doc.uri.toString());
      if (session?.hasPanels) void session.rememberShown();
      if (vscode.workspace.getConfiguration('afd', doc.uri).get<boolean>('codegen.onSave', true)) {
        // AFD-164: a failure here was an unhandled rejection: no message, generated/ maybe half
        // written. It is logged and shown in the status bar.
        const code = writeCode(doc, deps, false).catch((e: unknown) => saveCodegenFailed(doc, e));
        savedCode.set(doc.uri.toString(), code);
        // Implementation mode shows the code: once it is rewritten, sync again (M6).
        void code.then(() => sessions.get(doc.uri.toString())?.resyncIfScanned());
      }
    }),
  ];
}

/**
 * Writes generated/ for a flow (ADR-0009). On save this is quiet unless something needs the user;
 * from the command, files edited by hand can be overwritten after a confirmation.
 */
/** What Generate Code came to, in a sentence (AFD-46). */
export function codegenNotice(outcome: CodegenOutcome): Notice {
  if (!outcome.ok) return { level: 'error', text: outcome.error ?? 'Code generation failed' };
  const n = outcome.written.length;
  const where = outcome.dir ? vscode.workspace.asRelativePath(outcome.dir) : 'generated';
  const kept = outcome.kept.length
    ? `; ${outcome.kept.length} edited by hand left as they are`
    : '';
  return {
    level: 'success',
    text: `${n > 0 ? `Generated ${n} file(s) in ${where}` : `${where} is up to date`}${kept}`,
  };
}

/** `quiet`: the caller says how it went (the designer, over its canvas), so no error pop-up. */
export async function writeCode(
  doc: vscode.TextDocument,
  deps: SessionDeps,
  explicit: boolean,
  quiet = false,
): Promise<CodegenOutcome> {
  let outcome = await generateFlow(doc, deps.schema);
  if (!outcome.ok) {
    if (explicit && quiet) return outcome;
    if (explicit) void vscode.window.showErrorMessage(outcome.error ?? 'Code generation failed');
    else vscode.window.setStatusBarMessage(`$(warning) ${outcome.error}`, 6000);
    return outcome;
  }
  if (outcome.kept.length > 0) {
    const names = outcome.kept.map((u) => vscode.workspace.asRelativePath(u)).join(', ');
    const overwrite = 'Overwrite';
    const asked = vscode.window.showWarningMessage(
      `Generated code was edited by hand and was not updated: ${names}`,
      { modal: explicit },
      overwrite,
    );
    // On save the answer may come much later (or never); the save path must not wait for it.
    if (!explicit) {
      // AFD-164: the forced generation's result is shown, as Generate Code shows it.
      void Promise.resolve(asked)
        .then(async (pick) => {
          if (pick !== overwrite) return;
          const forced = await generateFlow(doc, deps.schema, { force: true });
          if (forced.ok)
            vscode.window.setStatusBarMessage(`$(check) ${codegenNotice(forced).text}`, 4000);
          else void vscode.window.showErrorMessage(forced.error ?? 'Code generation failed');
        })
        .catch((e: unknown) => saveCodegenFailed(doc, e));
      return outcome;
    }
    if ((await asked) === overwrite) {
      const forced = await generateFlow(doc, deps.schema, { force: true });
      outcome = { ...forced, written: [...outcome.written, ...forced.written] };
    }
  }
  if (outcome.written.length > 0 || explicit)
    vscode.window.setStatusBarMessage(`$(check) ${codegenNotice(outcome).text}`, 4000);
  return outcome;
}

/** How long a save waits for Git's HEAD text before it uses the copy read before (AFD-164). */
const HEAD_BUDGET_MS = 700;

/** HEAD's text of each open flow, as last read (AFD-164). */
const heads = new Map<string, string | undefined>();

function prefetchHead(uri: vscode.Uri): Promise<string | undefined> {
  return headText(uri)
    .then((text) => {
      heads.set(uri.toString(), text);
      return text;
    })
    .catch(() => heads.get(uri.toString()));
}

/** HEAD's text, read now if Git answers within `ms`, else the copy read before. */
async function headWithin(uri: vscode.Uri, ms: number): Promise<string | undefined> {
  const known = heads.get(uri.toString());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string | undefined>((resolve) => {
    timer = setTimeout(() => resolve(known), ms);
  });
  try {
    return await Promise.race([prefetchHead(uri), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Codegen on save failed: a log line and a status bar message (AFD-164). */
function saveCodegenFailed(doc: vscode.TextDocument, e: unknown): CodegenOutcome {
  const error = e instanceof Error ? e.message : String(e);
  logChannel().error(
    `Generated code for ${vscode.workspace.asRelativePath(doc.uri)} failed on save: ${error}`,
  );
  vscode.window.setStatusBarMessage(`$(warning) Generated code not written: ${error}`, 8000);
  return { ok: false, error, written: [], kept: [], removed: [] };
}

async function diskText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/**
 * On save: tested nodes edited by hand since the file on disk are implemented again (decision 15),
 * and flow.version moves once relative to Git HEAD, or the last saved text (ADR-0006).
 */
async function saveEdits(
  document: vscode.TextDocument,
  lastSaved: string | undefined,
  own?: (text: string) => void,
): Promise<vscode.TextEdit[]> {
  const text = document.getText();
  const saved = (await diskText(document.uri)) ?? lastSaved;
  // AFD-164: VS Code gives a save participant about 1.5 s and drops one that keeps running over,
  // which would end the version bump and the tested drop-back for good. HEAD's text is read again
  // each save but waited for briefly; past that, the copy read before (on open or the last save).
  const base = (await headWithin(document.uri, HEAD_BUDGET_MS)) ?? lastSaved;
  let plan: ReturnType<typeof planSave>;
  try {
    plan = planSave(text, saved, base);
  } catch {
    return [];
  }
  announceImplementedAgain(parseFlow(text).doc, plan.dropped);
  // AFD-92: the text these edits make is the save's own, not an outside edit.
  if (plan.edits.length) own?.(applyEdits(text, plan.edits));
  return plan.edits.map((e) =>
    vscode.TextEdit.replace(
      new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)),
      e.newText,
    ),
  );
}
