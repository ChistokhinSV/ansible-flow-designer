// The flow tools for terminal agents (AFD-19): Claude Code, Codex CLI and Gemini CLI start this
// stdio MCP server (Set Up AI Assistants registers it). It shares the tool core with Copilot's
// tools; files are read and written on disk. stdout carries the protocol: log to stderr only.

import { appendFileSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { runTool } from '../core/ai/handlers';
import { TOOL_SPECS } from '../core/ai/specs';
import { createIdFactory } from '../core/flow/ids';
import { createSchemaValidator } from '../core/flow/schema';
import { FsFlowIO, startRoots } from './fsIO';

declare const __AFD_VERSION__: string;

const INSTRUCTIONS = `Tools for Ansible Flow Designer flows (*.flow.yaml): diagrams of typed nodes wired port to port that generate Ansible playbooks.
When the user asks for an Ansible flow, flow diagram or automation flow, build it with these tools as a .flow.yaml (flow_new, then flow_edit), not as a PlantUML, Mermaid or draw.io picture, even where other diagrams are drawn with those.
Read a flow with flow_describe before changing it, then change it with one flow_edit batch that names nodes by key (never IDs) and passes the revision. add_node with after: "start.ok_hosts" puts the first step of a new flow between start and done.
Rules: one wire per output port; wires stay on one level; handle every fail port (wire it, apply_pattern, or leave_open with a reason); never set status tested; do not edit flow.version or generated/.
Data passes through node inputs and outputs (set_io, from:): inside a subflow <subflow>.<input> reads its input; a from: path like precheck/normalize-facts.x is lifted to precheck for you.
Layout: leave positions out unless the user asks for an arrangement; the canvas places nodes without one. To arrange, pass position ({x, y}, or {below|above|right_of|left_of: node}) to add_node, or use move; flow_describe with layout: true shows where nodes are and runs a layout check (wires step round nodes where there is room; a wire still through a node, or a label on a node: fix those with move); unplace hands nodes back to automatic placement.
Notes, sections and text on the canvas (annotate, update_annotation; format 2) explain a flow and never run: a note on a node moves with it and becomes a comment above its code.
A draw.io file or an image of a flow: flow_export (draw.io with a page per level and the node details, or SVG), never a drawing by hand.
Existing playbooks, roles or AWX templates: read them with source_outline (each task's impl to copy), then design the flow by intent with flow_new and flow_edit; flow_import only for an exact copy.
Scenario tests (<key>.scenarios.yaml: which hosts fail where, and where each must end): flow_scenarios lists and checks them in a simulation, adds or updates them (expectations default to where the simulation sends each host) and verifies them in Ansible; after changing a flow's wiring, check its scenarios.
flow_reference explains the format, ports, patterns, ops and scenarios. The ansible-flow skill has the full rules and examples.`;

/**
 * AFD-172: AFD_MCP_TRACE=<file> appends one JSON line per event: the start (cwd, runtime), the
 * client (name, version, capabilities), its roots and each tool call (name, time, outcome; not its
 * arguments). For checking what an editor's agent sends; off unless set.
 */
const TRACE = process.env.AFD_MCP_TRACE;
function trace(event: string, data: Record<string, unknown> = {}): void {
  if (!TRACE) return;
  try {
    appendFileSync(
      TRACE,
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...data })}\n`,
    );
  } catch {
    // Tracing never stops the server.
  }
}

/**
 * AFD-195: an error the server did not handle, as one line on stderr (what the agent keeps in its
 * MCP log) and an error event in the trace. Written synchronously: exit may follow at once.
 */
function failure(where: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  trace('error', { where, message, ...(e instanceof Error ? { stack: e.stack } : {}) });
  try {
    writeSync(2, `ansible-flow: ${where}: ${message.replaceAll(/\s*\n\s*/g, ' ')}\n`);
  } catch {}
}
// A promise no one waited for does not stop the server; an exception that reached the top does,
// as Node would stop it (what state it left is unknown).
process.on('unhandledRejection', (e) => failure('unhandled rejection', e));
process.on('uncaughtException', (e) => {
  failure('uncaught exception', e);
  process.exit(1);
});

/**
 * AFD-172/173: the folders to work in until the client sends roots: AFD_MCP_ROOTS, else the working
 * directory unless that is the home folder or a drive root (startRoots). No agent checked sends
 * roots; Cursor starts global servers in the home folder.
 */
const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const START_ROOTS = startRoots(process.env.AFD_MCP_ROOTS, process.cwd(), homedir(), isDir);
const io = new FsFlowIO(START_ROOTS, createSchemaValidator(), createIdFactory());
trace('start', {
  version: __AFD_VERSION__,
  cwd: process.cwd(),
  node: process.versions.node,
  electron: process.versions.electron,
  givenRoots: process.env.AFD_MCP_ROOTS,
  roots: START_ROOTS,
});
const server = new Server(
  { name: 'ansible-flow', version: __AFD_VERSION__ },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

async function useClientRoots(): Promise<void> {
  if (!server.getClientCapabilities()?.roots) {
    trace('roots', { supported: false });
    return;
  }
  try {
    const { roots } = await server.listRoots();
    trace('roots', { supported: true, roots: roots.map((r) => r.uri) });
    io.setRoots(roots.filter((r) => r.uri.startsWith('file:')).map((r) => fileURLToPath(r.uri)));
  } catch (e) {
    trace('roots', { supported: true, error: (e as Error).message });
    console.error(
      `ansible-flow: roots not available (${(e as Error).message}); using ${process.cwd()}`,
    );
  }
}
server.oninitialized = () => {
  trace('initialized', {
    client: server.getClientVersion(),
    capabilities: server.getClientCapabilities(),
  });
  void useClientRoots();
};
server.setNotificationHandler('notifications/roots/list_changed', () => useClientRoots());

server.setRequestHandler('tools/list', async () => {
  // AFD-172: an agent that lists the tools and then shows none (Cursor's reported 0-tools case).
  trace('list', { tools: TOOL_SPECS.length });
  return {
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
        openWorldHint: s.openWorld ?? false,
      },
    })),
  };
});

// One call at a time: an edit reads, plans and writes a file without another edit in between.
let queue: Promise<unknown> = Promise.resolve();
server.setRequestHandler('tools/call', (request) => {
  const started = Date.now();
  const call = queue.then(async () => {
    try {
      const r = await runTool(io, request.params.name, request.params.arguments ?? {});
      trace('call', { tool: request.params.name, ms: Date.now() - started, ok: !r.isError });
      // AFD-165: an error names files relative to the roots, never by absolute path.
      return {
        content: [{ type: 'text' as const, text: r.isError ? io.hidePaths(r.text) : r.text }],
        ...(r.isError ? { isError: true } : {}),
      };
    } catch (e) {
      trace('call', { tool: request.params.name, ms: Date.now() - started, ok: false });
      trace('error', { where: `tools/call ${request.params.name}`, message: (e as Error).message });
      return {
        content: [{ type: 'text' as const, text: `Error: ${io.hidePaths((e as Error).message)}` }],
        isError: true,
      };
    }
  });
  queue = call.catch(() => undefined);
  return call;
});

// AFD-195: protocol errors (a message that does not parse, a failed send) go to the trace.
server.onerror = (e) => trace('error', { where: 'protocol', message: e.message });
server.connect(new StdioServerTransport()).catch((e: unknown) => {
  failure('connect', e);
  process.exit(1);
});
