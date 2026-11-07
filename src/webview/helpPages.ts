// The guide page each "?" link opens (AFD-73, ADR-0030). The host opens only pages of the guide.
export const HELP = {
  canvas: 'how-to/canvas-basics.md',
  patterns: 'how-to/ports-and-failure-patterns.md',
  binding: 'how-to/binding-and-catalog.md',
  io: 'how-to/data-between-steps.md',
  execution: 'how-to/polling-and-retries.md',
  runs: 'how-to/runs-and-environments.md',
  code: 'how-to/code-mode.md',
  lenses: 'how-to/lenses.md',
  scenarios: 'how-to/scenario-tests.md',
} as const;

export type HelpTopic = keyof typeof HELP;
