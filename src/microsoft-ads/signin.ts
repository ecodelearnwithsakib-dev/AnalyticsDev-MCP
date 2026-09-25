#!/usr/bin/env node
/**
 * One-time Microsoft account sign-in for Microsoft Advertising: `npm run auth:microsoft-ads`.
 * Uses MSADS_CLIENT_ID (an Entra app with redirect URI http://localhost:53683/callback), PKCE,
 * and writes MSADS_REFRESH_TOKEN into .env. For Google sign-in use `npm run auth:microsoft-ads-google`.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { optionalEnv, projectEnv, requireEnv, saveEnv } from "../shared/env.js";
import { MS_SCOPE, MS_TOKEN_URL } from "./client.js";

const PORT = 53683;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const clientId = requireEnv("MSADS_CLIENT_ID");
const verifier = randomBytes(48).toString("base64url");
const state = randomBytes(16).toString("hex");

const authUrl = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  response_type: "code",
  redirect_uri: REDIRECT_URI,
  scope: `openid profile ${MS_SCOPE}`,
  state,
  prompt: "select_account",
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
}).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", REDIRECT_URI);
  if (url.pathname !== "/callback") return void res.writeHead(404).end();
  try {
    if (url.searchParams.get("state") !== state) throw new Error("State mismatch; start the sign-in again");
    const code = url.searchParams.get("code");
    if (!code) throw new Error(`${url.searchParams.get("error")}: ${url.searchParams.get("error_description")}`);
    const form = new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      scope: MS_SCOPE,
      code_verifier: verifier,
    });
    const secret = optionalEnv("MSADS_CLIENT_SECRET");
    if (secret) form.set("client_secret", secret);
    const tokenRes = await fetch(MS_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    const data = (await tokenRes.json()) as { refresh_token?: string; error?: string; error_description?: string };
    if (!data.refresh_token) throw new Error(`${data.error}: ${data.error_description}`);
    saveEnv("MSADS_REFRESH_TOKEN", data.refresh_token);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<h2>Microsoft Advertising connected. You can close this tab.</h2>");
    console.error(`Saved MSADS_REFRESH_TOKEN to ${projectEnv}`);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(error));
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`Opening Microsoft sign-in...\nIf the browser does not open, visit:\n${authUrl}\n`);
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [authUrl.toString()], () => {});
});
