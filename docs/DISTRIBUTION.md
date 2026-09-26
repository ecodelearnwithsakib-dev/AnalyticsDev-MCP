# Ways to install and share

Cloning the repo (see [GETTING-STARTED.md](GETTING-STARTED.md)) is still the most flexible way. These options remove steps for other people, teams and servers.

| Option | Best for | Needs |
|---|---|---|
| [npx from GitHub](#npx-no-clone) | Any MCP client, no clone or build | Node 20+ |
| [Claude Desktop Extensions (.mcpb)](#claude-desktop-extensions-mcpb) | Non-technical users on Claude Desktop | Claude Desktop |
| [Docker](#docker) | Servers, VPS, always-on gateway | Docker |
| [Gateway with OAuth](#gateway-with-oauth) | claude.ai, ChatGPT, Le Chat, mobile | A tunnel (cloudflared, ngrok, Tailscale) |
| [Prompts and skills](#playbooks-prompts-and-skills) | Repeatable workflows | Any of the above |
| [MCP Registry](#mcp-registry) | Public listing | Owner's decision — not published |

---

## npx (no clone)

```bash
npx -y github:ecodelearnwithsakib-dev/AnalyticsDev-MCP list        # every server
npx -y github:ecodelearnwithsakib-dev/AnalyticsDev-MCP init        # creates ~/.analyticsdev-mcp/.env
npx -y github:ecodelearnwithsakib-dev/AnalyticsDev-MCP auth ga4    # browser sign-ins work the same way
```

The first run downloads and builds the package (about a minute). Credentials live in **`~/.analyticsdev-mcp/.env`** (or the folder in `MCP_HOME`), never in the npx cache. Agency profiles (`.env.<client>`), `.state/` and reports go there too.

Client configs that use npx instead of local paths:

```bash
npm run config -- cursor ga4,shopify --npx
npm run config -- claude-code hubspot --npx
```

which prints entries such as `"command": "npx", "args": ["-y", "github:ecodelearnwithsakib-dev/AnalyticsDev-MCP", "ga4"]`. Pin a version by adding `#<tag or commit>` after the repo name, e.g. `github:ecodelearnwithsakib-dev/AnalyticsDev-MCP#22b1755`.

## Claude Desktop Extensions (.mcpb)

One-click bundles with a settings form — no Node, terminal or JSON editing for the person installing it.

```bash
npm run build
npm run mcpb                      # every single-platform server → build/mcpb/<server>.mcpb
npm run mcpb -- ga4,shopify       # only these
```

Install: double-click the `.mcpb` file, or Claude Desktop → Settings → Extensions → Advanced settings → Install Extension. Claude Desktop shows a form built from `.env.example`; fields marked secret are stored in the OS keychain. Share a bundle with a teammate and they fill in their own credentials.

Notes:

- Values that normally come from a browser sign-in (`npm run auth:ga4`, `auth:linkedin`…) have to be created once on a computer with the repo, then pasted into the form (e.g. `GA4_OAUTH_REFRESH_TOKEN`). Service-account JSON files can be picked with the file field.
- The cross-platform servers (`ads-hub`, `tracking-audit`, `conversion-sync`, `monitor`) start the other servers, so they aren't bundled — use a local install or npx for them.
- Bundles are ~5 MB each and contain only that server plus the shared code and production dependencies.

## Docker

```bash
docker build -t analyticsdev-mcp .
mkdir -p ~/.analyticsdev-mcp && cp .env ~/.analyticsdev-mcp/.env     # or: docker run … init

# one server over stdio (for MCP clients that can run a command):
docker run -i --rm -v ~/.analyticsdev-mcp:/config analyticsdev-mcp ga4

# always-on HTTP gateway for claude.ai / ChatGPT (put a tunnel or reverse proxy in front):
docker run -d --name mcp-gateway --restart unless-stopped -p 127.0.0.1:8787:8787 \
  -v ~/.analyticsdev-mcp:/config analyticsdev-mcp serve ga4,meta,shopify --host 0.0.0.0 --oauth
```

Client config for the stdio form: `"command": "docker", "args": ["run", "-i", "--rm", "-v", "/Users/you/.analyticsdev-mcp:/config", "analyticsdev-mcp", "ga4"]`.

The image runs as the unprivileged `node` user; `/config` holds `.env`, profiles, `.state/` (conversion-sync history, gateway OAuth clients) and reports. Keep the published port bound to `127.0.0.1` and expose it only through a tunnel or an authenticated reverse proxy. Do browser sign-ins on your computer and copy the resulting `.env` into `/config`.

## Gateway with OAuth

`npm run serve -- <servers> --oauth` (or `analyticsdev-mcp serve … --oauth`, or `MCP_GATEWAY_OAUTH=true`) turns the gateway into an OAuth 2.1 server for connector UIs:

1. Start a tunnel: `cloudflared tunnel --url http://localhost:8787`.
2. Optional: `MCP_GATEWAY_PUBLIC_URL=https://<tunnel>` in `.env` if the tunnel doesn't forward the host.
3. In claude.ai / ChatGPT add a custom connector with URL `https://<tunnel>/<server>/mcp`.
4. The app registers itself, opens the consent page, and you paste `MCP_GATEWAY_TOKEN` (from `.env`) once. Done — it refreshes on its own.

What it implements: protected-resource metadata (RFC 9728) announced in the `401` response, authorization-server metadata (RFC 8414), dynamic client registration (RFC 7591, public clients, https or localhost redirect URIs only), authorization code with **PKCE S256 required**, single-use codes (5 minutes), 1-hour access tokens and 30-day rotating refresh tokens. Only SHA-256 hashes of tokens are stored, in `<config>/.state/gateway-oauth.json`. `--revoke-oauth` signs every connector out; changing `MCP_GATEWAY_TOKEN` stops new approvals.

The bearer-token and secret-path modes keep working alongside OAuth.

## Playbooks: prompts and skills

Eight ready-made workflows that chain tools across servers:

| Playbook | Served as a prompt by | What it does |
|---|---|---|
| `weekly_performance_report` | ads-hub | Blended ads + GA4 + store report with wins, problems, next actions |
| `wasted_spend_cleanup` | ads-hub | Zero-conversion spend, bad search terms, fatigued ad sets → proposed (not applied) fixes |
| `client_monthly_report` | ads-hub | Agency month-end report per client profile |
| `daily_morning_check` | monitor | Anomalies, pacing and store sales in eight bullets |
| `tracking_health_check` | tracking-audit | Full tracking audit with a prioritised fix plan |
| `pre_launch_tracking_qa` | tracking-audit | Pass/fail checklist before a launch |
| `offline_conversion_setup` | conversion-sync | CRM → ad platform offline conversions, test first |
| `seo_quick_wins` | search-console | Striking-distance queries, low CTR, cannibalisation, indexing |

**As MCP prompts:** clients that support prompts list them automatically — in Claude Code type `/` (they appear as `/mcp__ads-hub__weekly_performance_report`), in Claude Desktop use the **+** menu.

**As Agent Skills:** the same playbooks are in [`skills/`](../skills) as `SKILL.md` folders (regenerate with `npm run skills`). Copy a folder to `~/.claude/skills/` for Claude Code, or zip it and upload it under Claude → Settings → Capabilities → Skills. Claude then uses it whenever a request matches its description.

## MCP Registry

[`server.json`](../server.json) is prepared for the official MCP Registry (name `io.github.ecodelearnwithsakib-dev/analyticsdev-mcp`, npm package `analyticsdev-mcp-servers`, `mcpName` set in `package.json`). **Nothing has been published.** Publishing makes the package public on npm and lists it in the registry, so it is the repository owner's decision. When ready:

1. Remove `"private": true` from `package.json`, check `npm pack --dry-run` contains no secrets, then `npm publish` (npm account with 2FA).
2. Install the registry publisher, run `mcp-publisher login github`, then `mcp-publisher publish` from the repo root.
3. After that, clients can use `npx -y analyticsdev-mcp-servers <server>` instead of the GitHub form.
