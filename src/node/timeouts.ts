// How long the extension waits for things outside it (AFD-39: one place instead of constants in
// a dozen files). Values in milliseconds.

export const TIMEOUTS = {
  /** The probe's first answer: the first start may pull the image. */
  probeReady: 180_000,
  /** A probe call without a timeout of its own. */
  probeCall: 60_000,
  /** The inventory read for a run's confirmation or the Inventory lens. */
  probeInventory: 120_000,
  /** The roles of a repository (catalog, Code mode). */
  probeRoles: 120_000,
  /** Compiling the generated code and roles (Code mode, the syntax check). */
  probeCompile: 180_000,
  /** Reading every collection's docs for the module catalog. */
  catalogDump: 15 * 60_000,
  /** Indexing the collection docs in a worker (seconds for a full environment; AFD-163). */
  catalogIndex: 5 * 60_000,
  /** One AWX REST request without data (idle). */
  awxRequest: 30_000,
  /** One AWX REST request from start to end, however slowly the data comes (AFD-161). */
  awxRequestTotal: 120_000,
  /** Between two polls of a running AWX job, workflow or project update. */
  awxPoll: 2_000,
  /** A finished AWX job's events keep arriving for a while. */
  awxEventsGrace: 20_000,
  /** An AWX project update before a template is set up. */
  awxProjectSync: 180_000,
  /** AFD-276: one Ansible Flow Server request without data. */
  runnerRequest: 30_000,
  /** AFD-276: between two looks at a run on the server. */
  runnerPoll: 2_000,
  /** A designer panel loading (PNG export opens one). */
  designerReady: 30_000,
  /** A designer panel drawing a PNG. */
  designerPng: 60_000,
  /** Test mode: a designer panel's DOM summary. */
  designerInspect: 10_000,
  /** Typing in a text editor settles before the designer parses again. */
  typingSettles: 150,
} as const;
