#!/usr/bin/env node
/**
 * One-time browser sign-in for OAuth platforms: `npm run auth:<provider>`
 * (linkedin, pinterest, snapchat, amazon-ads). Uses the app's client ID/secret from .env,
 * listens on http://localhost:53687/callback (add that exact redirect URI to your app),
 * and writes the refresh token into the active env file (.env or .env.<profile>).
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { optionalEnv, profileEnv, requireEnv, saveEnv } from "./env.js";

const PORT = 53687;
const REDIRECT = `http://localhost:${PORT}/callback`;

type Provider = { title: string; authorize: string; token: string; scopes: string; clientId: string; clientSecret: string; save: string; pkce?: boolean; basic?: boolean; extraAuth?: Record<string, string>; scopeSep?: string };

const AMAZON_REGIONS: Record<string, string> = { NA: "https://api.amazon.com/auth/o2/token", EU: "https://api.amazon.co.uk/auth/o2/token", FE: "https://api.amazon.co.jp/auth/o2/token" };

const PROVIDERS: Record<string, Provider> = {
  linkedin: {
    title: "LinkedIn Marketing",
    authorize: "https://www.linkedin.com/oauth/v2/authorization",
    token: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: "r_ads r_ads_reporting rw_ads r_organization_social rw_conversions r_basicprofile",
    scopeSep: " ",
    clientId: "LINKEDIN_CLIENT_ID",
    clientSecret: "LINKEDIN_CLIENT_SECRET",
    save: "LINKEDIN_REFRESH_TOKEN",
  },
  pinterest: {
    title: "Pinterest",
    authorize: "https://www.pinterest.com/oauth/",
    token: "https://api.pinterest.com/v5/oauth/token",
    scopes: "ads:read,ads:write,boards:read,pins:read,user_accounts:read,catalogs:read,catalogs:write",
    scopeSep: ",",
    clientId: "PINTEREST_APP_ID",
    clientSecret: "PINTEREST_APP_SECRET",
    save: "PINTEREST_REFRESH_TOKEN",
    basic: true,
  },
  snapchat: {
    title: "Snapchat Marketing",
    authorize: "https://accounts.snapchat.com/login/oauth2/authorize",
    token: "https://accounts.snapchat.com/login/oauth2/access_token",
    scopes: "snapchat-marketing-api",
    clientId: "SNAPCHAT_CLIENT_ID",
    clientSecret: "SNAPCHAT_CLIENT_SECRET",
    save: "SNAPCHAT_REFRESH_TOKEN",
  },
  "amazon-ads": {
    title: "Amazon Ads",
    authorize: "https://www.amazon.com/ap/oa",
    token: AMAZON_REGIONS[optionalEnv("AMAZON_ADS_REGION", "NA").toUpperCase()] ?? AMAZON_REGIONS.NA,
    scopes: "advertising::campaign_management",
    clientId: "AMAZON_ADS_CLIENT_ID",
    clientSecret: "AMAZON_ADS_CLIENT_SECRET",
    save: "AMAZON_ADS_REFRESH_TOKEN",
  },
};

const key = process.argv[2];
const p = PROVIDERS[key];
if (!p) {
  console.error(`Usage: oauth-signin <${Object.keys(PROVIDERS).join("|")}>`);
  process.exit(1);
}
const clientId = requireEnv(p.clientId);
const secret = requireEnv(p.clientSecret);
const state = randomBytes(16).toString("hex");
const verifier = randomBytes(48).toString("base64url");
const url = new URL(p.authorize);
url.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  scope: p.scopes,
  state,
  ...(p.pkce ? { code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" } : {}),
  ...p.extraAuth,
}).toString();

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", REDIRECT);
  if (u.pathname !== "/callback") return void res.writeHead(404).end();
  try {
    if (u.searchParams.get("state") !== state) throw new Error("State mismatch; start again");
    const code = u.searchParams.get("code");
    if (!code) throw new Error(`${u.searchParams.get("error") ?? "no code"}: ${u.searchParams.get("error_description") ?? ""}`);
    const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, ...(p.basic ? {} : { client_id: clientId, client_secret: secret }), ...(p.pkce ? { code_verifier: verifier } : {}) });
    const r = await fetch(p.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...(p.basic ? { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}` } : {}) }, body: form });
    const data = (await r.json()) as { refresh_token?: string; access_token?: string; error?: string; error_description?: string };
    if (!data.refresh_token) throw new Error(`No refresh token returned (${data.error ?? r.status}: ${data.error_description ?? "check the app's scopes and that refresh tokens are enabled"})`);
    saveEnv(p.save, data.refresh_token);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<h2>${p.title} connected. You can close this tab.</h2>`);
    console.error(`Saved ${p.save} to ${profileEnv}`);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(e));
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`Opening ${p.title} sign-in (redirect URI must be ${REDIRECT})…\nIf the browser does not open, visit:\n${url}\n`);
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url.toString()], () => {});
});
