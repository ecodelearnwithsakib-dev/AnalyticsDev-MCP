#!/usr/bin/env node
/**
 * Slack MCP server.
 * Local tools cover the Slack Web API with your user token (messages, search, channels, people,
 * files, canvases, reminders, user groups, digest). The same token is also used to proxy every tool
 * of Slack's official MCP server (https://mcp.slack.com/mcp) when the Slack app has MCP turned on,
 * so nothing but .env holds the token.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { optionalEnv } from "../shared/env.js";
import { startStdio } from "../shared/server.js";
import { registerMessageTools } from "./tools/messages.js";
import { registerWorkspaceTools } from "./tools/workspace.js";

const REMOTE_URL = optionalEnv("SLACK_MCP_URL", "https://mcp.slack.com/mcp");

async function connectLocal(): Promise<Client> {
  const local = new McpServer({ name: "slack-local", version: "0.1.0" });
  registerMessageTools(local);
  registerWorkspaceTools(local);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await local.connect(serverSide);
  const client = new Client({ name: "slack-proxy", version: "0.1.0" });
  await client.connect(clientSide);
  return client;
}

let remote: Promise<Client | { error: string }> | undefined;

/** Official Slack MCP, connected lazily; skipped when disabled or unreachable so local tools always work. */
function connectRemote(): Promise<Client | { error: string }> {
  remote ??= (async () => {
    const token = optionalEnv("SLACK_USER_TOKEN");
    if (!token) return { error: "SLACK_USER_TOKEN is not set in .env" };
    if (optionalEnv("SLACK_OFFICIAL_MCP").toLowerCase() === "off") return { error: "Official Slack MCP proxy is turned off (SLACK_OFFICIAL_MCP=off)" };
    try {
      const client = new Client({ name: "slack-proxy", version: "0.1.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(REMOTE_URL), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    } catch (error) {
      return { error: `Official Slack MCP unavailable (turn on "Model Context Protocol" under Agents & AI Apps in your Slack app): ${error instanceof Error ? error.message : String(error)}` };
    }
  })();
  return remote;
}

async function listAll(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

const local = await connectLocal();
const localTools = await listAll(local);
const localNames = new Set(localTools.map((t) => t.name));

const server = new Server(
  { name: "slack", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "slack_* tools use the Slack Web API as you (user token): send/schedule/read/search messages, channels, people and status, files, canvases, reminders, bookmarks, user groups and a catch-up digest. Channels can be given as #name, people as @name, email or \"me\". Other tools (if listed) come from Slack's official MCP server. Always show the user a message before sending it on their behalf unless they asked to send it directly.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const upstream = await connectRemote();
  const remoteTools = upstream instanceof Client ? (await listAll(upstream)).filter((t) => !localNames.has(t.name)) : [];
  return { tools: [...localTools, ...remoteTools] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (localNames.has(request.params.name)) return local.callTool(request.params);
  const upstream = await connectRemote();
  if (!(upstream instanceof Client)) return { content: [{ type: "text", text: `Error: ${upstream.error}` }], isError: true };
  return upstream.callTool(request.params);
});

await startStdio(server, "slack");
