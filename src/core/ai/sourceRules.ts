// Which repository files the AI tools may read for an import (AFD-27), one rule set for both
// adapters (AFD-37): Copilot's tools in VS Code and the MCP server read the same kinds of files,
// skip the same folders and refuse the same sizes.

/** Ansible files the import tools read: YAML, AWX export JSON, ansible.cfg. */
export const SOURCE_FILE = /(\.ya?ml|\.json|(^|\/)ansible\.cfg)$/;

/** Larger files are not read (a playbook repository's files are far smaller). */
export const SOURCE_MAX_BYTES = 2 * 1024 * 1024;

/** Folders the tools never list or search: tools, builds, virtual environments, generated code. */
export const SKIP_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'generated',
  'out',
  'dist',
  '.vscode-test',
  '.venv',
  'venv',
  '.tox',
];

/** The skipped folders as a VS Code glob (`findFiles` exclude). */
export const SKIP_GLOB = `**/{${SKIP_DIRS.join(',')}}/**`;

/** A path the tools may read as an import source (forward slashes). */
export function isSourceFile(path: string): boolean {
  return SOURCE_FILE.test(path.replaceAll('\\', '/'));
}
