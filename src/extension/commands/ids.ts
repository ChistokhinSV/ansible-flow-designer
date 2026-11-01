// Command ids (AFD-41): `afd.<area>.<verb>`, titled with the glossary's words
// (docs/guide/reference/glossary.md). The ids before 0.25 stay registered as hidden aliases until
// 0.27, so keybindings and links people made keep working; they are not in the Command Palette.
import * as vscode from 'vscode';

export const CMD = {
  newFlow: 'afd.flow.new',
  checkFlow: 'afd.flow.check',
  completeIds: 'afd.flow.completeIds',
  upgradeFormat: 'afd.flow.upgradeFormat',
  openInTextEditor: 'afd.flow.openInTextEditor',
  generateCode: 'afd.code.generate',
  tidyUp: 'afd.canvas.tidyUp',
  copyNodes: 'afd.edit.copy',
  pasteNodes: 'afd.edit.paste',
  runSkeleton: 'afd.run.skeleton',
  runReal: 'afd.run.real',
  stopRun: 'afd.run.stop',
  showAudit: 'afd.run.showAudit',
  importPlaybooks: 'afd.import.playbooks',
  importAwx: 'afd.import.awx',
  exportDrawio: 'afd.export.drawio',
  exportImage: 'afd.export.image',
  rebuildCatalog: 'afd.catalog.rebuild',
  awxLaunch: 'afd.awx.launch',
  awxSetupTemplate: 'afd.awx.setupTemplate',
  awxSetToken: 'afd.awx.setToken',
  awxClearToken: 'afd.awx.clearToken',
  setupAi: 'afd.ai.setup',
  removeAi: 'afd.ai.remove',
  openGuide: 'afd.help.openGuide',
  getStarted: 'afd.help.getStarted',
  openSample: 'afd.help.openSample',
} as const;

/** Old id → new id. Check Generated Code and Validate Design folded into Check Flow. */
export const ALIASES: Readonly<Record<string, string>> = {
  'afd.newFlow': CMD.newFlow,
  'afd.validate': CMD.checkFlow,
  'afd.syntaxCheck': CMD.checkFlow,
  'afd.completeIds': CMD.completeIds,
  'afd.openAsText': CMD.openInTextEditor,
  'afd.generate': CMD.generateCode,
  'afd.tidyUp': CMD.tidyUp,
  'afd.copyNodes': CMD.copyNodes,
  'afd.pasteNodes': CMD.pasteNodes,
  'afd.runSkeleton': CMD.runSkeleton,
  'afd.runReal': CMD.runReal,
  'afd.stopRun': CMD.stopRun,
  'afd.showAudit': CMD.showAudit,
  'afd.importPlaybooks': CMD.importPlaybooks,
  'afd.importAwxWorkflow': CMD.importAwx,
  'afd.exportDrawio': CMD.exportDrawio,
  'afd.exportImage': CMD.exportImage,
  'afd.setupAi': CMD.setupAi,
  'afd.removeAi': CMD.removeAi,
  'afd.openGuide': CMD.openGuide,
  'afd.openWalkthrough': CMD.getStarted,
  'afd.openSample': CMD.openSample,
};

/** Each old id runs its new command with the same arguments and returns what it returns. */
export function registerAliases(): vscode.Disposable[] {
  return Object.entries(ALIASES).map(([old, now]) =>
    vscode.commands.registerCommand(old, (...args: unknown[]) =>
      vscode.commands.executeCommand(now, ...args),
    ),
  );
}
