#!/usr/bin/env node
/**
 * One command per platform — does everything in four steps:
 *
 *   analyticsdev-mcp setup              status of every server (✓ ready · ◐ partly · ✗ not set up)
 *   analyticsdev-mcp setup ga4          1 prepare (APIs / where to get keys) → 2 enter values (secrets hidden)
 *                                        → 3 browser sign-in → 4 live connection test → add to Claude
 *   analyticsdev-mcp setup gtm ga4      several in a row
 *
 * (Inside the project folder the same works as `npm run setup -- ga4`.)
 * Press Enter to keep a value that is already set, or to skip an optional one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { projectEnv, saveEnv } from "./env.js";
import { ask } from "./prompt.js";
import { brandTitle, displayName, entry, projectRoot, SERVERS, type ServerInfo } from "./servers.js";

type Field = { key: string; example: string; help: string[] };

/** The server's section of .env.example: keys with the comments written just above them. */
function fields(s: ServerInfo): Field[] {
  const lines = readFileSync(resolve(projectRoot, ".env.example"), "utf8").split("\n");
  const out: Field[] = [];
  let inside = false;
  let notes: string[] = [];
  for (const line of lines) {
    if (line.startsWith("# ----------")) {
      if (inside) break;
      inside = line.includes(`(src/${s.dir})`);
      notes = [];
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
  return out;
}

// ---- per-platform knowledge -------------------------------------------------------------------

/** Google servers: sign-in profile, refresh-token variable and the APIs to enable. */
const GOOGLE: Record<string, { profile: string; token: string; apis: [string, string][] }> = {
  ga4: { profile: "ga4", token: "GA4_OAUTH_REFRESH_TOKEN", apis: [["analyticsadmin", "Google Analytics Admin API"], ["analyticsdata", "Google Analytics Data API"]] },
  gtm: { profile: "gtm", token: "GTM_OAUTH_REFRESH_TOKEN", apis: [["tagmanager", "Tag Manager API"]] },
  "search-console": { profile: "search-console", token: "SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN", apis: [["searchconsole", "Google Search Console API"]] },
  "merchant-center": { profile: "merchant", token: "MERCHANT_OAUTH_REFRESH_TOKEN", apis: [["merchantapi", "Merchant API"]] },
  "youtube-analytics": { profile: "youtube", token: "YOUTUBE_OAUTH_REFRESH_TOKEN", apis: [["youtubeanalytics", "YouTube Analytics API"], ["youtube", "YouTube Data API v3"]] },
  "google-sheets": { profile: "sheets", token: "SHEETS_OAUTH_REFRESH_TOKEN", apis: [["sheets", "Google Sheets API"], ["drive", "Google Drive API"]] },
  bigquery: { profile: "bigquery", token: "BIGQUERY_OAUTH_REFRESH_TOKEN", apis: [["bigquery", "BigQuery API"], ["bigquerydatatransfer", "BigQuery Data Transfer API (scheduled queries)"]] },
  "looker-studio": { profile: "looker-studio", token: "LOOKER_STUDIO_OAUTH_REFRESH_TOKEN", apis: [["datastudio", "Looker Studio API (Google Workspace only)"]] },
  "google-ads": { profile: "google-ads", token: "GOOGLE_ADS_OAUTH_REFRESH_TOKEN", apis: [["googleads", "Google Ads API"]] },
};
const OAUTH: Record<string, string> = { "linkedin-ads": "linkedin", "pinterest-ads": "pinterest", "snapchat-ads": "snapchat", "amazon-ads": "amazon-ads" };
const OWN: Record<string, string> = { "microsoft-ads": "microsoft-ads/signin.js", "zoho-crm": "zoho-crm/signin.js", salesforce: "salesforce/signin.js", reddit: "reddit/signin.js" };

/** Values a server cannot work without (everything else is an optional default). */
const REQUIRED: Record<string, string[]> = {
  meta: ["META_ACCESS_TOKEN"], "google-ads": ["GOOGLE_ADS_DEVELOPER_TOKEN"], "microsoft-ads": ["MSADS_DEVELOPER_TOKEN", "MSADS_ACCOUNT_ID"], "openai-ads": ["OPENAI_ADS_API_KEY"],
  reddit: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USER_AGENT"], matomo: ["MATOMO_URL", "MATOMO_TOKEN"], bigquery: ["BIGQUERY_PROJECT_ID"], stape: ["SGTM_URL"],
  n8n: ["N8N_URL", "N8N_API_KEY"], clickup: ["CLICKUP_API_TOKEN"], slack: ["SLACK_USER_TOKEN"], "zoho-crm": ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_DC"],
  odoo: ["ODOO_URL", "ODOO_API_KEY"], ghl: ["GHL_API_TOKEN", "GHL_LOCATION_ID"], pipedrive: ["PIPEDRIVE_DOMAIN", "PIPEDRIVE_API_TOKEN"], salesforce: ["SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_LOGIN_URL"],
  "merchant-center": ["MERCHANT_ACCOUNT_ID"], "linkedin-ads": ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"], "pinterest-ads": ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"],
  "snapchat-ads": ["SNAPCHAT_CLIENT_ID", "SNAPCHAT_CLIENT_SECRET"], "x-ads": ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"],
  "amazon-ads": ["AMAZON_ADS_CLIENT_ID", "AMAZON_ADS_CLIENT_SECRET", "AMAZON_ADS_REGION"], "tiktok-business": ["TIKTOK_ACCESS_TOKEN"], shopify: ["SHOPIFY_STORE", "SHOPIFY_ACCESS_TOKEN"],
  woocommerce: ["WOO_URL", "WOO_CONSUMER_KEY", "WOO_CONSUMER_SECRET"], hubspot: ["HUBSPOT_ACCESS_TOKEN"], posthog: ["POSTHOG_API_KEY", "POSTHOG_PROJECT_ID"],
  mixpanel: ["MIXPANEL_SERVICE_ACCOUNT", "MIXPANEL_SERVICE_SECRET", "MIXPANEL_PROJECT_ID"], amplitude: ["AMPLITUDE_API_KEY", "AMPLITUDE_SECRET_KEY"], clarity: ["CLARITY_API_TOKEN"],
  klaviyo: ["KLAVIYO_API_KEY"], mailchimp: ["MAILCHIMP_API_KEY"], whatsapp: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID"],
  airtable: ["AIRTABLE_TOKEN"], notion: ["NOTION_TOKEN"],
};

/** A read-only call that proves the connection works. */
const TEST: Record<string, [string, Record<string, unknown>]> = {
  ga4: ["ga4_list_account_summaries", {}], gtm: ["gtm_list", { resource: "accounts" }], "search-console": ["gsc_sites", {}], "merchant-center": ["merchant_account_issues", {}],
  "youtube-analytics": ["yt_channel", {}], "google-sheets": ["sheets_find", {}], bigquery: ["bq_list_projects", {}], "looker-studio": ["looker_studio_api_status", {}], "google-ads": ["gads_list_accounts", {}],
  meta: ["meta_whoami", {}], "microsoft-ads": ["msads_accounts", {}], "openai-ads": ["oai_ads_account", { action: "get" }], "linkedin-ads": ["linkedin_accounts", {}], "pinterest-ads": ["pinterest_accounts", {}],
  "snapchat-ads": ["snapchat_accounts", {}], "x-ads": ["x_accounts", {}], "amazon-ads": ["amazon_profiles", {}], "tiktok-business": ["tiktok_campaigns", { action: "list" }], reddit: ["reddit_health", {}],
  stape: ["sgtm_healthcheck", {}], matomo: ["matomo_health", {}], posthog: ["posthog_projects", {}], mixpanel: ["mixpanel_events", {}], amplitude: ["amp_events", {}],
  shopify: ["shopify_shop", {}], woocommerce: ["woo_store", {}], hubspot: ["hubspot_account", {}], salesforce: ["sf_org", { what: "health" }], pipedrive: ["pipedrive_health", {}],
  "zoho-crm": ["zoho_crm_health", {}], odoo: ["odoo_health", {}], ghl: ["ghl_health", {}], klaviyo: ["klaviyo_account", {}], mailchimp: ["mailchimp_account", {}], whatsapp: ["wa_numbers", {}],
  slack: ["slack_workspace", { area: "team" }], clickup: ["clickup_workspace", { action: "me" }], n8n: ["n8n_instance", { action: "health" }], airtable: ["airtable_bases", {}], notion: ["notion_search", {}],
  "ads-hub": ["ads_platforms", {}], "conversion-sync": ["sync_setup", {}],
};

// ---- helpers ------------------------------------------------------------------------------------

const secret = (k: string) => /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|_KEY$/.test(k) && !/_ID$/.test(k);
const isSet = (k: string) => !!process.env[k];
const bold = (s: string) => (process.stderr.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s: string) => (process.stderr.isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const say = (s = "") => console.error(s);
const yes = async (q: string, def: boolean) => {
  const a = (await ask(`  ${q} ${def ? "(Y/n)" : "(y/N)"}: `)).toLowerCase();
  return a ? a.startsWith("y") : def;
};

/** Values the sign-in or the shared Google client fills in — never asked for. */
function filledBySignIn(s: ServerInfo, key: string) {
  if (GOOGLE[s.name]) return /OAUTH_CLIENT_(ID|SECRET)$|REFRESH_TOKEN$/.test(key);
  if (OAUTH[s.name] || OWN[s.name]) return /REFRESH_TOKEN$|^ZOHO_API_DOMAIN$|^ZOHO_ACCOUNTS_URL$|^SF_INSTANCE_URL$|^MSADS_GOOGLE_REFRESH_TOKEN$/.test(key);
  return false;
}

function state(s: ServerInfo): "ready" | "partial" | "none" | "n/a" {
  const req = REQUIRED[s.name] ?? [];
  const token = GOOGLE[s.name]?.token;
  const needs = [...req, ...(token ? [token] : [])];
  if (!needs.length) return "n/a";
  const done = needs.filter(isSet).length + (token && !isSet(token) && isSet("GOOGLE_APPLICATION_CREDENTIALS") ? 1 : 0);
  return done >= needs.length ? "ready" : done ? "partial" : "none";
}

function status() {
  say(bold(`Analytics Dev MCP — setup status`));
  say(dim(`Credentials file: ${projectEnv}\n`));
  const mark = { ready: green("✓ ready    "), partial: "◐ partly   ", none: red("✗ not set  "), "n/a": dim("· no keys  ") };
  for (const s of SERVERS) say(`  ${mark[state(s)]} ${s.name.padEnd(18)} ${dim(s.title)}`);
  say(`\nSet one up:   ${bold("analyticsdev-mcp setup <server>")}      e.g. analyticsdev-mcp setup ga4`);
  say(`Full guide:   docs/SETUP-GUIDE.md`);
}

/** Google project number = the digits before the dash in the OAuth client ID. */
const projectNumber = () => (process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GA4_OAUTH_CLIENT_ID || "").split("-")[0] || "";

function open(url: string) {
  spawnSync(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [url], { stdio: "ignore" });
}

function runNode(file: string, args: string[]) {
  return spawnSync(process.execPath, [resolve(projectRoot, "dist", file), ...args], { stdio: "inherit", env: process.env }).status === 0;
}

/** Starts the server fresh (so it reads the new .env) and makes one read-only call. */
async function testConnection(s: ServerInfo): Promise<{ ok: boolean; text: string }> {
  const t = TEST[s.name];
  if (!t) return { ok: true, text: "no automatic test for this server" };
  const client = new Client({ name: "analyticsdev-setup", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry(s)], cwd: projectRoot, env: process.env as Record<string, string>, stderr: "ignore" }));
    const r = (await client.callTool({ name: t[0], arguments: t[1] })) as { isError?: boolean; content?: { text?: string }[] };
    const text = r.content?.[0]?.text ?? "";
    return { ok: !r.isError, text };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  } finally {
    await client.close().catch(() => {});
  }
}

