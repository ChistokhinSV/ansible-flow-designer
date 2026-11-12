// Command ids (AFD-41): `afd.<area>.<verb>`, titled with the glossary's words
// (docs/guide/reference/glossary.md). The ids before 0.25 ran as hidden aliases through 0.27 and
// are gone since 0.28.

export const CMD = {
  newFlow: 'afd.flow.new',
  checkFlow: 'afd.flow.check',
  completeIds: 'afd.flow.completeIds',
  upgradeFormat: 'afd.flow.upgradeFormat',
  insertShared: 'afd.flow.insertShared',
  updateShared: 'afd.flow.updateShared',
  unlinkShared: 'afd.flow.unlinkShared',
  /** The Problems panel's quick fix on a warning (AFD-51); not in the Command Palette. */
  acceptProblem: 'afd.flow.acceptProblem',
  openInTextEditor: 'afd.flow.openInTextEditor',
  generateCode: 'afd.code.generate',
  tidyUp: 'afd.canvas.tidyUp',
  copyNodes: 'afd.edit.copy',
  pasteNodes: 'afd.edit.paste',
  runSkeleton: 'afd.run.skeleton',
  runReal: 'afd.run.real',
  /** AFD-82: the designer's Run and Ctrl+F5: its launch dialog; not in the Command Palette. */
  runLaunch: 'afd.run.launch',
  /** AFD-82: Run in a launch dialog, with its single-use token; not in the Command Palette. */
  runLaunched: 'afd.run.launched',
  /** AFD-244: a skeleton run from a step on, or of one step; from the designer's menus only. */
  runPartial: 'afd.run.partial',
  stopRun: 'afd.run.stop',
  runScenarios: 'afd.run.scenarios',
  copyScenarioRunner: 'afd.run.copyScenarioRunner',
  showAudit: 'afd.run.showAudit',
  importPlaybooks: 'afd.import.playbooks',
  reimport: 'afd.import.reimport',
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
  diagnoseAi: 'afd.ai.diagnose',
  setUpEnvironment: 'afd.environment.setup',
  copyFileToHost: 'afd.environment.copyFile',
  switchEnvironment: 'afd.environment.switch',
  switchInventory: 'afd.inventory.switch',
  openGuide: 'afd.help.openGuide',
  getStarted: 'afd.help.getStarted',
  openSample: 'afd.help.openSample',
  /** AFD-201: the feedback form, and GitHub's issue chooser. */
  sendFeedback: 'afd.help.feedback',
  reportIssue: 'afd.help.reportIssue',
} as const;
