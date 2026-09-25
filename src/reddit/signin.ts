#!/usr/bin/env node
/**
 * One-time Reddit sign-in: `npm run auth:reddit`.
 * Needs a Reddit "web app" (redirect URI http://localhost:53686/callback) in REDDIT_CLIENT_ID/SECRET.
 * Grants community + Ads scopes in one go and saves REDDIT_REFRESH_TOKEN into .env.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { projectEnv, requireEnv, saveEnv } from "../shared/env.js";
import { basicAuth, SCOPES, TOKEN_URL, userAgent } from "./client.js";

const PORT = 53686;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const state = randomBytes(16).toString("hex");
const authUrl = new URL("https://www.reddit.com/api/v1/authorize");
authUrl.search = new URLSearchParams({ client_id: requireEnv("REDDIT_CLIENT_ID"), response_type: "code", state, redirect_uri: REDIRECT_URI, duration: "permanent", scope: SCOPES }).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", REDIRECT_URI);
  if (url.pathname !== "/callback") return void res.writeHead(404).end();
  try {
    if (url.searchParams.get("state") !== state) throw new Error("State mismatch; start the sign-in again");
    const code = url.searchParams.get("code");
    if (!code) throw new Error(`Reddit sign-in failed: ${url.searchParams.get("error")}`);
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent() },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
    });
    const data = (await tokenRes.json()) as { refresh_token?: string; scope?: string; error?: string };
    if (!data.refresh_token) throw new Error(`No refresh token (${data.error ?? tokenRes.status})`);
    saveEnv("REDDIT_REFRESH_TOKEN", data.refresh_token);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<h2>Reddit connected. You can close this tab.</h2>");
    console.error(`Saved REDDIT_REFRESH_TOKEN to ${projectEnv} (scopes: ${data.scope})`);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(error));
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`Opening Reddit sign-in...\nIf the browser does not open, visit:\n${authUrl}\n`);
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [authUrl.toString()], () => {});
});
