/**
 * Minimal OAuth 2.1 authorization server for the HTTP gateway, so apps that only do OAuth for custom
 * MCP connectors (claude.ai, ChatGPT, Le Chat…) can connect without a token in the URL:
 *
 *   - protected-resource and authorization-server metadata (RFC 9728 / RFC 8414)
 *   - dynamic client registration (RFC 7591), public clients only
 *   - authorization code + PKCE S256, refresh tokens with rotation
 *
 * The consent page asks for MCP_GATEWAY_TOKEN — whoever knows it can approve a connector, exactly like
 * the bearer/secret-path modes. Access tokens live 1 hour; refresh tokens 30 days. Only SHA-256 hashes
 * of tokens are stored (in <config>/.state/gateway-oauth.json).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { configRoot, optionalEnv } from "./env.js";

type ClientReg = { client_id: string; client_name?: string; redirect_uris: string[]; created: number };
type Grant = { client_id: string; expires: number; resource?: string };
type State = { clients: Record<string, ClientReg>; refresh: Record<string, Grant> };

const FILE = resolve(configRoot, ".state", "gateway-oauth.json");
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 300;

const state: State = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { clients: {}, refresh: {} };
const access = new Map<string, Grant>();
const codes = new Map<string, { client_id: string; redirect_uri: string; challenge: string; resource?: string; expires: number }>();

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const now = () => Math.floor(Date.now() / 1000);
function save() {
  for (const [k, g] of Object.entries(state.refresh)) if (g.expires < now()) delete state.refresh[k];
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Public base URL: MCP_GATEWAY_PUBLIC_URL, else the tunnel's forwarded host/proto, else the Host header. */
export function baseUrl(req: IncomingMessage): string {
  const fixed = optionalEnv("MCP_GATEWAY_PUBLIC_URL").replace(/\/+$/, "");
  if (fixed) return fixed;
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0].trim();
  return `${proto}://${host}`;
}

/** True if the bearer is a live OAuth access token issued by this gateway. */
export function validAccessToken(bearer?: string): boolean {
  if (!bearer) return false;
  const g = access.get(hash(bearer));
  if (!g) return false;
  if (g.expires < now()) {
    access.delete(hash(bearer));
    return false;
  }
  return true;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  void res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", ...headers }).end(JSON.stringify(body));
const oauthError = (res: ServerResponse, error: string, description: string, status = 400) => json(res, status, { error, error_description: description });

async function body(req: IncomingMessage): Promise<Record<string, string>> {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 100_000) throw new Error("Body too large");
  }
  if (String(req.headers["content-type"] ?? "").includes("application/json")) return raw ? JSON.parse(raw) : {};
  return Object.fromEntries(new URLSearchParams(raw));
}

