# Getting started — from zero to a working AI connection

A step-by-step guide for anyone, including people who have never used a terminal: install the tools, add your keys, and connect the servers to Claude, ChatGPT, Codex, Google Antigravity, Cursor, Devin, Gemini, VS Code Copilot, Windsurf, Warp, Trae or any other MCP-capable app. For a per-app reference see [LLM-PLATFORMS.md](LLM-PLATFORMS.md).

**Time needed:** about 20–30 minutes the first time, depending on how many platforms you connect.

## Contents

1. [Requirements](#1-requirements)
2. [Install Node.js and Git](#2-install-nodejs-and-git)
3. [Download and build the project](#3-download-and-build-the-project)
4. [Add your keys to `.env`](#4-add-your-keys-to-env)
5. [What each server does](#5-what-each-server-does)
6. [Connect your AI app](#6-connect-your-ai-app)
7. [ChatGPT and claude.ai: the gateway](#7-chatgpt-and-claudeai-the-gateway)
8. [Cloud agents: Devin and GitHub Copilot](#8-cloud-agents-devin-and-github-copilot)
9. [Check that it works](#9-check-that-it-works)
10. [Security rules](#10-security-rules)
11. [Troubleshooting](#11-troubleshooting)
12. [Updating](#12-updating)

---

## 1. Requirements

- A Mac, Windows or Linux computer
- Node.js 20 or newer, and Git
- Access to this repository (for a private repository, the owner adds you as a collaborator)
- Accounts with admin or editor access on the platforms you want to use (for example a GA4 property or a Meta ad account)
- At least one AI app

> "Terminal" means the **Terminal** app on macOS or **PowerShell** on Windows. Paste each command block there and press Enter.

## 2. Install Node.js and Git

**macOS**
1. Install the **LTS** version from [nodejs.org](https://nodejs.org), or with Homebrew: `brew install node git`.
2. If Git is missing, running `git --version` prompts macOS to install it — choose *Install*.

**Windows**
1. Run the **LTS** installer (.msi) from [nodejs.org](https://nodejs.org) with the default options.
2. Install Git from [git-scm.com](https://git-scm.com/download/win).
3. Close and reopen PowerShell.

**Check**
```bash
node -v        # must show v20 or higher
git --version
```

## 3. Download and build the project

```bash
cd ~                                   # Windows PowerShell: cd $HOME
git clone https://github.com/ecodelearnwithsakib-dev/AnalyticsDev-MCP.git
cd AnalyticsDev-MCP
npm install
npm run build
```

If Git asks you to sign in, complete the GitHub sign-in in the browser. When `npm run build` finishes without errors, a `dist/` folder exists — that is what the AI apps run.

## 4. Add your keys to `.env`

Every API key and token lives only in the project's `.env` file. Never put keys into an AI app's config, a chat or a screenshot.

```bash
cp .env.example .env          # Windows: copy .env.example .env
```

Step-by-step instructions for every platform are in [SETUP-GUIDE.md](SETUP-GUIDE.md).

**Easiest: the guided setup.** It asks for each value in the terminal (secrets are hidden while you type), saves them to `.env` and opens the browser sign-in when the platform needs one:

```bash
npm run setup                 # which servers already have credentials
npm run setup -- gtm          # set up one server (Google ones ask for the OAuth client once)
npm run setup -- shopify hubspot
```

Then add the servers to Claude Desktop — run this from the macOS **Terminal** app (it quits Claude, adds every server as "Analytics Dev <Platform>" and reopens it):

```bash
npm run claude-desktop                 # all servers
npm run claude-desktop -- gtm ga4      # only some
```

**Or by hand:** open `.env` in any text editor and fill in **only the platforms you use**; leave the rest empty. Each section's comment explains where to find its values. In short:

| Platform | Values | Where to get them |
|---|---|---|
| Meta | `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID` | Business Settings → Users → System users → Generate token |
| GA4 · GTM · BigQuery · Looker Studio · Google Ads | `GA4_OAUTH_CLIENT_ID`, `GA4_OAUTH_CLIENT_SECRET` | Google Cloud → Credentials → OAuth client (Desktop app), then the sign-ins below |
| Google Ads | `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` | Google Ads → Tools → API Center |
| Microsoft Ads | `MSADS_DEVELOPER_TOKEN`, `MSADS_ACCOUNT_ID` | ads.microsoft.com → Developer settings |
| OpenAI Ads | `OPENAI_ADS_API_KEY` | ads.openai.com → Settings → API keys |
| Reddit | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | reddit.com/prefs/apps (web app) |
| Stape / sGTM | `SGTM_URL`, `STAPE_API_KEY` | Stape → Settings → API key |
| Matomo | `MATOMO_URL`, `MATOMO_TOKEN`, `MATOMO_SITE_ID` | Administration → Personal → Security |
| n8n | `N8N_URL`, `N8N_API_KEY` | n8n → Settings → n8n API |
| ClickUp | `CLICKUP_API_TOKEN` | Settings → Apps → API Token |
| Slack | `SLACK_USER_TOKEN` | api.slack.com/apps, created from `slack-app-manifest.json` |
| Zoho CRM | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_DC` | api-console.zoho.com |
| Odoo | `ODOO_URL`, `ODOO_API_KEY` | My Preferences → Account Security → New API Key |
| HighLevel | `GHL_API_TOKEN`, `GHL_LOCATION_ID` | Sub-account → Settings → Private Integrations |
| Pipedrive | `PIPEDRIVE_DOMAIN`, `PIPEDRIVE_API_TOKEN` | Personal preferences → API |
| Salesforce | `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_LOGIN_URL` | Setup → External Client App Manager |
| Search Console · Merchant Center · YouTube · Sheets | the same Google OAuth client | enable the API in Google Cloud, then the sign-ins below |
| LinkedIn · Pinterest · Snapchat · Amazon Ads | app client ID + secret | each platform's developer portal (redirect `http://localhost:53687/callback`) |
| X Ads · TikTok Business | API keys / access token | developer.x.com · TikTok for Business developers |
| Shopify · WooCommerce · HubSpot | admin/API token or consumer key | custom app / REST API key / private app |
| PostHog · Mixpanel · Amplitude · Clarity | API key / service account / export token | each product's settings |
| Klaviyo · Mailchimp · WhatsApp · Airtable · Notion | API key / token | each product's settings |

Step-by-step values for the last eight rows are in [PLATFORMS.md](PLATFORMS.md).

**One-time sign-ins** — a browser opens; after you sign in, the token is written to `.env` automatically. Run only the ones you need:

```bash
npm run auth:ga4
npm run auth:gtm
npm run auth:bigquery
npm run auth:looker-studio
npm run auth:google-ads
npm run auth:microsoft-ads-google   # Microsoft account instead: npm run auth:microsoft-ads
npm run auth:zoho-crm
npm run auth:salesforce
npm run auth:reddit
npm run auth:search-console   # also: auth:merchant, auth:youtube, auth:sheets
npm run auth:linkedin         # also: auth:pinterest, auth:snapchat, auth:amazon-ads
```

Full details are in the README's **Credentials** section.

## 5. What each server does

| Server | Purpose |
|---|---|
| `meta` | Facebook/Instagram Ads, Pages, Pixel/CAPI, Catalog |
| `google-ads` | Reports, campaigns, Keyword Planner, offline conversions |
| `microsoft-ads` | Microsoft Advertising (Bing) |
| `openai-ads` | Ads in ChatGPT |
| `reddit` | Reddit Ads plus community search, posting and inbox |
| `ga4` | Google Analytics 4 reporting and admin |
| `matomo` | Matomo analytics |
| `looker-studio` | Report links and sharing |
| `bigquery` | SQL, tables, exports, scheduled queries |
| `stape` | Server-side GTM testing and the Stape account |
| `gtm` | Tags, triggers, variables, publishing |
| `n8n` | Workflows and executions |
| `clickup` | Tasks, reports, time tracking |
| `slack` | Messages, search, catch-up digest |
| `zoho-crm` · `odoo` · `ghl` · `pipedrive` · `salesforce` · `hubspot` | CRM: leads, deals, pipeline reports, activities |
| `linkedin-ads` · `pinterest-ads` · `snapchat-ads` · `x-ads` · `amazon-ads` · `tiktok-business` | More ad platforms: reports, budgets, Conversions APIs |
| `search-console` · `merchant-center` · `youtube-analytics` · `google-sheets` | SEO, Shopping feed, YouTube, spreadsheets |
| `shopify` · `woocommerce` | Store sales with attribution, orders, products |
| `posthog` · `mixpanel` · `amplitude` · `clarity` | Product analytics and UX friction |
| `klaviyo` · `mailchimp` · `whatsapp` | Email/SMS revenue, audiences, WhatsApp templates and sends |
| `airtable` · `notion` | Workspace data |
| `ads-hub` · `tracking-audit` · `conversion-sync` · `monitor` | Cross-platform: blended reports, audits, offline conversions, alerts |

> **Prefer not to clone?** `npx -y github:ecodelearnwithsakib-dev/AnalyticsDev-MCP init` creates `~/.analyticsdev-mcp/.env`, and Claude Desktop users can install one-click extensions — see [DISTRIBUTION.md](DISTRIBUTION.md).

> **Don't add all forty-five servers to one app.** Together they expose ~500 tools, and many apps cap active tools (Cursor around 40, VS Code 128 per request). Add only what each app needs.

## 6. Connect your AI app

Every app starts the same way — run this in the project folder:

```bash
npm run config -- <app> <server,server>
```

For example `npm run config -- cursor ga4,meta`. It prints a config block with **the real paths on your computer** and, at the top, which file or menu to paste it into. Leave out the server list to include every built server; run `npm run config` alone to list all app names.

**Claude Code** — `npm run config -- claude-code ga4,meta`, run the printed `claude mcp add --scope user …` lines, then `claude mcp list` (every server shows ✔ Connected).

**Claude Desktop** — `npm run config -- claude-desktop ga4,meta` → Claude → Settings → Developer → **Edit Config** → merge the `mcpServers` block → save → quit Claude completely and reopen.

**claude.ai (web and mobile)** — needs the [gateway](#7-chatgpt-and-claudeai-the-gateway). Then Settings → **Connectors → Add custom connector** → URL `https://<tunnel>/<MCP_GATEWAY_TOKEN>/<server>/mcp` with the OAuth fields empty.

**ChatGPT** — needs the [gateway](#7-chatgpt-and-claudeai-the-gateway). Settings → **Apps & Connectors → Advanced settings → Developer mode** (Plus, Pro, Business, Enterprise, Edu) → **Create** → URL `https://<tunnel>/<server>/mcp`, authentication **Token** = the value of `MCP_GATEWAY_TOKEN` → enable it from the **+** menu in a chat.

**OpenAI Codex** — `npm run config -- codex ga4,meta` → append the TOML to `~/.codex/config.toml` (shared by the CLI and IDE extension) or run the `codex mcp add …` lines → `codex mcp list`.

**Google Antigravity** — `npm run config -- antigravity ga4,meta` → IDE: Agent panel **…** → *MCP Servers* → *Manage MCP Servers* → *View raw config* (Antigravity 2.0: Settings → Customizations → Installed MCP Servers) → merge into `~/.gemini/config/mcp_config.json` → save → **Refresh**. Remote servers use `serverUrl`, e.g. `{ "serverUrl": "https://mcp.pipedrive.ai/mcp" }`.

**Gemini CLI** — `npm run config -- gemini ga4,meta` → merge into `~/.gemini/settings.json` or run the `gemini mcp add -s user …` lines → `/mcp` inside Gemini.

**Cursor** — `npm run config -- cursor ga4,meta` → Settings → **MCP → Add new global MCP server** → paste into `~/.cursor/mcp.json` → save.

**VS Code (GitHub Copilot)** — `npm run config -- vscode ga4,meta` → Command Palette → **MCP: Open User Configuration** → paste the `servers` block → use Copilot Chat in **Agent** mode.

**Windsurf** — `npm run config -- windsurf ga4,meta` → Settings → Cascade → **MCP Servers → View raw config** → merge → **Refresh**.

**Warp · Trae · Zed · Cline · Roo Code · Kilo Code · Continue · JetBrains AI · Augment · Kiro · Amazon Q · Goose · opencode · LM Studio** — run `npm run config -- <name> ga4` with `warp`, `trae`, `zed`, `cline`, `roo`, `kilo`, `continue`, `jetbrains`, `augment`, `kiro`, `amazonq`, `goose`, `opencode` or `lmstudio`; the output says exactly where to paste. Details per app: [LLM-PLATFORMS.md](LLM-PLATFORMS.md).

**Ollama via Open WebUI** — start the gateway (no tunnel needed on the same machine) → Admin Panel → Settings → **External Tools → Add** → type **MCP (Streamable HTTP)** → URL `http://localhost:8787/<server>/mcp`, Bearer token = `MCP_GATEWAY_TOKEN`.

## 7. ChatGPT and claude.ai: the gateway

ChatGPT, claude.ai, Le Chat and Copilot Studio can't start programs on your computer; they only accept an HTTPS address.

**1. Start the gateway** with only the servers you need:
```bash
npm run serve -- ga4,meta
```
The first run creates `MCP_GATEWAY_TOKEN` in `.env` — that is the password. Keep the terminal open. To allow read-only tools only:
```bash
npm run serve -- ga4,meta --allow "ga4_run_*,ga4_list_*,meta_get_insights,meta_list_*"
```

**2. Start an HTTPS tunnel** in a second terminal:
```bash
brew install cloudflared            # Windows: winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:8787
```
It prints an address like `https://xxxx.trycloudflare.com`.

**3. Build the URLs**

| App | URL | Auth |
|---|---|---|
| ChatGPT, Open WebUI, Devin (HTTP) | `https://xxxx.trycloudflare.com/ga4/mcp` | Token = `MCP_GATEWAY_TOKEN` |
| claude.ai, Le Chat | `https://xxxx.trycloudflare.com/<MCP_GATEWAY_TOKEN>/ga4/mcp` | None (the token is in the URL) |

`npm run config -- remote ga4,meta` prints every URL pattern.

> ⚠️ Anyone with the URL and token can act on your connected accounts. Stop both terminals (Ctrl+C) when you're done. If a token leaks, delete the `MCP_GATEWAY_TOKEN` line in `.env` and restart the gateway to get a new one.

## 8. Cloud agents: Devin and GitHub Copilot

These run on their own cloud machines, so your `.env` isn't there — keys go into their **secrets** instead. `npm run config` lists the secret names each server needs.

**Devin**
```bash
npm run config -- devin ga4,pipedrive
```
1. **Settings → Devin's Machine:** give Devin this repository (GitHub integration) and add the setup command `git clone … ~/repos/AnalyticsDev-MCP && cd ~/repos/AnalyticsDev-MCP && npm ci && npm run build`.
2. **Settings → Secrets:** add the listed names with the values from your `.env`. Do the Google/Zoho/Salesforce/Reddit sign-ins on your own computer first and copy the refresh tokens.
3. **Customize → MCPs → Add MCP → Add custom MCP** → transport **STDIO** → command `node` → the printed argument → Save → **Use MCP**.
4. Alternative: transport **HTTP** with the gateway URL and auth header `Authorization: Bearer <MCP_GATEWAY_TOKEN>` (your computer must keep the gateway running).

**GitHub Copilot coding agent**
```bash
npm run config -- copilot-agent pipedrive
```
1. Repository → **Settings → Copilot → Coding agent → MCP configuration** → paste the JSON.
2. **Settings → Environments → `copilot`** → add each secret prefixed `COPILOT_MCP_` (e.g. `COPILOT_MCP_PIPEDRIVE_API_TOKEN`) plus `MCP_REPO_TOKEN` (a token that can read this repository).
3. Commit the printed `.github/workflows/copilot-setup-steps.yml`.

## 9. Check that it works

- Ask something small first: "List my GA4 accounts", "Check the Pipedrive connection", "Matomo overview for the last 7 days". Many servers include a `*_health` or `*_whoami` tool.
- In Claude Code: `claude mcp list` → every server ✔ Connected.
- `Missing environment variable X` → add X to `.env` and restart the app.

## 10. Security rules

1. Keys and tokens go only in `.env` — never in chats, config files or screenshots.
2. Never commit `.env` (the repository already ignores it).
3. New ads are always created **paused**. Deleting, sending messages or emails, confirming orders, posting invoices and spending money require `confirm: true` — read what the AI proposes before saying yes.
4. Run the gateway only while you need it, and restrict it with `--allow`.
5. If any token leaks, revoke it on that platform immediately and create a new one.

## 11. Troubleshooting

| Problem | Fix |
|---|---|
| `node: command not found` | Install Node, reopen the terminal, check `node -v` |
| The app doesn't start the servers | Use the config from `npm run config` — it contains the full Node path; re-run it after changing Node versions |
| `Missing environment variable …` | Add the key to `.env` and restart the app |
| Token expired / 401 | Re-run that platform's `npm run auth:…` or create a new key |
| The AI ignores the tools | Enable fewer servers |
| Timeouts on long reports | Raise the app's timeout (Codex `tool_timeout_sec`, Gemini/Cline `timeout`) |
| ChatGPT connector doesn't appear | Developer mode on? URL ends with `/mcp`? Enabled in the chat's + menu? |
| claude.ai connector fails | Open `https://<tunnel>/health` to check the tunnel; use the token URL with OAuth left empty |
| Windows paths | Run `npm run config` on the Windows machine itself |

Logs: Claude Desktop `~/Library/Logs/Claude/mcp-server-<name>.log`; Claude Code `claude --debug`; the gateway prints to its terminal.

## 12. Updating

```bash
cd ~/AnalyticsDev-MCP
git pull
npm install
npm run build
```

Restart your AI apps afterwards; the config doesn't change because the paths stay the same.
