# Use these MCP servers with every AI platform

This guide connects the servers in this repo (Meta, Google Ads, GA4, GTM, BigQuery, Stape, Matomo, Looker Studio, Microsoft Ads, OpenAI Ads, Reddit, n8n, ClickUp, Slack, Zoho CRM, Odoo, HighLevel, Pipedrive, Salesforce) to Claude, ChatGPT, Codex, Gemini, Cursor, VS Code Copilot, Windsurf, Zed, JetBrains and more.

## সংক্ষেপে (বাংলায়)

1. একবার setup করুন: `npm install && npm run build`, তারপর `.env`-এ শুধু যেসব platform-এর দরকার সেগুলোর key বসান।
2. আপনার AI app-এর config তৈরি করুন: `npm run config -- <app>`। যেমন `npm run config -- cursor` বা `npm run config -- codex meta,ga4`। এটা আপনার computer-এর আসল path-সহ ready-to-paste config দেখাবে।
3. যে file-এর নাম দেখাবে, সেখানে paste করে app restart করুন।
4. **ChatGPT আর claude.ai (web ও mobile)** শুধু internet URL নেয়। তাদের জন্য gateway চালান (`npm run serve -- ga4,meta`), তারপর একটা HTTPS tunnel দিন (নিচে দেখুন)।
5. এক app-এ একসাথে সব server চালু করবেন না, কারণ অনেক app ৪০ থেকে ১২৮টা tool-এর বেশি নিতে পারে না। যেটা দরকার শুধু সেটা যোগ করুন।
6. Token বা key কখনো chat বা config-এ paste করবেন না। সব secret থাকবে শুধু `.env`-এ।

---

## Which app, which way

| App | Local servers (stdio) | Remote URL | Where | Generate with |
|---|---|---|---|---|
| **Claude Code** (CLI, desktop Code tab, VS Code & JetBrains extensions) | ✅ | ✅ | `claude mcp add` | `npm run config -- claude-code` |
| **Claude Desktop** (Chat, Cowork) | ✅ | ✅ (Connectors) | `claude_desktop_config.json` | `npm run config -- claude-desktop` |
| **claude.ai** web & mobile | — | ✅ | Settings → Connectors | `npm run config -- remote` |
| **ChatGPT** (web, desktop; Plus/Pro/Business/Enterprise/Edu) | — | ✅ | Settings → Apps & Connectors → Developer mode | `npm run config -- remote` |
| **OpenAI Codex** (CLI + IDE extension) | ✅ | ✅ | `~/.codex/config.toml` | `npm run config -- codex` |
| **Gemini CLI** / Gemini Code Assist agent | ✅ | ✅ | `~/.gemini/settings.json` | `npm run config -- gemini` |
| **Cursor** | ✅ | ✅ | `~/.cursor/mcp.json` | `npm run config -- cursor` |
| **VS Code** (GitHub Copilot agent mode) | ✅ | ✅ | user `mcp.json` / `.vscode/mcp.json` | `npm run config -- vscode` |
| **Windsurf** | ✅ | ✅ | `~/.codeium/windsurf/mcp_config.json` | `npm run config -- windsurf` |
| **Zed** | ✅ | ✅ | `settings.json` → `context_servers` | `npm run config -- zed` |
| **Cline** | ✅ | ✅ | `cline_mcp_settings.json` | `npm run config -- cline` |
| **Continue** | ✅ | ✅ | `~/.continue/config.yaml` | `npm run config -- continue` |
| **JetBrains AI Assistant / Junie** | ✅ | ✅ | Settings → Tools → AI Assistant → MCP | `npm run config -- jetbrains` |
| **LM Studio** (local models) | ✅ | ✅ | `~/.lmstudio/mcp.json` | `npm run config -- lmstudio` |
| **Amazon Q Developer** | ✅ | ✅ | `~/.aws/amazonq/mcp.json` | `npm run config -- amazonq` |
| **Kiro** | ✅ | ✅ | `~/.kiro/settings/mcp.json` | `npm run config -- kiro` |
| **Goose** | ✅ | ✅ | `~/.config/goose/config.yaml` | `npm run config -- goose` |
| **opencode** | ✅ | ✅ | `~/.config/opencode/opencode.json` | `npm run config -- opencode` |
| **Open WebUI** (Ollama & others) | — | ✅ | Admin → Settings → External Tools | `npm run config -- remote` |
| **Mistral Le Chat** | — | ✅ | Connectors → Add connector | `npm run config -- remote` |
| **Microsoft Copilot Studio** | — | ✅ | Agent → Tools → Add tool → MCP | `npm run config -- remote` |

`npm run config -- <app> [servers]` prints the exact block with **absolute paths for this machine** (including the full path to Node, so GUI apps that don't load your shell's PATH still start the servers). Add a comma list to limit servers: `npm run config -- cursor meta,ga4,gtm`.

## Before you start

```bash
npm install
npm run build
cp .env.example .env    # fill in only the platforms you use
npm run auth:ga4        # etc. — the one-time sign-ins your platforms need (see README)
```

