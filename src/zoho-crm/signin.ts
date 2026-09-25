#!/usr/bin/env node
/**
 * One-time Zoho sign-in: `npm run auth:zoho-crm`.
 * Server-based client (redirect URI http://localhost:53684/callback): opens the browser, then saves
 * ZOHO_REFRESH_TOKEN, ZOHO_API_DOMAIN and ZOHO_ACCOUNTS_URL (your data center) into .env.
 * Self Client alternative: `npm run auth:zoho-crm -- <grant code>` with a code generated in the API console
 * using the scopes printed by `npm run auth:zoho-crm -- --scopes`.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { projectEnv, requireEnv, saveEnv } from "../shared/env.js";
import { accountsUrl, SCOPES } from "./client.js";

const PORT = 53684;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

if (process.argv[2] === "--scopes") {
  console.log(SCOPES);
  process.exit(0);
}

const clientId = requireEnv("ZOHO_CLIENT_ID");
const clientSecret = requireEnv("ZOHO_CLIENT_SECRET");

async function exchange(code: string, accounts: string, redirect?: string) {
  const form = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code });
  if (redirect) form.set("redirect_uri", redirect);
  const res = await fetch(`${accounts}/oauth/v2/token`, { method: "POST", body: form });
  const data = (await res.json()) as { refresh_token?: string; api_domain?: string; error?: string };
  if (!data.refresh_token) throw new Error(`Zoho did not return a refresh token (${data.error ?? res.status}). Codes expire after a few minutes and work once — generate a new one.`);
  saveEnv("ZOHO_REFRESH_TOKEN", data.refresh_token);
  if (data.api_domain) saveEnv("ZOHO_API_DOMAIN", data.api_domain);
  saveEnv("ZOHO_ACCOUNTS_URL", accounts);
  console.error(`Saved ZOHO_REFRESH_TOKEN, ZOHO_API_DOMAIN (${data.api_domain}) and ZOHO_ACCOUNTS_URL to ${projectEnv}`);
}

const selfClientCode = process.argv[2];
if (selfClientCode) {
  await exchange(selfClientCode, accountsUrl()).catch((e: Error) => {
    console.error(e.message);
    process.exitCode = 1;
  });
} else {
  const state = randomBytes(16).toString("hex");
  const authUrl = new URL(`${accountsUrl()}/oauth/v2/auth`);
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", REDIRECT_URI);
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    try {
      if (url.searchParams.get("state") !== state) throw new Error("State mismatch; start the sign-in again");
      const code = url.searchParams.get("code");
      if (!code) throw new Error(`Zoho sign-in failed: ${url.searchParams.get("error") ?? "no code"}`);
      // The user's data center may differ from the one the sign-in started on.
      await exchange(code, url.searchParams.get("accounts-server") ?? accountsUrl(), REDIRECT_URI);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<h2>Zoho CRM connected. You can close this tab.</h2>");
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain" }).end(String(error));
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    } finally {
      server.close();
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.error(`Opening Zoho sign-in...\nIf the browser does not open, visit:\n${authUrl}\n`);
    execFile(process.platform === "darwin" ? "open" : "xdg-open", [authUrl.toString()], () => {});
  });
}
