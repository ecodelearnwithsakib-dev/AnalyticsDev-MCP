#!/usr/bin/env node
/**
 * Stape + server-side GTM MCP server.
 * Serves local sGTM testing tools and, when STAPE_API_KEY is set, proxies every tool of
 * Stape's official remote MCP server (https://mcp.stape.ai/mcp), so the API key stays in .env.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { optionalEnv } from "../shared/env.js";
import { startStdio } from "../shared/server.js";
import { registerSgtmTools } from "./sgtm.js";

const REMOTE_URL = optionalEnv("STAPE_MCP_URL", "https://mcp.stape.ai/mcp");

async function connectLocal(): Promise<Client> {
  const local = new McpServer({ name: "stape-local", version: "0.2.0" });
  registerSgtmTools(local);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await local.connect(serverSide);
  const client = new Client({ name: "stape-proxy", version: "0.2.0" });
  await client.connect(clientSide);
  return client;
}

let remote: Promise<Client | { error: string }> | undefined;

/** Connect lazily so the server starts instantly and still works offline / without a key. */
function connectRemote(): Promise<Client | { error: string }> {
  remote ??= (async () => {
    const apiKey = optionalEnv("STAPE_API_KEY");
    if (!apiKey) return { error: "STAPE_API_KEY is not set in .env, so the official Stape tools are unavailable." };
    const headers: Record<string, string> = { Authorization: apiKey };
    if (optionalEnv("STAPE_REGION").toUpperCase() === "EU") headers["X-Stape-Region"] = "EU";
    try {
      const client = new Client({ name: "stape-proxy", version: "0.2.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(REMOTE_URL), { requestInit: { headers } }));
      return client;
    } catch (error) {
      remote = undefined; // retry on the next request
      return { error: `Could not reach Stape MCP (${REMOTE_URL}): ${error instanceof Error ? error.message : String(error)}` };
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
  { name: "stape", version: "0.2.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "sgtm_* tools test a server-side GTM tagging server directly. stape_* tools (when STAPE_API_KEY is set) manage the Stape account: containers, domains, power-ups, logs, monitoring, statistics, billing, users and Stape Score. Destructive Stape actions require confirm: true.",
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
  if (!(upstream instanceof Client)) {
    return { content: [{ type: "text", text: `Error: ${upstream.error}` }], isError: true };
  }
  return upstream.callTool(request.params);
});

await startStdio(server, "stape");
