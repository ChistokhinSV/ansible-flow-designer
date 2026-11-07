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
import { saveFollowed } from './run/scenarioFollow';

export function registerDocuments(host: Host): vscode.Disposable[] {
  const { sessions, lastSaved, savedCode, deps } = host;
  return [
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isFlow(doc)) void host.sessionFor(doc).refresh();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0) sessions.get(e.document.uri.toString())?.changed(e.reason);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString();
      sessions.get(key)?.dispose();
      sessions.delete(key);
      lastSaved.delete(key);
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
        const code = writeCode(doc, deps, false);
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
      void asked.then((pick) =>
        pick === overwrite ? generateFlow(doc, deps.schema, { force: true }) : undefined,
      );
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
  const base = (await headText(document.uri)) ?? lastSaved;
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
