import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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

export async function startStdio(server: McpServer, name: string): Promise<void> {
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol, so log to stderr only.
  console.error(`${name} MCP server running on stdio`);
}
