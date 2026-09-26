import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { optionalEnv, profile } from "./env.js";

/** Runs a tool body and turns its return value (or thrown error) into an MCP result. */
export async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

// ---------- tool policy: MCP_READ_ONLY, MCP_ALLOW_TOOLS, MCP_DENY_TOOLS ----------

const globs = (s: string) =>
  s
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));

/** Tool names that only ever write (whole tool hidden in read-only mode). */
const WRITE_TOOL = /(^|_)(create|update|upsert|delete|remove|send|post|publish|upload|mutate|set_status|set|add|pause|launch|merge|convert|book|transition|trigger|import|apply|grant|revoke|share|invite|archive|move|duplicate|write|insert|load|copy|cancel|confirm|refund|schedule|submit|enable|disable)(_|$)/i;
/** Tool names that are read-only even though they contain a write-ish word. */
const READ_TOOL = /(^|_)(list|get|search|find|report|query|read|insights|overview|health|whoami|describe|metadata|preview|estimate|ideas|suggest|status|history|breakdown|pipeline|digest|compare|realtime|audit|check|lookup|stats|analytics|dashboard|aging)(_|$)/i;
/** `action` values that change data (multi-action tools stay listed but refuse these). */
const WRITE_ACTION = /^(create|update|upsert|delete|remove|send|submit|comment|edit|post|publish|upload|add|set|move|won|lost|reopen|restore|merge|convert|archive|unarchive|book|cancel|confirm|complete|done|pause|activate|launch|transition|invite|grant|revoke|share|enable|disable|record|mark|save|unsave|approve|trigger|import|apply|dismiss|duplicate|rename|join|leave|kick|install|rotate|quote|invoice|post_invoice|mass_update|load|export_to_gcs|log_call|schedule|stop|retry|start|toggle|attach|react|unreact|pin|unpin|note|message|reply)(_|$)/i;

export type ToolPolicy = { readOnly: boolean; allow: RegExp[]; deny: RegExp[] };
export function toolPolicy(): ToolPolicy {
  return { readOnly: /^(1|true|yes|on)$/i.test(optionalEnv("MCP_READ_ONLY")), allow: globs(optionalEnv("MCP_ALLOW_TOOLS")), deny: globs(optionalEnv("MCP_DENY_TOOLS")) };
}

const isWriteTool = (name: string) => WRITE_TOOL.test(name.replace(/^[a-z0-9]+_(ads_)?/, "")) && !READ_TOOL.test(name.replace(/^[a-z0-9]+_(ads_)?/, ""));

/** Whether a tool is visible under the policy. */
export function toolVisible(p: ToolPolicy, name: string): boolean {
  if (p.allow.length && !p.allow.some((r) => r.test(name))) return false;
  if (p.deny.some((r) => r.test(name))) return false;
  if (p.readOnly && (isWriteTool(name) || /_api$|_api_request$|^(n8n_workflow_save|gtm_revert|meta_graph_request)$/.test(name))) return false;
  return true;
}

/** Reason a call is refused, or undefined when allowed. */
export function callBlocked(p: ToolPolicy, name: string, args: Record<string, unknown> = {}): string | undefined {
  if (!toolVisible(p, name)) return `Tool ${name} is disabled by this server's policy (MCP_READ_ONLY / MCP_ALLOW_TOOLS / MCP_DENY_TOOLS)`;
  if (!p.readOnly) return undefined;
  const action = String(args.action ?? args.what ?? "");
  if (action && WRITE_ACTION.test(action)) return `Read-only mode: action "${action}" changes data and is disabled (unset MCP_READ_ONLY to allow it)`;
  if (args.confirm === true) return "Read-only mode: actions that need confirm are disabled";
  if (typeof args.method === "string" && args.method.toUpperCase() !== "GET") return "Read-only mode: only GET requests are allowed";
  return undefined;
}

/** Applies the policy to any MCP server (high-level McpServer or low-level Server). */
export function applyToolPolicy(server: McpServer | Server): void {
  const p = toolPolicy();
  if (!p.readOnly && !p.allow.length && !p.deny.length) return;
  const low = (server instanceof McpServer ? server.server : server) as unknown as { _requestHandlers: Map<string, (req: { params: Record<string, unknown> }, extra: unknown) => Promise<Record<string, unknown>>> };
  const list = low._requestHandlers.get("tools/list");
  const call = low._requestHandlers.get("tools/call");
  if (list)
    low._requestHandlers.set("tools/list", async (req, extra) => {
      const res = await list(req, extra);
      const tools = ((res.tools as Tool[]) ?? []).filter((t) => toolVisible(p, t.name)).map((t) => (p.readOnly ? { ...t, description: `${t.description ?? ""} [read-only mode: write actions are disabled]` } : t));
      return { ...res, tools };
    });
  if (call)
    low._requestHandlers.set("tools/call", async (req, extra) => {
      const reason = callBlocked(p, String(req.params.name), (req.params.arguments as Record<string, unknown>) ?? {});
      if (reason) return { content: [{ type: "text", text: `Error: ${reason}` }], isError: true };
      return call(req, extra);
    });
}

export async function startStdio(server: McpServer | Server, name: string): Promise<void> {
  applyToolPolicy(server);
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol, so log to stderr only.
  const p = toolPolicy();
  console.error(`${name} MCP server running on stdio${profile ? ` (profile ${profile})` : ""}${p.readOnly ? " [read-only]" : ""}`);
}