Every server reads `.env` from the project root itself, so no client config ever contains a secret.

**Keep the tool count small.** Nineteen servers expose ~300 tools. Many clients cap active tools (Cursor warns past ~40, VS Code allows 128 per request) and every tool costs context. Add only the servers you use in each app, or use the gateway's `--allow` filter.

---

## Anthropic

### Claude Code

```bash
npm run config -- claude-code        # prints one `claude mcp add --scope user …` line per server
claude mcp list                      # every server should show ✔ Connected
```

Works in the terminal, the Claude desktop app's Code tab, and the VS Code / JetBrains extensions. For the official remote servers (TikTok, ClickUp, HighLevel, Pipedrive, Zoho), run the `claude mcp add --transport http …` lines from the README, then `/mcp` → *Authenticate* once in an interactive session. Project-only setup: put the same entries in `.mcp.json` at the project root.

### Claude Desktop (Chat / Cowork)

1. `npm run config -- claude-desktop`
2. Claude → Settings → Developer → **Edit Config**, merge the `mcpServers` block, save.
3. Quit Claude completely and reopen; the servers appear under the tools (slider) icon.

Remote/official servers: Settings → **Connectors** → *Add custom connector* → paste the URL (OAuth runs in the browser).

### claude.ai (web and mobile)

claude.ai can't start programs on your computer, so use the [gateway](#remote-only-apps-the-gateway) with a tunnel, then Settings → **Connectors** → *Add custom connector* → URL `https://<tunnel>/<MCP_GATEWAY_TOKEN>/<server>/mcp` (leave OAuth fields empty — the secret path is the credential). Connectors added on the web also appear on mobile. On Team/Enterprise an owner may need to allow custom connectors.

---

## OpenAI

### ChatGPT (web and desktop)

ChatGPT only talks to remote HTTPS MCP servers.

