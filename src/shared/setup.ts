#!/usr/bin/env node
/**
 * Guided setup, one server at a time — asks for each value in the terminal (secrets hidden),
 * saves it to .env, then runs the browser sign-in when the platform needs one:
 *
 *   npm run setup                 status of every server (which ones have credentials)
 *   npm run setup -- shopify      set up one server
 *   npm run setup -- gtm ga4      several in a row
 *
 * Press Enter to keep a value that is already set, or to skip an optional one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectEnv, saveEnv } from "./env.js";
import { ask } from "./prompt.js";
import { brandTitle, projectRoot, SERVERS, type ServerInfo } from "./servers.js";

type Field = { key: string; example: string; help: string[] };

/** The server's section of .env.example: keys with the comments written above them. */
function fields(s: ServerInfo): { fields: Field[] } {
  const lines = readFileSync(resolve(projectRoot, ".env.example"), "utf8").split("\n");
  const out: Field[] = [];
  let inside = false;
  let notes: string[] = [];
  for (const line of lines) {
    if (line.startsWith("# ----------")) {
      if (inside) break;
      inside = line.includes(`(src/${s.dir})`);
      continue;
    }
    if (!inside) continue;
    if (line.startsWith("#")) notes.push(line.replace(/^#\s?/, ""));
    else if (/^[A-Z0-9_]+=/.test(line)) {
      const [key, ...v] = line.split("=");
      out.push({ key, example: v.join("=").trim(), help: notes });
      notes = [];
    } else if (!line.trim()) notes = [];
  }
  return { fields: out };
}

const GOOGLE: Record<string, string> = { ga4: "ga4", gtm: "gtm", bigquery: "bigquery", "looker-studio": "looker-studio", "google-ads": "google-ads", "search-console": "search-console", "merchant-center": "merchant", "youtube-analytics": "youtube", "google-sheets": "sheets" };
const OAUTH: Record<string, string> = { "linkedin-ads": "linkedin", "pinterest-ads": "pinterest", "snapchat-ads": "snapchat", "amazon-ads": "amazon-ads" };
const OWN: Record<string, string> = { "microsoft-ads": "microsoft-ads/signin.js", "zoho-crm": "zoho-crm/signin.js", salesforce: "salesforce/signin.js", reddit: "reddit/signin.js" };

const secret = (k: string) => /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|_KEY$|CONSUMER_SECRET/.test(k) && !/_ID$/.test(k);
/** Values that a sign-in fills in, or that the shared Google client covers — not asked for. */
function filledBySignIn(s: ServerInfo, key: string) {
  if (GOOGLE[s.name]) return /OAUTH_CLIENT_(ID|SECRET)$|REFRESH_TOKEN$/.test(key);
  if (OAUTH[s.name] || OWN[s.name]) return /REFRESH_TOKEN$|^ZOHO_API_DOMAIN$|^ZOHO_ACCOUNTS_URL$|^SF_INSTANCE_URL$/.test(key);
  return false;
}
const isSet = (k: string) => !!process.env[k];

function status() {
  console.error(`Analytics Dev MCP — credentials in ${projectEnv}\n`);
  for (const s of SERVERS) {
    const f = fields(s).fields.filter((x) => !filledBySignIn(s, x.key));
    const set = f.filter((x) => isSet(x.key)).length;
    const mark = !f.length ? "·" : set === 0 ? "✗" : set === f.length ? "✓" : "◐";
    console.error(`  ${mark} ${s.name.padEnd(18)} ${f.length ? `${set}/${f.length} set` : "no settings needed"}`);
  }
  console.error(`\nSet one up:  npm run setup -- <server>`);
}

function run(file: string, args: string[]) {
  const r = spawnSync(process.execPath, [resolve(projectRoot, "dist", file), ...args], { stdio: "inherit", env: process.env });
  return r.status === 0;
}

async function setup(s: ServerInfo) {
  const { fields: list } = fields(s);
  console.error(`\n━━ ${brandTitle(s.name)} ━━`);
  console.error(`  Enter = keep the current value / skip. Secrets are hidden while you type.\n`);
  let changed = 0;
  for (const f of list) {
    if (filledBySignIn(s, f.key)) continue;
    for (const h of f.help) console.error(`  # ${h}`);
    const hidden = secret(f.key);
    const current = process.env[f.key];
    const hint = current ? (hidden ? " [set — Enter keeps it]" : ` [${current}]`) : f.example ? ` [e.g. ${f.example}]` : "";
    const v = await ask(`  ${f.key}${hint}: `, hidden);
    if (v) {
      saveEnv(f.key, v);
      changed++;
    } else if (!current && f.example && !/example|your-|XXXX/i.test(f.example)) {
      saveEnv(f.key, f.example);
      changed++;
    }
  }
  console.error(`\n  Saved ${changed} value${changed === 1 ? "" : "s"} to ${projectEnv}.`);

  let signIn: [string, string[]] | undefined;
  if (GOOGLE[s.name]) signIn = ["shared/google-signin.js", [GOOGLE[s.name]]];
  else if (OAUTH[s.name]) signIn = ["shared/oauth-signin.js", [OAUTH[s.name]]];
  else if (s.name === "microsoft-ads") {
    const google = (await ask(`  Do you log in to Microsoft Advertising with a Google account? (y/N): `)).toLowerCase() === "y";
    signIn = google ? ["shared/google-signin.js", ["microsoft-ads"]] : [OWN[s.name], []];
  } else if (OWN[s.name]) signIn = [OWN[s.name], []];
  if (signIn) {
    const token = list.find((f) => /REFRESH_TOKEN$/.test(f.key) && isSet(f.key))?.key ?? list.find((f) => /REFRESH_TOKEN$/.test(f.key))?.key;
    const again = token && isSet(token) ? (await ask(`  Already signed in. Sign in again? (y/N): `)).toLowerCase() === "y" : (await ask(`  Open the browser sign-in now? (Y/n): `)).toLowerCase() !== "n";
    if (again && !run(signIn[0], signIn[1])) console.error(`  Sign-in did not finish — run  npm run setup -- ${s.name}  again.`);
  }
  console.error(`  Done. Restart Claude (Cmd+Q, reopen) so ${s.name} picks up the new values.`);
}

const names = process.argv.slice(2).flatMap((a) => a.split(",")).filter(Boolean);
if (!names.length) status();
else {
  if (!process.stdin.isTTY) {
    console.error("Run this in a terminal — it asks questions.");
    process.exit(1);
  }
  if (!existsSync(projectEnv)) console.error(`Creating ${projectEnv}`);
  for (const n of names) {
    const s = SERVERS.find((x) => x.name === n || x.dir === n);
    if (!s) {
      console.error(`Unknown server "${n}". Run  npm run setup  to see the list.`);
      process.exit(1);
    }
    await setup(s);
  }
}
