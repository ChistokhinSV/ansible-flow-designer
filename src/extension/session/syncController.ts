// Implementation mode's code sync (M6; AFD-38: out of FlowSession): compile the generated code
// and the bound roles in the environment, keep the last scan, re-sync after a save, and run the
// drift actions that change files.
import * as vscode from 'vscode';
import type { CodeScan, DriftAction } from '../../core/drift/types';
import type { FlowCommand } from '../../core/flow/commands';
import type { HostMessage, Snapshot } from '../../core/protocol';
import { CMD } from '../commands/ids';
import type { CommandOutcome, SessionDeps } from '../flowSession';
import { scanFlow } from '../sync/codeSync';
import { generateStub, writeSpecs } from '../sync/driftActions';

export class SyncController {
  /** The last code sync; a save re-syncs once there is one. */
  lastScan?: CodeScan;
  private syncing?: Promise<void>;

  constructor(
    private readonly uri: vscode.Uri,
    private readonly deps: SessionDeps,
    private readonly broadcast: (message: HostMessage) => void,
    private readonly snapshot: () => Promise<Snapshot>,
    private readonly runCommand: (
      command: FlowCommand,
      extra?: (edit: vscode.WorkspaceEdit) => void,
    ) => Promise<CommandOutcome>,
  ) {}

  /** Re-sync from git: compile the code in the environment and push the scan to the panels. */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    const run = async () => {
      const snapshot = await this.snapshot();
      if (!snapshot.doc || !this.deps.sync) return;
      this.broadcast({ type: 'sync', state: 'syncing', scan: this.lastScan });
      try {
        this.lastScan = await scanFlow(this.uri, snapshot.doc, this.deps.sync);
        this.broadcast({ type: 'sync', state: 'done', scan: this.lastScan });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.broadcast({ type: 'sync', state: 'error', scan: this.lastScan, error });
      }
    };
    this.syncing = run().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  /** Test mode: a scan from elsewhere (no probe). */
  useScan(scan: CodeScan): void {
    this.lastScan = scan;
    this.broadcast({ type: 'sync', state: 'done', scan });
  }

  async driftAction(action: DriftAction): Promise<CommandOutcome> {
    const doc = (await this.snapshot()).doc;
    if (!doc) return { ok: false, error: 'The flow does not parse' };
    const host = { uri: this.uri, doc, runCommand: this.runCommand };
    let outcome: CommandOutcome;
    switch (action.kind) {
      case 'generateStub':
        outcome = await generateStub(host, action.node, action.role);
        break;
      case 'writeSpecs':
        outcome = await writeSpecs(host, action.node, this.lastScan);
        break;
      case 'resync':
        await this.sync();
        return { ok: true };
      case 'regenerate':
        await vscode.commands.executeCommand(CMD.generateCode, this.uri);
        outcome = { ok: true };
        break;
      default:
        return { ok: false, error: `${action.kind} is not a host action` };
    }
    if (outcome.ok) void this.sync();
    return outcome;
  }
}