1. Start the [gateway](#remote-only-apps-the-gateway) and a tunnel.
2. ChatGPT → Settings → **Apps & Connectors** → Advanced settings → turn on **Developer mode** (Plus, Pro, Business, Enterprise, Edu; workspace admins may need to allow it).
3. **Create** → name, description, URL `https://<tunnel>/<server>/mcp`, authentication **Token** → paste the value of `MCP_GATEWAY_TOKEN` from `.env` (or use *No authentication* with the secret-path URL).
4. In a chat, choose **Developer mode** in the + menu and enable the connector. Write actions ask for confirmation in ChatGPT as well.

### OpenAI Codex (CLI and IDE extension)

```bash
npm run config -- codex              # TOML for ~/.codex/config.toml, plus `codex mcp add` lines
codex mcp list
```

The CLI and the Codex IDE extension share `~/.codex/config.toml`. Reports and bulk exports can take a while — the generated config sets `tool_timeout_sec = 300`.

---

## Google

### Gemini CLI

```bash
npm run config -- gemini             # JSON for ~/.gemini/settings.json, or `gemini mcp add -s user …` lines
```

Inside Gemini CLI run `/mcp` to see each server and its tools. Gemini Code Assist agent mode in VS Code / JetBrains reads the same `settings.json`.

---

## Editors and IDE agents

### Cursor
`npm run config -- cursor` → Cursor Settings → **MCP** → *Add new global MCP server* (opens `~/.cursor/mcp.json`) → paste → the servers turn green. Use `.cursor/mcp.json` for project-only servers. Toggle servers off in the same panel to stay under the tool limit.

### VS Code (GitHub Copilot)
`npm run config -- vscode` → Command Palette → **MCP: Open User Configuration** → paste the `servers` block (or run the printed `code --add-mcp …` lines). Open Copilot Chat in **Agent** mode and pick the tools with the 🔧 button. Workspace-only: `.vscode/mcp.json`.

### Windsurf
`npm run config -- windsurf` → Settings → Cascade → **MCP Servers** → *View raw config* → merge → **Refresh**.

### Zed
`npm run config -- zed` → merge `context_servers` into Zed's `settings.json`; the Agent panel shows a green dot per running server.

### Cline
`npm run config -- cline` → Cline panel → **MCP Servers** → *Configure MCP Servers* → merge and save. `autoApprove` is empty on purpose — approve write actions yourself.

### Continue
`npm run config -- continue` → add the `mcpServers` list to `~/.continue/config.yaml`; use **Agent** mode.

### JetBrains AI Assistant / Junie
`npm run config -- jetbrains` → Settings → Tools → AI Assistant → **Model Context Protocol (MCP)** → Add → *As JSON* → paste → Apply.

### Kiro · Amazon Q Developer · Goose · opencode
`npm run config -- kiro` / `amazonq` / `goose` / `opencode` prints the block and the file to put it in.

---

## Local and open models

### LM Studio
`npm run config -- lmstudio` → Program tab → **Install → Edit mcp.json** → paste. Pick a model with tool calling (e.g. Qwen 3, Llama 3.x Instruct, Mistral Small); small models struggle with large tool lists — enable one or two servers.

### Ollama via Open WebUI
Open WebUI connects to MCP over HTTP: start the gateway (a tunnel isn't needed if Open WebUI runs on the same machine or network), then Admin Panel → Settings → **External Tools** → add → type **MCP (Streamable HTTP)** → URL `http://<host>:8787/<server>/mcp`, auth **Bearer** with `MCP_GATEWAY_TOKEN`. Other Ollama front-ends that speak MCP over stdio (Goose, Continue, opencode, LM Studio) use the local configs above.

### Mistral Le Chat · Microsoft Copilot Studio
Both add remote MCP servers by URL: Le Chat → **Connectors** → *Add connector* → custom MCP URL; Copilot Studio → your agent → **Tools** → *Add a tool* → *Model Context Protocol* → server URL with API-key or no auth. Use the gateway URLs from `npm run config -- remote`.

---

## Remote-only apps: the gateway

`npm run serve` exposes the servers you choose over Streamable HTTP on **localhost** (port 8787):

```bash
npm run serve -- ga4,meta,gtm
npm run serve -- ga4,meta --allow "ga4_run_*,ga4_list_*,meta_get_insights,meta_list_*"   # read-only style
npm run serve -- pipedrive --deny "*_delete*,pipedrive_api"
```

- Each server lives at `/<server>/mcp` (header `Authorization: Bearer <MCP_GATEWAY_TOKEN>`) and at `/<MCP_GATEWAY_TOKEN>/<server>/mcp` for apps that can't send headers.
- `MCP_GATEWAY_TOKEN` is created in `.env` on first run (48 random hex characters). Rotate it by deleting the line and restarting.
- `GET /health` lists the served servers (no secrets).
- `--allow` / `--deny` take comma-separated tool-name patterns with `*`; denied tools are hidden and refused. `MCP_GATEWAY_ALLOW` / `MCP_GATEWAY_DENY` in `.env` do the same.

### Put HTTPS in front

The gateway deliberately listens on 127.0.0.1. Pick one tunnel:

| Tunnel | Command | Notes |
|---|---|---|
| Cloudflare (quick) | `cloudflared tunnel --url http://localhost:8787` | Free random `*.trycloudflare.com` URL, changes each run |
| Cloudflare (named) | `cloudflared tunnel create mcp` + DNS route | Stable URL on your domain; add Cloudflare Access for extra protection |
| ngrok | `ngrok http 8787` | Stable domain on paid plans |
| Tailscale Funnel | `tailscale funnel 8787` | Stable `*.ts.net` URL |

Use the tunnel's `https://…` address in place of `https://YOUR-TUNNEL` in `npm run config -- remote`.

**Security:** whoever has the URL + token can act on the connected accounts with the powers of your `.env` keys. Serve only the servers you need, prefer `--allow` lists for anything internet-facing, stop the gateway when you're done, and rotate the token if a URL leaks. Tools that send, delete or spend still require `confirm: true`.

---

## Official remote servers (no gateway needed)

These platforms host their own MCP servers with OAuth — add them in any client that supports remote servers (Claude Code, Claude Desktop/claude.ai Connectors, ChatGPT developer mode, Cursor, VS Code, Codex, Gemini CLI…):

| Platform | URL |
|---|---|
| TikTok Ads | `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat` |
| ClickUp | `https://mcp.clickup.com/mcp` |
| HighLevel | `https://services.leadconnectorhq.com/mcp/anthropic/v2` (Claude) · `https://services.leadconnectorhq.com/mcp/openai/v2/` (OpenAI clients) |
| Pipedrive | `https://mcp.pipedrive.ai/mcp` |
| Zoho CRM | four servers — see README |
| Salesforce | Hosted MCP (`https://api.salesforce.com/platform/mcp/v1/platform/…`, needs your External Client App) |
| Stape, Slack, n8n, Matomo | reached through this repo's servers with your `.env` credentials |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node: command not found` / server never starts in a GUI app | Use the generated config — it has the absolute Node path. Re-run `npm run config` after switching Node versions (nvm, Volta). |
| Server shows but tools fail with "Missing environment variable" | Fill that key in `.env` (the path is printed at the top of `npm run config`); restart the app. |
| Changes to `.env` not picked up | Restart the AI app (or `claude mcp` reconnects on the next session). |
| "Too many tools" / the model ignores tools | Enable fewer servers, or serve a filtered set through the gateway. |
| Long reports time out | Raise the client timeout (`tool_timeout_sec` in Codex, `timeout` in Gemini/Cline/Amazon Q). |
| ChatGPT connector saves but never appears | Developer mode must be on and the connector enabled in the chat's + menu; the URL must end in `/mcp`. |
| claude.ai says the connector failed | Check the tunnel is up (`https://<tunnel>/health`), use the secret-path URL and no OAuth. |
| Windows paths | Run `npm run config` on the Windows machine itself; it prints Windows paths and `%APPDATA%` locations. |
| Logs | Claude Desktop: `~/Library/Logs/Claude/mcp-server-<name>.log`; Claude Code: `claude --debug`; gateway: its terminal (every tool call is logged, never the token). |
