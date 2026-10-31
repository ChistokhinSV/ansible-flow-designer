// Hands an import prompt to an AI assistant (AFD-27, decision 4): Copilot Chat in agent mode with the
// prompt filled in (the user sends it), or the clipboard for Claude Code, Codex and the others. The
// prompt is always on the clipboard too, so nothing is lost when the chat cannot open.
import * as vscode from 'vscode';

export type ImportMode = 'as-is' | 'ai';

/** As is, or with an AI assistant; undefined when cancelled. */
export async function pickMode(what: string): Promise<ImportMode | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: 'As is',
        description: 'one step per task, in the order the source runs them',
        mode: 'as-is' as const,
      },
      {
        label: 'With an AI assistant',
        description: 'a design by intent: subflows by purpose, the same modules and parameters',
        mode: 'ai' as const,
      },
    ],
    { title: `Import ${what}`, placeHolder: 'How should the flow be made?' },
  );
  return pick?.mode;
}

export type AiStart = 'chat' | 'clipboard' | 'cancelled';

export async function startAiImport(prompt: string, via?: 'chat' | 'clipboard'): Promise<AiStart> {
  await vscode.env.clipboard.writeText(prompt);
  const copilot = !!vscode.extensions.getExtension('GitHub.copilot-chat');
  let target = via;
  if (!target) {
    const options = [
      ...(copilot
        ? [
            {
              label: 'Copilot Chat',
              description: 'agent mode, the prompt ready to send',
              via: 'chat' as const,
            },
          ]
        : []),
      {
        label: 'Another AI assistant',
        description: 'Claude Code, Codex, Gemini CLI…: the prompt is on the clipboard to paste',
        via: 'clipboard' as const,
      },
    ];
    const pick =
      options.length === 1
        ? options[0]
        : await vscode.window.showQuickPick(options, { title: 'Design the flow with' });
    if (!pick) return 'cancelled';
    target = pick.via;
  }
  if (target === 'chat') {
    try {
      // isPartialQuery fills the chat input without sending it: the user reads and sends.
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
        mode: 'agent',
        isPartialQuery: true,
      });
      return 'chat';
    } catch {
      // Falls through to the clipboard message.
    }
  }
  const setup = 'Set Up AI Assistants…';
  void vscode.window
    .showInformationMessage(
      'The import prompt is on the clipboard: paste it into your AI assistant. It uses the Ansible Flow tools (source_outline, flow_new, flow_edit); Set Up AI Assistants gives them to Claude Code, Codex and others.',
      setup,
    )
    .then((p) => (p === setup ? vscode.commands.executeCommand('afd.setupAi') : undefined));
  return 'clipboard';
}