const allowedRedirect = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || ((url.protocol === "http:") && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function consentPage(params: URLSearchParams, client: ClientReg, error?: string) {
  const hidden = [...params.entries()].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  const host = (() => {
    try {
      return new URL(params.get("redirect_uri") ?? "").host;
    } catch {
      return "?";
    }
  })();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve MCP connector</title>
<style>body{font:16px system-ui,sans-serif;max-width:440px;margin:60px auto;padding:0 16px;color:#222}input[type=password]{width:100%;padding:10px;font-size:16px;box-sizing:border-box}button{margin-top:12px;padding:10px 18px;font-size:16px;cursor:pointer}.err{color:#b00020}.muted{color:#666;font-size:14px}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.muted{color:#aaa}}</style></head>
<body><h2>Approve connector</h2><p><b>${esc(client.client_name ?? "An app")}</b> wants to use the tools on this AnalyticsDev MCP gateway.</p>
<p class="muted">It will return to <b>${esc(host)}</b>. Only approve if you started this connection yourself.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/authorize">${hidden}<label>Gateway token (MCP_GATEWAY_TOKEN from your .env)<br><input type="password" name="gateway_token" autocomplete="current-password" autofocus required></label><br><button type="submit">Approve</button></form></body></html>`;
}

/**
 * Handles OAuth endpoints. Returns true if the request was an OAuth request (and was answered).
 * `sameToken` checks the gateway's MCP_GATEWAY_TOKEN; `resources` lists the MCP paths served.
 */
export async function handleOAuth(req: IncomingMessage, res: ServerResponse, sameToken: (t?: string) => boolean): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://gateway");
  const p = url.pathname;
  const base = baseUrl(req);

  if (req.method === "OPTIONS" && (p.startsWith("/.well-known/") || ["/register", "/token"].includes(p))) {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version" }).end();
    return true;
  }
  if (p.startsWith("/.well-known/oauth-protected-resource")) {
    const resource = base + (p.slice("/.well-known/oauth-protected-resource".length) || "");
    json(res, 200, { resource, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] });
    return true;
  }
  if (p.startsWith("/.well-known/oauth-authorization-server") || p.startsWith("/.well-known/openid-configuration")) {
    json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
    return true;
  }
  if (p === "/register" && req.method === "POST") {
    const b = (await body(req)) as unknown as { redirect_uris?: string[]; client_name?: string };
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
    if (!uris.length || !uris.every(allowedRedirect)) return oauthError(res, "invalid_redirect_uri", "redirect_uris must be https (or http on localhost)"), true;
    if (Object.keys(state.clients).length > 200) return oauthError(res, "invalid_client_metadata", "too many registered clients"), true;
    const reg: ClientReg = { client_id: token("mcpc"), client_name: b.client_name?.slice(0, 100), redirect_uris: uris, created: now() };
    state.clients[reg.client_id] = reg;
    save();
    json(res, 201, { ...reg, client_id_issued_at: reg.created, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    return true;
  }
  if (p === "/authorize") {
    const params = req.method === "POST" ? new URLSearchParams(await body(req)) : url.searchParams;
    const client = state.clients[params.get("client_id") ?? ""];
    const redirect = params.get("redirect_uri") ?? "";
    if (!client || !client.redirect_uris.includes(redirect)) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("Unknown client or redirect_uri — remove and re-add the connector.");
      return true;
    }
    const back = (q: Record<string, string>) => {
      const u = new URL(redirect);
      for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
      if (params.get("state")) u.searchParams.set("state", params.get("state")!);
      res.writeHead(302, { Location: u.toString() }).end();
    };
    if (params.get("response_type") !== "code") return back({ error: "unsupported_response_type" }), true;
    if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) return back({ error: "invalid_request", error_description: "PKCE S256 required" }), true;
    if (req.method !== "POST") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" }).end(consentPage(params, client));
      return true;
    }
    const entered = params.get("gateway_token") ?? "";
    params.delete("gateway_token");
    if (!sameToken(entered)) {
      await new Promise((r) => setTimeout(r, 1000));
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" }).end(consentPage(params, client, "Wrong token."));
      return true;
    }
    const code = token("mcpcode");
    codes.set(hash(code), { client_id: client.client_id, redirect_uri: redirect, challenge: params.get("code_challenge")!, resource: params.get("resource") ?? undefined, expires: now() + CODE_TTL });
    console.error(`${new Date().toISOString()} OAuth: approved ${client.client_name ?? client.client_id}`);
    back({ code });
    return true;
  }
  if (p === "/token" && req.method === "POST") {
    const b = await body(req);
    const issue = (client_id: string, resource?: string) => {
      const at = token("mcpat");
      const rt = token("mcprt");
      access.set(hash(at), { client_id, resource, expires: now() + ACCESS_TTL });
      state.refresh[hash(rt)] = { client_id, resource, expires: now() + REFRESH_TTL };
      save();
      json(res, 200, { access_token: at, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: rt, scope: "mcp" });
    };
    if (b.grant_type === "authorization_code") {
      const c = codes.get(hash(b.code ?? ""));
      codes.delete(hash(b.code ?? ""));
      if (!c || c.expires < now() || c.client_id !== b.client_id || c.redirect_uri !== b.redirect_uri) return oauthError(res, "invalid_grant", "code is invalid or expired"), true;
      const expected = createHash("sha256").update(b.code_verifier ?? "").digest("base64url");
      if (expected.length !== c.challenge.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(c.challenge))) return oauthError(res, "invalid_grant", "PKCE verification failed"), true;
      issue(c.client_id, c.resource);
      return true;
    }
    if (b.grant_type === "refresh_token") {
      const key = hash(b.refresh_token ?? "");
      const g = state.refresh[key];
      if (!g || g.expires < now() || (b.client_id && g.client_id !== b.client_id)) return oauthError(res, "invalid_grant", "refresh token is invalid or expired"), true;
      delete state.refresh[key];
      issue(g.client_id, g.resource);
      return true;
    }
    oauthError(res, "unsupported_grant_type", "use authorization_code or refresh_token");
    return true;
  }
  return false;
}

/** Forget every OAuth client and refresh token (npm run serve -- --revoke-oauth). */
export function revokeAll() {
  state.clients = {};
  state.refresh = {};
  access.clear();
  save();
}
