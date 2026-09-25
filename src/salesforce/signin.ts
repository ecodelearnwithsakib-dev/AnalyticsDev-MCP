#!/usr/bin/env node
/**
 * One-time Salesforce sign-in: `npm run auth:salesforce`.
 * Uses an External Client App (callback http://localhost:53685/callback, PKCE, scopes api refresh_token)
 * and saves SF_REFRESH_TOKEN and SF_INSTANCE_URL into .env.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { optionalEnv, projectEnv, requireEnv, saveEnv } from "../shared/env.js";
import { loginUrl } from "./client.js";

const PORT = 53685;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const clientId = requireEnv("SF_CLIENT_ID");
const verifier = randomBytes(48).toString("base64url");
const state = randomBytes(16).toString("hex");

const authUrl = new URL(`${loginUrl()}/services/oauth2/authorize`);
authUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  scope: "api refresh_token offline_access",
  state,
  prompt: "login consent",
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
    const form = new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier });
    const secret = optionalEnv("SF_CLIENT_SECRET");
    if (secret) form.set("client_secret", secret);
    const tokenRes = await fetch(`${loginUrl()}/services/oauth2/token`, { method: "POST", body: form });
    const data = (await tokenRes.json()) as { refresh_token?: string; instance_url?: string; error?: string; error_description?: string };
    if (!data.refresh_token) throw new Error(`${data.error ?? "no refresh token"}: ${data.error_description ?? "add the refresh_token scope to the app"}`);
    saveEnv("SF_REFRESH_TOKEN", data.refresh_token);
    if (data.instance_url) saveEnv("SF_INSTANCE_URL", data.instance_url);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<h2>Salesforce connected. You can close this tab.</h2>");
    console.error(`Saved SF_REFRESH_TOKEN and SF_INSTANCE_URL (${data.instance_url}) to ${projectEnv}`);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(error));
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`Opening Salesforce sign-in...\nIf the browser does not open, visit:\n${authUrl}\n`);
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [authUrl.toString()], () => {});
});
