// package.json entries derived from the tool specs (AFD-19): `just gen-ai` writes them and a test
// keeps package.json equal to them, so Copilot sees the same tools as MCP clients.
import { TOOL_SPECS, type ToolSpec } from './specs';

/** Copilot tool names carry the extension prefix (VS Code naming guideline). */
export const COPILOT_PREFIX = 'afd_';

const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export function languageModelTool(spec: ToolSpec) {
  return {
    name: `${COPILOT_PREFIX}${spec.name}`,
    displayName: spec.title,
    toolReferenceName: camel(spec.name),
    canBeReferencedInPrompt: true,
    icon: '$(type-hierarchy)',
    tags: ['ansible-flow'],
    userDescription: spec.description,
    modelDescription: `${spec.description} Ansible Flow Designer flows (*.flow.yaml); see the ansible-flow skill.`,
    inputSchema: spec.inputSchema,
  };
}

export function languageModelTools() {
  return TOOL_SPECS.map(languageModelTool);
}
