#!/usr/bin/env node
/**
 * One-time Google sign-in: `node dist/shared/google-signin.js <ga4|looker-studio>`.
 * Uses the OAuth client ID/secret from .env, opens the consent screen, and writes the
 * refresh token back into .env so it never has to be copied by hand.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { oauthClientCredentials, PROFILES } from "./google-auth.js";

const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");

const key = process.argv[2] as keyof typeof PROFILES;
const profile = PROFILES[key];
if (!profile) {
  console.error(`Usage: google-signin <${Object.keys(PROFILES).join("|")}>`);
  process.exit(1);
}

function saveToEnv(name: string, value: string): void {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (index >= 0) lines[index] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  writeFileSync(ENV_FILE, lines.join("\n"), { mode: 0o600 });
}

const oauth = oauthClientCredentials(profile, REDIRECT_URI);
const authUrl = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: profile.scopes });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", REDIRECT_URI);
  if (url.pathname !== "/callback") return void res.writeHead(404).end();
  const code = url.searchParams.get("code");
  try {
    if (!code) throw new Error(url.searchParams.get("error") ?? "No authorization code returned");
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error("Google did not return a refresh token; remove the app's access at myaccount.google.com/permissions and retry.");
    }
    saveToEnv(profile.refreshTokenEnv, tokens.refresh_token);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<h2>${profile.name} connected. You can close this tab.</h2>`);
    console.error(`Saved ${profile.refreshTokenEnv} to ${ENV_FILE}`);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(error));
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`Opening Google sign-in for ${profile.name}...\nIf the browser does not open, visit:\n${authUrl}\n`);
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [authUrl], () => {});
});
