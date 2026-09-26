import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Variables that would make servers reach real services during tests. */
const BLANK = ["SLACK_OFFICIAL_MCP", "MATOMO_OFFICIAL_MCP", "STAPE_API_KEY", "N8N_MCP_TOKEN", "SLACK_USER_TOKEN", "MATOMO_TOKEN", "MCP_PROFILE", "MCP_READ_ONLY", "MCP_ALLOW_TOOLS", "MCP_DENY_TOOLS"];

/** Starts dist/<dir>/index.js over stdio with a clean environment plus `env`. */
export async function connect(dir, env = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !BLANK.includes(k)));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL(`../dist/${dir}/index.js`, import.meta.url).pathname],
    env: { ...base, ...Object.fromEntries(BLANK.map((k) => [k, ""])), SLACK_OFFICIAL_MCP: "off", MATOMO_OFFICIAL_MCP: "off", ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  return client;
}

export async function listAll(client) {
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

export async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: !!r.isError, text, data };
}

/** Tiny mock HTTP API: routes = { "GET /path": (req, body, url) => [status, json] | json }. */
export async function mockApi(routes) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url, "http://mock");
    log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
    const handler = routes[`${req.method} ${url.pathname}`] ?? routes[url.pathname];
    let out = handler === undefined ? [404, { error: `not mocked: ${req.method} ${url.pathname}` }] : typeof handler === "function" ? await handler(req, body, url) : handler;
    if (!Array.isArray(out)) out = [200, out];
    res.writeHead(out[0], { "content-type": "application/json" });
    res.end(typeof out[1] === "string" ? out[1] : JSON.stringify(out[1]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, log, close: () => server.close() };
}