/** "found 15 — Ecode Learn, Analytics Dev, …" from a JSON tool result. */
function summary(text: string) {
  try {
    const d = JSON.parse(text);
    const arr = Array.isArray(d) ? d : (Object.values(d).find(Array.isArray) as unknown[] | undefined);
    if (arr) {
      const names = arr.map((x) => (x && typeof x === "object" ? ((x as Record<string, unknown>).displayName ?? (x as Record<string, unknown>).name ?? (x as Record<string, unknown>).siteUrl ?? (x as Record<string, unknown>).id) : x)).filter(Boolean).slice(0, 6);
      return `found ${arr.length}${names.length ? ` — ${names.join(", ")}${arr.length > names.length ? ", …" : ""}` : ""}`;
    }
    const n = d.name ?? d.displayName ?? d.shop?.name ?? d.email ?? d.status ?? d.ok;
    return n !== undefined ? `OK — ${String(n)}` : "OK";
  } catch {
    return text.slice(0, 160);
  }
}

function hint(text: string) {
  const api = text.match(/https:\/\/console\.developers\.google\.com\/apis\/api\/[^\s)]+/);
  if (api) return `Enable the API here, wait 1–2 minutes, then run the setup again:\n    ${api[0]}`;
  if (/Missing environment variable (\w+)/.test(text)) return `A value is missing — run the setup again and fill in ${text.match(/Missing environment variable (\w+)/)![1]}.`;
  if (/401|invalid_grant|unauthori[sz]ed|expired/i.test(text)) return "The key or sign-in was rejected — check it, or sign in again (answer y when asked).";
  if (/403|permission|scope|forbidden/i.test(text)) return "The account or key lacks access — add the missing permission/scope in the platform, then try again.";
  return "Check the values above, then run the setup again. docs/SETUP-GUIDE.md → Troubleshooting has more fixes.";
}

