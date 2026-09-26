#!/usr/bin/env node
/**
 * Serves local stdio servers over Streamable HTTP for apps that only accept a URL
 * (ChatGPT, claude.ai web/mobile, Le Chat, Open WebUI, Copilot Studio…):
 *
 *   npm run serve -- meta,ga4 [--port 8787] [--host 127.0.0.1] [--allow "ga4_run_*,meta_get_*"] [--deny "*_delete*"]
 *
 * Each server is at /<name>/mcp (Authorization: Bearer <MCP_GATEWAY_TOKEN>) and /<token>/<name>/mcp
 * (secret-path, for apps that can't send headers). With --oauth (or MCP_GATEWAY_OAUTH=true) /<name>/mcp
 * also accepts OAuth 2.1 access tokens, so claude.ai / ChatGPT connectors can sign in with the gateway
 * token on a consent page instead of putting it in the URL (see gateway-oauth.ts). It listens on localhost only; put an HTTPS tunnel
 * (cloudflared, ngrok, Tailscale Funnel) in front to reach it from the internet.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { optionalEnv, projectEnv, saveEnv } from "./env.js";
import { baseUrl, handleOAuth, revokeAll, validAccessToken } from "./gateway-oauth.js";
import { entry, pick, projectRoot, type ServerInfo } from "./servers.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const BOOLEAN_FLAGS = new Set(["--oauth", "--revoke-oauth"]);
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(all[i - 1]?.startsWith("--") && !BOOLEAN_FLAGS.has(all[i - 1])));
const port = Number(flag("port") ?? optionalEnv("MCP_GATEWAY_PORT", "8787"));
const host = flag("host") ?? optionalEnv("MCP_GATEWAY_HOST", "127.0.0.1");
const globs = (s?: string) => (s ?? "").split(",").map((g) => g.trim()).filter(Boolean).map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
const allow = globs(flag("allow") ?? optionalEnv("MCP_GATEWAY_ALLOW"));
const deny = globs(flag("deny") ?? optionalEnv("MCP_GATEWAY_DENY"));
const oauth = process.argv.includes("--oauth") || /^(1|true|yes)$/i.test(optionalEnv("MCP_GATEWAY_OAUTH"));
if (process.argv.includes("--revoke-oauth")) {
  revokeAll();
  console.error("Removed every OAuth client and refresh token; connectors must sign in again.");
}
const permitted = (tool: string) => (!allow.length || allow.some((r) => r.test(tool))) && !deny.some((r) => r.test(tool));

let token = optionalEnv("MCP_GATEWAY_TOKEN");
if (!token) {
  token = randomBytes(24).toString("hex");
  saveEnv("MCP_GATEWAY_TOKEN", token);
  console.error(`Created MCP_GATEWAY_TOKEN in ${projectEnv}`);
}
const tokenBuf = Buffer.from(token);
const sameToken = (t?: string) => !!t && t.length === token!.length && timingSafeEqual(Buffer.from(t), tokenBuf);

const servers = pick(positional);
if (!servers.length) {
  console.error("No built servers — run `npm run build`, then e.g. `npm run serve -- ga4,meta`.");
  process.exit(1);
}

/** One long-lived stdio child per server, shared by all HTTP requests. */
const children = new Map<string, Promise<{ client: Client; tools: Tool[] }>>();
function child(s: ServerInfo) {
  if (!children.has(s.name)) {
    const p = (async () => {
      const client = new Client({ name: `gateway-${s.name}`, version: "0.1.0" });
      const transport = new StdioClientTransport({ command: process.execPath, args: [entry(s)], cwd: projectRoot, env: process.env as Record<string, string>, stderr: "inherit" });
      transport.onclose = () => children.delete(s.name);
      await client.connect(transport);
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return { client, tools: tools.filter((t) => permitted(t.name)) };
    })();
    p.catch(() => children.delete(s.name));
    children.set(s.name, p);
  }
  return children.get(s.name)!;
}

function mcpServerFor(s: ServerInfo): Server {
  const server = new Server({ name: s.name, version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await child(s)).tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { client, tools } = await child(s);
    if (!tools.some((t) => t.name === req.params.name)) return { content: [{ type: "text", text: `Error: tool ${req.params.name} is not enabled on this gateway` }], isError: true };
    console.error(`${new Date().toISOString()} ${s.name} → ${req.params.name}`);
    return client.callTool(req.params);
  });
  return server;
}

const bearer = (req: IncomingMessage) => req.headers.authorization?.replace(/^Bearer\s+/i, "");

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000_000) throw new Error("Body too large");
  }
  return body ? JSON.parse(body) : undefined;
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://gateway");
  const parts = url.pathname.split("/").filter(Boolean);
  if (oauth && (await handleOAuth(req, res, sameToken).catch((e) => (res.headersSent || res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid_request", error_description: e instanceof Error ? e.message : String(e) })), true)))) return;
  if (url.pathname === "/health") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, servers: servers.map((s) => s.name) }));
  // /<token>/<name>/mcp  or  /<name>/mcp with a bearer token
  let name: string | undefined;
  if (parts.length === 3 && parts[2] === "mcp" && sameToken(parts[0])) name = parts[1];
  else if (parts.length === 2 && parts[1] === "mcp" && (sameToken(bearer(req)) || (oauth && validAccessToken(bearer(req))))) name = parts[0];
  else if (parts.at(-1) === "mcp")
    return void res
      .writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": oauth ? `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource${url.pathname}"` : "Bearer" })
      .end(JSON.stringify({ error: "unauthorized" }));
  const s = servers.find((x) => x.name === name);
  if (!s) return void res.writeHead(404).end("Not found");
  if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null }));
  try {
    const body = await readJson(req);
    const server = mcpServerFor(s);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: error instanceof Error ? error.message : String(error) }, id: null }));
  }
});

http.listen(port, host, () => {
  console.error(`MCP gateway on http://${host}:${port}`);
  for (const s of servers) console.error(`  ${s.name.padEnd(14)} http://${host}:${port}/${s.name}/mcp   (Bearer token)   ·   http://${host}:${port}/<token>/${s.name}/mcp`);
  console.error(`Token: MCP_GATEWAY_TOKEN in ${projectEnv}${allow.length || deny.length ? `\nTool filter: allow=${flag("allow") || optionalEnv("MCP_GATEWAY_ALLOW") || "*"} deny=${flag("deny") || optionalEnv("MCP_GATEWAY_DENY") || "-"}` : ""}`);
  if (oauth) console.error(`OAuth on: add ${optionalEnv("MCP_GATEWAY_PUBLIC_URL") || "https://<your-tunnel>"}/<server>/mcp as a custom connector and approve with the gateway token. Revoke all with --revoke-oauth.`);
  if (host !== "127.0.0.1" && host !== "localhost") console.error("WARNING: listening beyond localhost — anyone who can reach this port and has the token controls these accounts.");
});
