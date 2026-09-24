# AnalyticsDev MCP servers — Stape · Meta CAPI · GTM

Three small [Model Context Protocol](https://modelcontextprotocol.io) servers for server-side tracking work, usable from Claude Code, Claude Desktop, Cursor or any MCP client.

| Server | Entry | Tools |
|---|---|---|
| **Meta Conversions API** | `dist/meta/index.js` | `meta_send_event`, `meta_get_pixel` |
| **Stape / server-side GTM** | `dist/stape/index.js` | `sgtm_healthcheck`, `sgtm_send_ga4_event`, `stape_api_request` |
| **Google Tag Manager API** | `dist/gtm/index.js` | `gtm_list_accounts`, `gtm_list_containers`, `gtm_list_workspaces`, `gtm_list_tags`, `gtm_list_triggers`, `gtm_list_variables`, `gtm_list_clients`, `gtm_list_templates`, `gtm_get_live_version` |

## Setup

```bash
npm install
npm run build
cp .env.example .env   # fill in only the servers you use
```

Requires Node 20+.

### Credentials

- **Meta** — `META_ACCESS_TOKEN` and `META_PIXEL_ID` from Events Manager → Settings → Conversions API. Email, phone and external_id are SHA-256 hashed before they are sent.
- **Stape / sGTM** — `SGTM_URL` is your tagging server URL. `GA4_MEASUREMENT_ID` + `GA4_API_SECRET` are needed for `sgtm_send_ga4_event`. `STAPE_API_KEY` (Stape → Settings → API key) is needed for `stape_api_request`; set `STAPE_REGION=EU` for EU accounts. API paths: <https://api.app.stape.io/api/doc>.
- **GTM** — create a Google Cloud service account, enable the *Tag Manager API*, add the service-account email as a user in GTM, and point `GOOGLE_APPLICATION_CREDENTIALS` at its JSON key. The server uses the read-only scope.

Never commit `.env` or service-account JSON files — both are in `.gitignore`.

## Use with Claude Code

```bash
claude mcp add --scope user meta-capi \
  -e META_ACCESS_TOKEN=... -e META_PIXEL_ID=... \
  -- node /absolute/path/to/dist/meta/index.js

claude mcp add --scope user stape \
  -e SGTM_URL=https://sgtm.example.com -e STAPE_API_KEY=... \
  -- node /absolute/path/to/dist/stape/index.js

claude mcp add --scope user gtm \
  -e GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json \
  -- node /absolute/path/to/dist/gtm/index.js
```

## Use with Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "meta-capi": {
      "command": "node",
      "args": ["/absolute/path/to/dist/meta/index.js"],
      "env": { "META_ACCESS_TOKEN": "...", "META_PIXEL_ID": "..." }
    },
    "stape": {
      "command": "node",
      "args": ["/absolute/path/to/dist/stape/index.js"],
      "env": { "SGTM_URL": "https://sgtm.example.com", "STAPE_API_KEY": "..." }
    },
    "gtm": {
      "command": "node",
      "args": ["/absolute/path/to/dist/gtm/index.js"],
      "env": { "GOOGLE_APPLICATION_CREDENTIALS": "/absolute/path/to/service-account.json" }
    }
  }
}
```

## Development

```bash
npm run dev:meta        # run from source with tsx
npm run inspect:meta    # open the MCP Inspector against the built server
npm run typecheck
```

Project layout:

```
src/
  shared/   env helpers, JSON fetch, tool-result wrapper, stdio bootstrap
  meta/     Meta Conversions API server
  stape/    Stape + server-side GTM server
  gtm/      Google Tag Manager API v2 server
```

## Example prompts

- "Send a test Purchase event of 1500 BDT to Meta with test code TEST123."
- "Is my sGTM server healthy?"
- "List all tags in the Default Workspace of my server container."
