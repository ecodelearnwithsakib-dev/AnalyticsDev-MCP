import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

async function startGateway(home, port) {
  const proc = spawn(process.execPath, [new URL("../dist/shared/http-gateway.js", import.meta.url).pathname, "clarity", "--port", String(port), "--oauth"], { env: { ...process.env, MCP_HOME: home, MCP_PROFILE: "", MCP_GATEWAY_PUBLIC_URL: "", MCP_GATEWAY_OAUTH: "" }, stdio: ["ignore", "ignore", "pipe"] });
  await new Promise((ok, fail) => {
    let err = "";
    proc.stderr.on("data", (d) => {
      err += d;
      if (err.includes("MCP gateway on")) ok();
    });
    proc.on("exit", (c) => fail(new Error(`gateway exited ${c}: ${err}`)));
  });
  return proc;
}

test("gateway: OAuth flow (DCR → consent → PKCE → token → refresh) and bearer/secret-path modes", { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-home-"));
  writeFileSync(join(home, ".env"), "MCP_GATEWAY_TOKEN=gw-test-token-1234567890\n");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const proc = await startGateway(home, port);
  const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body), redirect: "manual" });
  const form = (path, data) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data), redirect: "manual" });
  try {
    // unauthenticated → 401 pointing at resource metadata
    const r401 = await post("/clarity/mcp", INIT);
    assert.equal(r401.status, 401);
    assert.match(r401.headers.get("www-authenticate"), /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/clarity\/mcp"/);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/clarity/mcp`)).json();
    assert.equal(prm.resource, `${base}/clarity/mcp`);
    const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);

    // bad redirect rejected, good one registered
    assert.equal((await post("/register", { redirect_uris: ["http://evil.example/cb"] })).status, 400);
    const reg = await (await post("/register", { client_name: "Test app", redirect_uris: ["https://app.example/callback"] })).json();
    assert.match(reg.client_id, /^mcpc_/);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = { response_type: "code", client_id: reg.client_id, redirect_uri: "https://app.example/callback", code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${base}/clarity/mcp` };
    const page = await fetch(`${base}/authorize?${new URLSearchParams(q)}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Test app/);
    assert.equal((await form("/authorize", { ...q, gateway_token: "wrong" })).status, 401);
    const approved = await form("/authorize", { ...q, gateway_token: "gw-test-token-1234567890" });
    assert.equal(approved.status, 302);
    const loc = new URL(approved.headers.get("location"));
    assert.equal(loc.searchParams.get("state"), "xyz");
    const code = loc.searchParams.get("code");

    // wrong verifier fails and burns the code
    const bad = await form("/token", { grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: q.redirect_uri, code_verifier: "nope" });
    assert.equal(bad.status, 400);
    const again = await form("/token", { grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: q.redirect_uri, code_verifier: verifier });
    assert.equal(again.status, 400, "codes are single-use");

    // fresh code → tokens
    const loc2 = new URL((await form("/authorize", { ...q, gateway_token: "gw-test-token-1234567890" })).headers.get("location"));
    const tok = await (await form("/token", { grant_type: "authorization_code", code: loc2.searchParams.get("code"), client_id: reg.client_id, redirect_uri: q.redirect_uri, code_verifier: verifier })).json();
    assert.match(tok.access_token, /^mcpat_/);
    const ok = await post("/clarity/mcp", INIT, { Authorization: `Bearer ${tok.access_token}` });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).result.serverInfo.name, "clarity");

    // refresh rotates; the old refresh token stops working
    const tok2 = await (await form("/token", { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id })).json();
    assert.ok(tok2.access_token && tok2.access_token !== tok.access_token);
    assert.equal((await form("/token", { grant_type: "refresh_token", refresh_token: tok.refresh_token })).status, 400);

    // the static token modes keep working
    assert.equal((await post("/clarity/mcp", INIT, { Authorization: "Bearer gw-test-token-1234567890" })).status, 200);
    assert.equal((await post("/gw-test-token-1234567890/clarity/mcp", INIT)).status, 200);
  } finally {
    proc.kill();
    rmSync(home, { recursive: true, force: true });
  }
});
