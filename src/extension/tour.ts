// Walkthrough progress (AFD-22): designer edits set `afd.tour.*` context keys, which check off the
// steps of "Design your first Ansible flow" (`onContext` completion events in package.json).
import * as vscode from 'vscode';
import type { FlowCommand } from '../core/flow/commands';
import { isFailPort } from '../core/flow/ports';

/** The tour keys a successful command reaches. */
export function tourKeys(command: FlowCommand): string[] {
  switch (command.kind) {
    case 'addNode':
      return command.type === 'subflow' ? ['nodeAdded', 'subflow'] : ['nodeAdded'];
    case 'pasteNodes':
      return ['nodeAdded'];
    case 'applyPattern':
    case 'setDecision':
      return ['failureHandled'];
    case 'connect':
      return isFailPort(command.from.port) ? ['failureHandled'] : [];
    case 'extractSubflow':
      return ['subflow'];
    default:
      return [];
  }
}

const reached = new Set<string>();

/** The keys set so far (tests). */
export function tourReached(): string[] {
  return [...reached];
}

export function markTour(command: FlowCommand): void {
  for (const key of tourKeys(command)) {
    if (reached.has(key)) continue;
    reached.add(key);
    void vscode.commands.executeCommand('setContext', `afd.tour.${key}`, true);
  }
}
