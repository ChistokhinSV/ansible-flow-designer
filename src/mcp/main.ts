// The flow tools for terminal agents (AFD-19): Claude Code, Codex CLI and Gemini CLI start this
// stdio MCP server (Set Up AI Assistants registers it). It shares the tool core with Copilot's
// tools; files are read and written on disk. stdout carries the protocol: log to stderr only.

import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { runTool } from '../core/ai/handlers';
import { TOOL_SPECS } from '../core/ai/specs';
import { createIdFactory } from '../core/flow/ids';
import { createSchemaValidator } from '../core/flow/schema';
import { FsFlowIO } from './fsIO';

declare const __AFD_VERSION__: string;

const INSTRUCTIONS = `Tools for Ansible Flow Designer flows (*.flow.yaml): diagrams of typed nodes wired port to port that generate Ansible playbooks.
When the user asks for an Ansible flow, flow diagram or automation flow, build it with these tools as a .flow.yaml (flow_new, then flow_edit), not as a PlantUML, Mermaid or draw.io picture, even where other diagrams are drawn with those.
Read a flow with flow_describe before changing it, then change it with one flow_edit batch that names nodes by key (never IDs) and passes the revision. add_node with after: "start.ok_hosts" puts the first step of a new flow between start and done.
Rules: one wire per output port; wires stay on one level; handle every fail port (wire it, apply_pattern, or leave_open with a reason); never set status tested; do not edit flow.version or generated/.
flow_reference explains the format, ports, patterns and ops. The ansible-flow skill has the full rules and examples.`;

const io = new FsFlowIO([process.cwd()], createSchemaValidator(), createIdFactory());
const server = new Server(
  { name: 'ansible-flow', version: __AFD_VERSION__ },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

async function useClientRoots(): Promise<void> {
  if (!server.getClientCapabilities()?.roots) return;
  try {
    const { roots } = await server.listRoots();
    io.setRoots(roots.filter((r) => r.uri.startsWith('file:')).map((r) => fileURLToPath(r.uri)));
  } catch (e) {
    console.error(
      `ansible-flow: roots not available (${(e as Error).message}); using ${process.cwd()}`,
    );
  }
}
server.oninitialized = () => void useClientRoots();
server.setNotificationHandler('notifications/roots/list_changed', () => useClientRoots());

server.setRequestHandler('tools/list', async () => ({
  tools: TOOL_SPECS.map((s) => ({
    name: s.name,
    title: s.title,
    description: s.description,
    inputSchema: s.inputSchema as { type: 'object' },
    annotations: {
      title: s.title,
      readOnlyHint: s.readOnly,
      destructiveHint: false,
      idempotentHint: s.readOnly,
      openWorldHint: false,
    },
  })),
}));

// One call at a time: an edit reads, plans and writes a file without another edit in between.
let queue: Promise<unknown> = Promise.resolve();
server.setRequestHandler('tools/call', (request) => {
  const call = queue.then(async () => {
    try {
      const r = await runTool(io, request.params.name, request.params.arguments ?? {});
      return {
        content: [{ type: 'text' as const, text: r.text }],
        ...(r.isError ? { isError: true } : {}),
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });
  queue = call.catch(() => undefined);
  return call;
});

void server.connect(new StdioServerTransport());
