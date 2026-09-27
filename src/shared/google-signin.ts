#!/usr/bin/env node
/**
 * One-time Google sign-in: `node dist/shared/google-signin.js <ga4|looker-studio|gtm|bigquery|google-ads|microsoft-ads>`.
 * Uses the OAuth client ID/secret from .env — or asks for them in the terminal the first time and
 * saves them as GOOGLE_OAUTH_CLIENT_ID/SECRET (shared by every Google server) — opens the consent
 * screen, and writes the refresh token back into .env so it never has to be copied by hand.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { projectEnv, saveEnv } from "./env.js";
import { oauthClientCredentials, PROFILES } from "./google-auth.js";

const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

const key = process.argv[2] as keyof typeof PROFILES;
const profile = PROFILES[key];
if (!profile) {
  console.error(`Usage: google-signin <${Object.keys(PROFILES).join("|")}>`);
  process.exit(1);
}

/** Reads one line from the terminal; hidden input for secrets. */
function ask(question: string, hidden = false): Promise<string> {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => void (s.startsWith(question) ? process.stderr.write(s) : s.includes("\n") || s.includes("\r") ? process.stderr.write("\n") : undefined);
    rl.question(question, (answer) => {
      rl.close();
      done(answer.trim());
    });
  });
}

const has = (names: string[]) => names.some((n) => process.env[n]);
if (!has(profile.clientIdEnvs) || !has(profile.clientSecretEnvs)) {
  if (!process.stdin.isTTY) {
    console.error(`Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in ${projectEnv}, or run this command in a terminal to be asked for them.`);
    process.exit(1);
  }
  console.error(`No Google OAuth client yet. Create one at https://console.cloud.google.com/apis/credentials
(Create credentials → OAuth client ID → Desktop app) and enable the API for ${profile.name}.
The values are saved only in ${projectEnv}.\n`);
  const id = await ask("Client ID: ");
  const secret = await ask("Client secret (hidden): ", true);
  if (!/\.apps\.googleusercontent\.com$/.test(id) || !secret) {
    console.error("That doesn't look like a Google OAuth client ID (…apps.googleusercontent.com) and secret.");
    process.exit(1);
  }
  saveEnv("GOOGLE_OAUTH_CLIENT_ID", id);
  saveEnv("GOOGLE_OAUTH_CLIENT_SECRET", secret);
  console.error("Saved the OAuth client. Opening the browser…");
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
    saveEnv(profile.refreshTokenEnv, tokens.refresh_token);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<h2>${profile.name} connected. You can close this tab.</h2>`);
    console.error(`Saved ${profile.refreshTokenEnv} to ${projectEnv}`);
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