// ---- the four steps ---------------------------------------------------------------------------

async function setup(s: ServerInfo) {
  const list = fields(s);
  const required = new Set(REQUIRED[s.name] ?? []);
  const google = GOOGLE[s.name];
  say(`\n${bold(`━━━ ${brandTitle(s.name)} ━━━`)}`);

  // 1. Prepare
  say(`\n${bold("Step 1/4 · Prepare")}`);
  if (google) {
    if (!isSet("GOOGLE_OAUTH_CLIENT_ID") && !isSet("GA4_OAUTH_CLIENT_ID")) {
      say(`  All Google servers share one OAuth client (created once):`);
      say(`  console.cloud.google.com → APIs & Services → Credentials → Create credentials → OAuth client ID → ${bold("Desktop app")}`);
      const id = await ask(`  Client ID: `);
      const sec = await ask(`  Client secret (hidden): `, true);
      if (!/\.apps\.googleusercontent\.com$/.test(id) || !sec) {
        say(red(`  That doesn't look like a Google OAuth client ID (…apps.googleusercontent.com) and secret. Nothing saved.`));
        return;
      }
      saveEnv("GOOGLE_OAUTH_CLIENT_ID", id);
      saveEnv("GOOGLE_OAUTH_CLIENT_SECRET", sec);
      say(green(`  ✓ OAuth client saved (used by every Google server from now on)`));
    } else say(green(`  ✓ Google OAuth client already saved`));
    const p = projectNumber();
    say(`  Enable ${google.apis.length > 1 ? "these APIs" : "this API"} in your Google Cloud project${p ? ` (${p})` : ""}:`);
    const urls = google.apis.map(([id, name]) => {
      const url = `https://console.cloud.google.com/apis/library/${id}.googleapis.com${p ? `?project=${p}` : ""}`;
      say(`    • ${name}\n      ${dim(url)}`);
      return url;
    });
    if (await yes("Open them in the browser now?", true)) urls.forEach(open);
    await ask(`  Click ${bold("Enable")} on each page, then press Enter to continue… `);
  } else {
    say(`  Have your ${s.title} credentials ready — where to find each one is shown next to it below.`);
    say(dim(`  Step-by-step: docs/SETUP-GUIDE.md → ${s.title}`));
  }

  // 2. Values
  const toAsk = list.filter((f) => !filledBySignIn(s, f.key));
  say(`\n${bold("Step 2/4 · Your values")}  ${dim("(Enter = keep current / skip optional · secrets are hidden)")}`);
  if (!toAsk.length) say(dim("  Nothing to enter for this server."));
  let changed = 0;
  for (const f of toAsk) {
    const req = required.has(f.key);
    const helps = f.help.filter((h) => !/^Option [AB]/.test(h));
    for (const h of helps) say(dim(`  # ${h}`));
    const hidden = secret(f.key);
    const current = process.env[f.key];
    const tag = req ? red("required") : dim("optional");
    const hintText = current ? (hidden ? "set — Enter keeps it" : current) : f.example ? `e.g. ${f.example}` : "";
    let v = await ask(`  ${f.key} (${tag})${hintText ? ` [${hintText}]` : ""}: `, hidden);
    if (!v && req && !current) v = await ask(`  ${red("This one is required")} — ${f.key}: `, hidden);
    if (v) {
      saveEnv(f.key, v);
      changed++;
    } else if (!current && f.example && !/example|your-|XXXX/i.test(f.example)) {
      saveEnv(f.key, f.example);
      changed++;
    }
  }
  if (toAsk.length) say(green(`  ✓ ${changed} value${changed === 1 ? "" : "s"} saved to .env`));

  // 3. Sign in
  say(`\n${bold("Step 3/4 · Sign in")}`);
  let signIn: [string, string[]] | undefined;
  let token: string | undefined = google?.token ?? list.find((f) => /REFRESH_TOKEN$/.test(f.key) && !/GOOGLE/.test(f.key))?.key;
  if (google) signIn = ["shared/google-signin.js", [google.profile]];
  else if (OAUTH[s.name]) signIn = ["shared/oauth-signin.js", [OAUTH[s.name]]];
  else if (s.name === "microsoft-ads") {
    const viaGoogle = await yes("Do you log in to Microsoft Advertising with a Google account?", false);
    signIn = viaGoogle ? ["shared/google-signin.js", ["microsoft-ads"]] : [OWN[s.name], []];
    token = viaGoogle ? "MSADS_GOOGLE_REFRESH_TOKEN" : "MSADS_REFRESH_TOKEN";
  } else if (OWN[s.name]) signIn = [OWN[s.name], []];
  if (!signIn) say(dim("  Not needed — this platform uses the key you entered."));
  else {
    const already = token && isSet(token);
    const go = already ? await yes("Already signed in. Sign in again?", false) : await yes("Open the browser sign-in now?", true);
    if (go) {
      say(dim("  Choose your account in the browser and click Allow. (\"App not verified\"? → Advanced → Go to …)"));
      if (runNode(signIn[0], signIn[1])) say(green("  ✓ Signed in"));
      else say(red("  Sign-in did not finish — run this setup again."));
    } else if (already) say(green("  ✓ Using the existing sign-in"));
  }

  // 4. Test
  say(`\n${bold("Step 4/4 · Test the connection")}`);
  const t = await testConnection(s);
  if (t.ok) say(green(`  ✓ ${displayName(s)} works — ${summary(t.text)}`));
  else {
    say(red(`  ✗ Not working yet: ${t.text.split("\n")[0].slice(0, 300)}`));
    say(`  → ${hint(t.text)}`);
  }

  // Add to Claude
  say(`\n${bold("Add to Claude")}`);
  const claude = spawnSync("claude", ["mcp", "get", s.name], { stdio: "ignore" });
  if (claude.error) say(dim("  Claude Code CLI not found — skipping Claude Code."));
  else if (claude.status === 0) say(green(`  ✓ Claude Code: "${s.name}" is already added`));
  else if (await yes(`Add "${s.name}" to Claude Code?`, true)) {
    const r = spawnSync("claude", ["mcp", "add", "--scope", "user", s.name, "--", process.execPath, entry(s)], { stdio: "ignore" });
    say(r.status === 0 ? green(`  ✓ Claude Code: added "${s.name}"`) : red("  Could not add it — run: npm run config -- claude-code " + s.name));
  }
  const desktopScript = resolve(projectRoot, "scripts", "add-to-claude-desktop.sh");
  const outsideClaude = !process.env.CLAUDECODE && /Apple_Terminal|iTerm|Warp|ghostty|WezTerm|Hyper|Alacritty|kitty/i.test(`${process.env.TERM_PROGRAM ?? ""}${process.env.TERM ?? ""}`);
  if (process.platform === "darwin" && existsSync(desktopScript)) {
    if (!outsideClaude) say(`  Claude Desktop: run this from the macOS Terminal app (it restarts Claude):\n    ${bold(`analyticsdev-mcp desktop ${s.name}`)}`);
    else if (await yes(`Add "${displayName(s)}" to Claude Desktop? (Claude quits and reopens)`, false)) spawnSync("sh", [desktopScript, s.name], { stdio: "inherit" });
  }
  say(`\n${green("Done.")} Restart Claude (Cmd+Q, reopen) if it was open, then ask: ${bold(`"${displayName(s)}: ${examplePrompt(s)}"`)}`);
}

function examplePrompt(s: ServerInfo) {
  const p: Record<string, string> = { ga4: "list my accounts and properties", gtm: "list my accounts and containers", "search-console": "top queries last 28 days", meta: "spend by campaign yesterday", shopify: "sales last 7 days", hubspot: "pipeline by stage", "google-ads": "campaign performance last 7 days" };
  return p[s.name] ?? "what can you do?";
}

// ---- main -------------------------------------------------------------------------------------

const names = process.argv.slice(2).flatMap((a) => a.split(",")).filter(Boolean);
if (!names.length) status();
else {
  if (!process.stdin.isTTY) {
    say("Run this in a terminal — it asks questions.");
    process.exit(1);
  }
  for (const n of names) {
    const s = SERVERS.find((x) => x.name === n || x.dir === n);
    if (!s) {
      say(`Unknown server "${n}". Run  analyticsdev-mcp setup  to see the list.`);
      process.exit(1);
    }
    await setup(s);
  }
}
