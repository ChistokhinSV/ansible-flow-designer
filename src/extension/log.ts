// The extension's log (AFD-32): one "Ansible Flow" output channel with VS Code's log levels.
// The probe's lifecycle and stderr go here first; other areas move to it in AFD-37.
import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function logChannel(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('Ansible Flow', { log: true });
  return channel;
}
