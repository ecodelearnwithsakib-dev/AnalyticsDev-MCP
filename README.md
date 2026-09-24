# AnalyticsDev MCP servers — Meta · Stape · GTM

Three [Model Context Protocol](https://modelcontextprotocol.io) servers for ads and server-side tracking work, usable from Claude Code, Claude Desktop, Cursor or any MCP client.

| Server | Entry | Tools |
|---|---|---|
| **Meta** (Ads, Pages, Instagram, CAPI, Catalog) | `dist/meta/index.js` | 45 tools — see below |
| **Stape / server-side GTM** | `dist/stape/index.js` | `sgtm_healthcheck`, `sgtm_send_ga4_event`, `stape_api_request` |
| **Google Tag Manager API** | `dist/gtm/index.js` | `gtm_list_accounts`, `gtm_list_containers`, `gtm_list_workspaces`, `gtm_list_tags`, `gtm_list_triggers`, `gtm_list_variables`, `gtm_list_clients`, `gtm_list_templates`, `gtm_get_live_version` |

## Meta server tools

| Area | Tools |
|---|---|
| Anything | `meta_graph_request` (any Graph / Marketing / Instagram endpoint), `meta_whoami`, `meta_list_businesses`, `meta_get_object` |
| Ads | `meta_list_ad_accounts`, `meta_list_campaigns`, `meta_list_adsets`, `meta_list_ads`, `meta_create_campaign`, `meta_create_adset`, `meta_upload_ad_image`, `meta_create_creative`, `meta_create_ad`, `meta_update_object`, `meta_set_status`, `meta_delete_object`, `meta_ad_preview` |
| Reporting & targeting | `meta_get_insights`, `meta_targeting_search`, `meta_delivery_estimate` |
| Audiences | `meta_list_audiences`, `meta_create_custom_audience`, `meta_audience_users`, `meta_create_lookalike` |
| Pixel / CAPI | `meta_send_event`, `meta_list_pixels`, `meta_get_pixel`, `meta_pixel_stats`, `meta_list_custom_conversions`, `meta_create_custom_conversion` |
| Facebook Pages | `meta_list_pages`, `meta_page_post`, `meta_list_page_posts`, `meta_page_insights`, `meta_list_comments`, `meta_manage_comment`, `meta_list_lead_forms`, `meta_get_leads` |
| Instagram | `meta_ig_accounts`, `meta_ig_list_media`, `meta_ig_publish`, `meta_ig_insights` |
| Catalog | `meta_list_catalogs`, `meta_list_products`, `meta_catalog_batch` |

Safety defaults: campaigns, ad sets and ads are created **PAUSED**; `meta_delete_object` requires `confirm: true`; emails/phones are SHA-256 hashed before they leave your machine; Page tokens are derived automatically and never returned.

## Setup

```bash
npm install
npm run build
cp .env.example .env   # fill in only the servers you use
```

Each server loads `.env` from the project root automatically, so MCP clients only need the `node dist/.../index.js` command.

Requires Node 20+.

### Credentials

- **Meta** — use a System User token (Business Settings → Users → System users → Generate token) with the permissions listed in `.env.example`, and assign the system user to your ad account, Pages, pixel and catalog. Set `META_AD_ACCOUNT_ID`, `META_PIXEL_ID` and `META_BUSINESS_ID` as defaults. `META_APP_SECRET` is optional and enables `appsecret_proof`.
- **Stape / sGTM** — `SGTM_URL` is your tagging server URL. `GA4_MEASUREMENT_ID` + `GA4_API_SECRET` are needed for `sgtm_send_ga4_event`. `STAPE_API_KEY` (Stape → Settings → API key) is needed for `stape_api_request`; set `STAPE_REGION=EU` for EU accounts. API paths: <https://api.app.stape.io/api/doc>.
- **GTM** — create a Google Cloud service account, enable the *Tag Manager API*, add the service-account email as a user in GTM, and point `GOOGLE_APPLICATION_CREDENTIALS` at its JSON key. The server uses the read-only scope.

Never commit `.env` or service-account JSON files — both are in `.gitignore`.

## Use with Claude Code

```bash
# secrets come from .env, so no -e flags are needed
claude mcp add --scope user meta -- node /absolute/path/to/dist/meta/index.js

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
    "meta": {
      "command": "node",
      "args": ["/absolute/path/to/dist/meta/index.js"]
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
  meta/     Meta server: client.ts (Graph calls, paging, tokens) + tools/*.ts per area
  stape/    Stape + server-side GTM server
  gtm/      Google Tag Manager API v2 server
```

## Example prompts

- "Show yesterday's spend, ROAS and CPA per campaign."
- "Create a paused Sales campaign with a 500 BDT/day ad set targeting Dhaka, 18–35."
- "Pause every ad set whose CPA was above 300 BDT in the last 7 days."
- "Post this image to my Facebook Page and Instagram with this caption."
- "Download today's leads from my lead form."
- "Send a test Purchase event of 1500 BDT to Meta with test code TEST123."
- "Is my sGTM server healthy?"
- "List all tags in the Default Workspace of my server container."
