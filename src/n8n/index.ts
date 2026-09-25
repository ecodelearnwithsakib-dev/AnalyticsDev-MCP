#!/usr/bin/env node
/**
 * n8n MCP server.
 * Local tools cover the whole public REST API (every workflow, executions, credentials, data tables,
 * projects, users, audit, source control). When N8N_MCP_TOKEN is set, every tool of n8n's native
 * instance-level MCP server (<N8N_URL>/mcp-server/http: build, validate, test and run workflows,
 * data tables, agents) is proxied through the same connection, so the token stays in .env.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { optionalEnv } from "../shared/env.js";
import { startStdio } from "../shared/server.js";
import { instanceUrl } from "./client.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerExecutionTools } from "./tools/executions.js";
import { registerWorkflowTools } from "./tools/workflows.js";

async function connectLocal(): Promise<Client> {
  const local = new McpServer({ name: "n8n-local", version: "0.1.0" });
  registerWorkflowTools(local);
  registerExecutionTools(local);
  registerAdminTools(local);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await local.connect(serverSide);
  const client = new Client({ name: "n8n-proxy", version: "0.1.0" });
  await client.connect(clientSide);
  return client;
}

let remote: Promise<Client | { error: string }> | undefined;

/** Connect lazily so the server starts instantly and the REST tools work without the MCP token. */
function connectRemote(): Promise<Client | { error: string }> {
  remote ??= (async () => {
    const token = optionalEnv("N8N_MCP_TOKEN");
    if (!token) return { error: "N8N_MCP_TOKEN is not set in .env, so n8n's native MCP tools (build/validate/test workflows) are unavailable." };
    let url: string;
    try {
      url = `${instanceUrl()}/mcp-server/http`;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const client = new Client({ name: "n8n-proxy", version: "0.1.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    } catch (error) {
      remote = undefined; // retry on the next request
      return { error: `Could not reach n8n MCP (${url}) — is instance-level MCP enabled? ${error instanceof Error ? error.message : String(error)}` };
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
  { name: "n8n", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "n8n_* tools use the public REST API and see every workflow: list/export/import/update, publish, enable MCP access, executions (explain, failure digest, retry), credentials (secrets from .env), data tables, projects, users, audit, source control. Tools without the n8n_ prefix come from n8n's native MCP server (build workflows from code, validate, test with pin data, execute MCP-enabled workflows, agents). To build a workflow: search_nodes / get_node_types → create_workflow_from_code → validate_workflow → test_workflow → publish_workflow. New workflows stay unpublished until you publish them.",
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

await startStdio(server, "n8n");
