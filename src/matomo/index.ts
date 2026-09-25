#!/usr/bin/env node
/**
 * Matomo MCP server.
 * Local tools wrap the Reporting API (overview with comparisons, 40+ friendly reports, real-time,
 * visitor profiles, segment/site comparison, sites, goals, segments, annotations, users, Tag Manager).
 * When the official "MCP Server" plugin is installed on the Matomo instance, its tools are proxied
 * through the same connection using MATOMO_TOKEN as a Bearer token.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { optionalEnv } from "../shared/env.js";
import { startStdio } from "../shared/server.js";
import { baseUrl, officialMcpEnabled } from "./client.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerReportTools } from "./tools/reports.js";

async function connectLocal(): Promise<Client> {
  const local = new McpServer({ name: "matomo-local", version: "0.1.0" });
  registerReportTools(local);
  registerAdminTools(local);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await local.connect(serverSide);
  const client = new Client({ name: "matomo-proxy", version: "0.1.0" });
  await client.connect(clientSide);
  return client;
}

let remote: Promise<Client | { error: string }> | undefined;

/** Official MCP Server plugin, connected lazily; skipped when absent so the local tools always work. */
function connectRemote(): Promise<Client | { error: string }> {
  remote ??= (async () => {
    const token = optionalEnv("MATOMO_TOKEN");
    if (!token || !optionalEnv("MATOMO_URL")) return { error: "MATOMO_URL / MATOMO_TOKEN are not set in .env" };
    if (!officialMcpEnabled()) return { error: "Official Matomo MCP proxy is turned off (MATOMO_OFFICIAL_MCP=off)" };
    const url = `${baseUrl()}/index.php?module=API&method=McpServer.mcp&format=mcp`;
    try {
      const client = new Client({ name: "matomo-proxy", version: "0.1.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    } catch (error) {
      return { error: `Official Matomo MCP plugin not reachable (install "MCP Server" from the Marketplace, Matomo 5.8+): ${error instanceof Error ? error.message : String(error)}` };
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
  { name: "matomo", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "matomo_* tools use the Matomo Reporting API: start with matomo_overview (KPIs vs previous period), then matomo_report for pages, channels, campaigns, countries, devices, events, goals and ecommerce; matomo_realtime for live visitors; matomo_compare for segments or sites side by side. Dates default to the last 7 complete days. Tools from the official Matomo MCP plugin (if installed) are listed too.",
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

await startStdio(server, "matomo");
