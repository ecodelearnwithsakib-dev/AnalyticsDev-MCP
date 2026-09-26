# সম্পূর্ণ Setup Guide (বাংলা) — যেকোনো AI app-এ এই MCP server-গুলো চালানো

এই guide পড়ে একজন নতুন মানুষও নিজের computer-এ server-গুলো বসিয়ে Claude, ChatGPT, Codex, Google Antigravity, Cursor, Devin, Gemini, VS Code Copilot, Windsurf, Warp, Trae সহ যেকোনো AI app-এর সাথে যুক্ত করতে পারবেন। English-এ বিস্তারিত reference: [LLM-PLATFORMS.md](LLM-PLATFORMS.md)।

**মোট সময়:** প্রথমবার প্রায় ২০–৩০ মিনিট (কোন কোন platform-এর key বসাবেন তার উপর নির্ভর করে)।

---

## সূচিপত্র

1. [কী কী লাগবে](#১-কী-কী-লাগবে)
2. [Node.js আর Git install](#২-nodejs-আর-git-install)
3. [Project নামানো ও build](#৩-project-নামানো-ও-build)
4. [`.env` file-এ key বসানো](#৪-env-file-এ-key-বসানো)
5. [কোন server কী করে](#৫-কোন-server-কী-করে)
6. [আপনার AI app-এ যুক্ত করা](#৬-আপনার-ai-app-এ-যুক্ত-করা)
7. [ChatGPT / claude.ai-এর জন্য gateway](#৭-chatgpt--claudeai-এর-জন্য-gateway)
8. [Cloud agent: Devin, GitHub Copilot agent](#৮-cloud-agent-devin-github-copilot-agent)
9. [ঠিকমতো চলছে কিনা পরীক্ষা](#৯-ঠিকমতো-চলছে-কিনা-পরীক্ষা)
10. [নিরাপত্তার নিয়ম](#১০-নিরাপত্তার-নিয়ম)
11. [সমস্যা ও সমাধান](#১১-সমস্যা-ও-সমাধান)
12. [Update করা](#১২-update-করা)

---

## ১. কী কী লাগবে

- একটা Mac, Windows বা Linux computer
- Node.js 20 বা তার নতুন version, আর Git
- এই repository-র access (private repo হলে owner আপনাকে collaborator হিসেবে যোগ করবেন)
- যে platform চালাবেন (যেমন GA4, Meta, Pipedrive) সেগুলোর account আর admin/editor access
- যেকোনো একটা AI app (Claude, ChatGPT, Cursor ইত্যাদি)

> Terminal মানে: Mac-এ **Terminal** app, Windows-এ **PowerShell**। নিচের `code block`-এর লাইনগুলো সেখানে copy-paste করে Enter চাপবেন।

---

## ২. Node.js আর Git install

**Mac:**
1. [nodejs.org](https://nodejs.org) থেকে **LTS** installer নামিয়ে install করুন (অথবা Homebrew থাকলে `brew install node git`)।
2. Git না থাকলে Terminal-এ `git --version` লিখলে Mac নিজেই install করতে বলবে — *Install* চাপুন।

**Windows:**
1. [nodejs.org](https://nodejs.org) থেকে **LTS** installer (.msi) চালান — সব default রাখুন।
2. [git-scm.com](https://git-scm.com/download/win) থেকে Git install করুন।
3. PowerShell বন্ধ করে আবার খুলুন।

**যাচাই:**
```bash
node -v    # v20 বা তার বেশি দেখাতে হবে
git --version
```

---

## ৩. Project নামানো ও build

```bash
cd ~                                   # home folder-এ যান (Windows-এ: cd $HOME)
git clone https://github.com/ecodelearnwithsakib-dev/AnalyticsDev-MCP.git
cd AnalyticsDev-MCP
npm install
npm run build
```

- Git জিজ্ঞেস করলে GitHub-এ login করুন (browser খুলবে)। Password বা token কখনো কারো সাথে share করবেন না।
- `npm run build` শেষে কোনো error না দেখালে ঠিক আছে। `dist/` নামে একটা folder তৈরি হবে।

> **Folder-এর পুরো path মনে রাখুন** — `pwd` (Mac) বা `Get-Location` (Windows) লিখলে দেখাবে। পরে config বানানোর tool এটা নিজেই বসিয়ে দেবে।

---

## ৪. `.env` file-এ key বসানো

সব secret (API key, token) শুধু project folder-এর `.env` file-এ থাকে। কোনো AI app-এর config বা chat-এ কখনো key লিখবেন না।

```bash
cp .env.example .env          # Windows: copy .env.example .env
```

তারপর `.env` file-টা যেকোনো text editor-এ খুলুন (VS Code, TextEdit, Notepad)। **শুধু যে platform চালাবেন সেগুলোর লাইন পূরণ করুন**, বাকিগুলো খালি থাকুক। প্রতিটা section-এর উপরে comment-এ লেখা আছে key কোথা থেকে পাবেন। সংক্ষেপে:

| Platform | কী বসাবেন | কোথা থেকে |
|---|---|---|
| Meta | `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID` | Business Settings → Users → System users → Generate token |
| GA4 / GTM / BigQuery / Looker / Google Ads | `GA4_OAUTH_CLIENT_ID`, `GA4_OAUTH_CLIENT_SECRET` | Google Cloud → Credentials → OAuth client (Desktop app); তারপর `npm run auth:ga4` ইত্যাদি |
| Google Ads | `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` | Google Ads → Tools → API Center |
| Microsoft Ads (Bing) | `MSADS_DEVELOPER_TOKEN`, `MSADS_ACCOUNT_ID` | ads.microsoft.com → Developer settings; তারপর `npm run auth:microsoft-ads-google` |
| OpenAI Ads | `OPENAI_ADS_API_KEY` | ads.openai.com → Settings → API keys |
| Reddit | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | reddit.com/prefs/apps (web app); তারপর `npm run auth:reddit` |
| Stape / sGTM | `SGTM_URL`, `STAPE_API_KEY` | Stape → Settings → API key |
| Matomo | `MATOMO_URL`, `MATOMO_TOKEN`, `MATOMO_SITE_ID` | Matomo → Administration → Personal → Security |
| n8n | `N8N_URL`, `N8N_API_KEY` | n8n → Settings → n8n API |
| ClickUp | `CLICKUP_API_TOKEN` | ClickUp → Settings → Apps → API Token |
| Slack | `SLACK_USER_TOKEN` | api.slack.com/apps-এ `slack-app-manifest.json` দিয়ে app বানিয়ে |
| Zoho CRM | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_DC` | api-console.zoho.com; তারপর `npm run auth:zoho-crm` |
| Odoo | `ODOO_URL`, `ODOO_API_KEY` | Odoo → My Preferences → Account Security → New API Key |
| HighLevel (GHL) | `GHL_API_TOKEN`, `GHL_LOCATION_ID` | Sub-account → Settings → Private Integrations |
| Pipedrive | `PIPEDRIVE_DOMAIN`, `PIPEDRIVE_API_TOKEN` | Personal preferences → API |
| Salesforce | `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_LOGIN_URL` | Setup → External Client App; তারপর `npm run auth:salesforce` |

**একবারের sign-in (browser খুলবে, login করলে token নিজে থেকেই `.env`-এ লেখা হবে):**

```bash
npm run auth:ga4              # GA4
npm run auth:gtm              # Google Tag Manager
npm run auth:bigquery         # BigQuery
npm run auth:looker-studio    # Looker Studio
npm run auth:google-ads       # Google Ads
npm run auth:microsoft-ads-google   # Bing Ads (Google login হলে) — Microsoft login হলে: npm run auth:microsoft-ads
npm run auth:zoho-crm         # Zoho CRM
npm run auth:salesforce       # Salesforce
npm run auth:reddit           # Reddit
```

শুধু যেগুলো ব্যবহার করবেন সেগুলো চালান। বিস্তারিত নির্দেশনা README-র **Credentials** অংশে।

---

## ৫. কোন server কী করে

| Server নাম | কাজ |
|---|---|
| `meta` | Facebook/Instagram Ads, Pages, Pixel/CAPI, Catalog |
| `google-ads` | Google Ads report, campaign, keyword, offline conversion |
| `microsoft-ads` | Bing Ads |
| `openai-ads` | ChatGPT-এর বিজ্ঞাপন |
| `reddit` | Reddit Ads + Reddit community (search, post, inbox) |
| `ga4` | Google Analytics 4 report ও admin |
| `matomo` | Matomo analytics |
| `looker-studio` | Looker Studio report link ও sharing |
| `bigquery` | BigQuery SQL, table, export |
| `stape` | Stape / server-side GTM test ও account |
| `gtm` | Google Tag Manager tag, trigger, publish |
| `n8n` | n8n workflow ও execution |
| `clickup` | ClickUp task, report, time |
| `slack` | Slack message, search, digest |
| `zoho-crm` | Zoho CRM |
| `odoo` | Odoo CRM, sales, invoice |
| `ghl` | HighLevel (GoHighLevel) |
| `pipedrive` | Pipedrive CRM |
| `salesforce` | Salesforce CRM |

> **গুরুত্বপূর্ণ:** এক app-এ সব ১৯টা server একসাথে যোগ করবেন না — প্রায় ৩০০ tool হয়ে যায়, আর অনেক app (যেমন Cursor ~৪০, VS Code ১২৮) এর বেশি নিতে পারে না। যে কাজে যেটা দরকার শুধু সেটা যোগ করুন।

---

## ৬. আপনার AI app-এ যুক্ত করা

সব app-এর জন্য একই নিয়ম — project folder থেকে এই command চালান:

```bash
npm run config -- <app-নাম> <server,server>
```

উদাহরণ: `npm run config -- cursor ga4,meta`। এটা আপনার computer-এর **আসল path বসানো** config দেখাবে, আর উপরে লেখা থাকবে কোন file-এ বা কোন menu-তে paste করতে হবে। Server-এর নাম না দিলে সব build করা server আসবে।

সব app-এর নাম দেখতে: `npm run config`

### Claude Code (Terminal, Claude desktop app-এর Code tab, VS Code/JetBrains extension)
```bash
npm run config -- claude-code ga4,meta
```
যে `claude mcp add …` লাইনগুলো দেখাবে সেগুলো Terminal-এ চালান। তারপর `claude mcp list` — সবগুলোর পাশে **✔ Connected** দেখাবে।

### Claude Desktop (Chat / Cowork)
1. `npm run config -- claude-desktop ga4,meta`
2. Claude → **Settings → Developer → Edit Config** → file খুলবে → `mcpServers` অংশটা paste/merge করুন → save।
3. Claude **পুরোপুরি বন্ধ** করে (Mac: ⌘Q) আবার খুলুন। Chat box-এর tools icon-এ server দেখাবে।

### claude.ai (web ও mobile)
এটা আপনার computer-এ program চালাতে পারে না, তাই [৭ নম্বর ধাপের gateway](#৭-chatgpt--claudeai-এর-জন্য-gateway) লাগবে। তারপর **Settings → Connectors → Add custom connector** → URL দিন `https://<tunnel>/<MCP_GATEWAY_TOKEN>/<server>/mcp` (OAuth ঘর খালি রাখুন)। Web-এ যোগ করলে mobile-এও পাবেন।

### ChatGPT
Gateway লাগবে ([৭ নম্বর ধাপ](#৭-chatgpt--claudeai-এর-জন্য-gateway))। তারপর:
1. ChatGPT → **Settings → Apps & Connectors → Advanced settings → Developer mode** চালু করুন (Plus/Pro/Business/Enterprise/Edu লাগবে)।
2. **Create** → নাম, বর্ণনা, URL `https://<tunnel>/<server>/mcp` → Authentication: **Token** → `.env` থেকে `MCP_GATEWAY_TOKEN`-এর মান বসান।
3. Chat-এ **+** menu থেকে Developer mode বেছে connector চালু করুন।

### OpenAI Codex (CLI ও IDE extension)
```bash
npm run config -- codex ga4,meta
```
দেখানো TOML অংশটা `~/.codex/config.toml`-এর শেষে যোগ করুন, **অথবা** নিচের `codex mcp add …` লাইনগুলো চালান। যাচাই: `codex mcp list`।

### Google Antigravity (IDE, Antigravity 2.0, CLI)
```bash
npm run config -- antigravity ga4,meta
```
1. **IDE:** ডান পাশের Agent panel → **…** → **MCP Servers** → **Manage MCP Servers** → **View raw config**।
   **Antigravity 2.0 app:** Settings → Customizations → Installed MCP Servers।
2. File (`~/.gemini/config/mcp_config.json`)-এ `mcpServers` অংশটা merge করে save করুন → **Refresh** চাপুন।
3. CLI-তে `/mcp` লিখলে server-গুলো দেখাবে।
4. Remote server (যেমন Pipedrive official) যোগ করতে `url` নয়, **`serverUrl`** লিখতে হয়: `"pipedrive-official": { "serverUrl": "https://mcp.pipedrive.ai/mcp" }`।

### Gemini CLI
```bash
npm run config -- gemini ga4,meta
```
JSON অংশ `~/.gemini/settings.json`-এ merge করুন, অথবা `gemini mcp add -s user …` লাইনগুলো চালান। Gemini-র ভেতরে `/mcp` লিখে যাচাই করুন।

### Cursor
```bash
npm run config -- cursor ga4,meta
```
Cursor → **Settings → MCP → Add new global MCP server** → file খুলবে (`~/.cursor/mcp.json`) → paste → save → server-গুলো সবুজ হবে। অপ্রয়োজনীয় server এখান থেকেই বন্ধ রাখুন।

### VS Code (GitHub Copilot)
```bash
npm run config -- vscode ga4,meta
```
Command Palette (⇧⌘P / Ctrl+Shift+P) → **MCP: Open User Configuration** → `servers` অংশ paste → save। Copilot Chat **Agent** mode-এ 🔧 চেপে tool বেছে নিন।

### Windsurf
```bash
npm run config -- windsurf ga4,meta
```
Settings → Cascade → **MCP Servers → View raw config** → merge → **Refresh**।

### Warp
`npm run config -- warp ga4` → Warp → **Settings → AI → Manage MCP servers → + Add** → JSON paste → Save → list থেকে server start করুন।

### Trae
`npm run config -- trae ga4` → Settings (⚙) → **MCP → Add → Add Manually** → paste → Confirm।

### Zed
`npm run config -- zed ga4` → Zed-এর `settings.json`-এ `context_servers` অংশ merge করুন। Agent panel-এ সবুজ বিন্দু দেখাবে।

### Cline · Roo Code · Kilo Code
`npm run config -- cline ga4` (অথবা `roo` / `kilo`) → extension-এর **MCP Servers → Configure / Edit Global MCP** → merge → save।

### Continue · JetBrains AI Assistant · Augment · Kiro · Amazon Q · Goose · opencode · LM Studio
`npm run config -- <নাম> ga4` চালান — কোন file বা কোন menu তা output-এর উপরে লেখা থাকবে। নামগুলো: `continue`, `jetbrains`, `augment`, `kiro`, `amazonq`, `goose`, `opencode`, `lmstudio`।

### Ollama / Open WebUI
Gateway চালান (৭ নম্বর ধাপ; একই computer-এ হলে tunnel লাগবে না) → Open WebUI → **Admin Panel → Settings → External Tools → Add** → type **MCP (Streamable HTTP)** → URL `http://localhost:8787/<server>/mcp` → Bearer token = `MCP_GATEWAY_TOKEN`।

---

## ৭. ChatGPT / claude.ai-এর জন্য gateway

ChatGPT, claude.ai, Le Chat, Copilot Studio শুধু internet-এর HTTPS ঠিকানা নেয়। তাই:

**১) Gateway চালু করুন** (যে server-গুলো দরকার শুধু সেগুলো):
```bash
npm run serve -- ga4,meta
```
প্রথমবার `.env`-এ `MCP_GATEWAY_TOKEN` তৈরি হবে — এটাই পাসওয়ার্ড। Terminal খোলা রাখুন।

শুধু পড়ার (read-only) অনুমতি দিতে চাইলে:
```bash
npm run serve -- ga4,meta --allow "ga4_run_*,ga4_list_*,meta_get_insights,meta_list_*"
```

**২) HTTPS tunnel চালু করুন** (নতুন Terminal window-এ):
```bash
brew install cloudflared                 # Windows: winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:8787
```
একটা `https://xxxx.trycloudflare.com` ঠিকানা দেখাবে।

**৩) URL বানান:**
- ChatGPT (Token auth): `https://xxxx.trycloudflare.com/ga4/mcp` + Token = `MCP_GATEWAY_TOKEN`
- claude.ai (token URL-এর ভিতরে): `https://xxxx.trycloudflare.com/<MCP_GATEWAY_TOKEN>/ga4/mcp`

`npm run config -- remote ga4,meta` সব URL-এর নমুনা দেখায়।

> ⚠️ URL আর token যার কাছে থাকবে সে আপনার account চালাতে পারবে। কাজ শেষে দুই Terminal-ই বন্ধ করুন (Ctrl+C)। Token ফাঁস হলে `.env` থেকে `MCP_GATEWAY_TOKEN` লাইন মুছে gateway আবার চালান — নতুন token তৈরি হবে।

---

## ৮. Cloud agent: Devin, GitHub Copilot agent

এগুলো আপনার computer-এ নয়, নিজেদের cloud machine-এ চলে — তাই আপনার `.env` সেখানে থাকে না। Key রাখতে হয় ওদের **Secrets**-এ।

### Devin
```bash
npm run config -- devin ga4,pipedrive
```
এটা দেখাবে: machine setup command, প্রতিটা server-এর Command/Arguments, আর **কোন কোন secret লাগবে তার নাম**।
1. **Settings → Devin's Machine:** এই repo Devin-কে দিন (GitHub integration) আর setup command বসান: `git clone … ~/repos/AnalyticsDev-MCP && cd ~/repos/AnalyticsDev-MCP && npm ci && npm run build`।
2. **Settings → Secrets:** দেখানো নামগুলো দিয়ে secret যোগ করুন (মান নিন নিজের `.env` থেকে)। Google/Zoho/Salesforce/Reddit-এর sign-in আগে নিজের computer-এ করে নিন, তারপর refresh token secret হিসেবে দিন।
3. **Customize → MCPs → Add MCP → Add custom MCP** → Transport **STDIO** → Command `node` → Arguments দেখানো path → Save → **Use MCP** চেপে test করুন।
4. সহজ বিকল্প: Transport **HTTP** → gateway URL + Auth Header `Authorization: Bearer <MCP_GATEWAY_TOKEN>` (তখন আপনার computer-এ gateway চালু থাকতে হবে)।

### GitHub Copilot coding agent
```bash
npm run config -- copilot-agent pipedrive
```
1. Repository → **Settings → Copilot → Coding agent → MCP configuration** → দেখানো JSON paste।
2. **Settings → Environments → `copilot`** → প্রতিটা secret `COPILOT_MCP_` দিয়ে শুরু করে যোগ করুন (যেমন `COPILOT_MCP_PIPEDRIVE_API_TOKEN`), আর `MCP_REPO_TOKEN` (এই private repo পড়ার fine-grained token)।
3. দেখানো `.github/workflows/copilot-setup-steps.yml` file commit করুন।

---

## ৯. ঠিকমতো চলছে কিনা পরীক্ষা

AI app-এ এরকম লিখে দেখুন:
- “GA4 connection check করো” → `ga4_*` tool চলবে
- “Pipedrive health check” / “Salesforce org info দেখাও” / “Matomo last 7 days overview”
- প্রথমে ছোট কিছু জিজ্ঞেস করুন — যেমন “আমার GA4 account-গুলোর তালিকা দাও” বা “Meta whoami” — অনেক server-এ `*_health` / `*_whoami` ধরনের connection-check tool আছে।

Claude Code-এ: `claude mcp list` → সব **✔ Connected**।

Error-এ যদি লেখে `Missing environment variable X` → `.env`-এ X বসান, তারপর app restart করুন।

---

## ১০. নিরাপত্তার নিয়ম

1. **Key/token কখনো chat-এ, config file-এ বা screenshot-এ দেবেন না** — শুধু `.env`-এ।
2. `.env` কখনো GitHub-এ push করবেন না (repo-র `.gitignore`-এ আগে থেকেই বাদ দেওয়া আছে)।
3. বিজ্ঞাপন নতুন বানালে সব **PAUSED** থাকে; delete, message/email পাঠানো, order confirm, invoice post, টাকা খরচ — এসবে `confirm: true` লাগে। AI জিজ্ঞেস করলে পড়ে তারপর হ্যাঁ বলুন।
4. Gateway শুধু দরকারের সময় চালান, `--allow` দিয়ে সীমিত রাখুন।
5. কোনো token ফাঁস হলে সঙ্গে সঙ্গে সেই platform থেকে revoke করে নতুন বানান।

---

## ১১. সমস্যা ও সমাধান

| সমস্যা | সমাধান |
|---|---|
| `node: command not found` | Node install করে Terminal বন্ধ-খোলা করুন; `node -v` দেখুন |
| App-এ server চালু হয় না (Claude Desktop, Antigravity ইত্যাদি) | `npm run config` দিয়ে বানানো config ব্যবহার করুন — এতে Node-এর পুরো path থাকে। Node version বদলালে আবার চালান |
| `Missing environment variable …` | `.env`-এ সেই key বসিয়ে app restart |
| Token expired / 401 | ওই platform-এর `npm run auth:…` আবার চালান বা নতুন key বসান |
| AI tool ব্যবহার করছে না / “too many tools” | কম server চালু রাখুন |
| অনেকক্ষণ পর timeout | App-এর timeout বাড়ান (Codex: `tool_timeout_sec`, Gemini/Cline: `timeout`) |
| ChatGPT-তে connector দেখা যায় না | Developer mode চালু আছে কিনা, URL `/mcp` দিয়ে শেষ কিনা, chat-এর + menu-তে চালু করেছেন কিনা |
| claude.ai connector fail | Tunnel চালু আছে কিনা (`https://<tunnel>/health` খুলে দেখুন), token-সহ URL, OAuth খালি |
| Windows-এ path সমস্যা | `npm run config` Windows-এই চালান — Windows path দেবে |

Log কোথায়: Claude Desktop → `~/Library/Logs/Claude/mcp-server-<নাম>.log`; Claude Code → `claude --debug`; gateway → তার Terminal।

---

## ১২. Update করা

নতুন feature বা fix এলে:
```bash
cd ~/AnalyticsDev-MCP
git pull
npm install
npm run build
```
তারপর AI app restart করুন। Config বদলানোর দরকার নেই (path একই থাকে)।
