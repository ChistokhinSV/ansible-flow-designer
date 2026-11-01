// Command ids (AFD-41): `afd.<area>.<verb>`, titled with the glossary's words
// (docs/guide/reference/glossary.md). The ids before 0.25 ran as hidden aliases through 0.27 and
// are gone since 0.28.

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
