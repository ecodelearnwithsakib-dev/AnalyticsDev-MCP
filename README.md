# AnalyticsDev MCP servers — Meta · Google Ads · OpenAI Ads · GA4 · Looker Studio · BigQuery · Stape · GTM

Eight [Model Context Protocol](https://modelcontextprotocol.io) servers for ads and server-side tracking work, usable from Claude Code, Claude Desktop, Cursor or any MCP client.

| Server | Entry | Tools |
|---|---|---|
| **Meta** (Ads, Pages, Instagram, CAPI, Catalog) | `dist/meta/index.js` | 45 tools — see below |
| **Google Ads** (reporting, campaign management, Keyword Planner, conversions) | `dist/google-ads/index.js` | 17 tools — see below |
| **OpenAI Ads** (ads in ChatGPT: campaigns, insights, audiences, Conversions API, product feeds) | `dist/openai-ads/index.js` | 23 tools — see below |
| **Google Analytics 4** (Data + Admin API, Measurement Protocol) | `dist/ga4/index.js` | 35 tools — see below |
| **Looker Studio** (Linking API + Looker Studio API) | `dist/looker-studio/index.js` | 9 tools — see below |
| **BigQuery** (SQL, tables, loads/exports, jobs, scheduled queries) | `dist/bigquery/index.js` | 21 tools — see below |
| **Stape / server-side GTM** (sGTM testing + all official Stape tools) | `dist/stape/index.js` | 5 local + 37 Stape tools — see below |
| **Google Tag Manager** (web + server containers, read/write/publish) | `dist/gtm/index.js` | 28 tools — see below |

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

## Google Ads server tools

| Area | Tools |
|---|---|
| Reporting | `gads_search` (any GAQL, flat rows, micros → currency), `gads_performance_report` (account/campaign/ad group/ad/keyword/search term/PMax asset group/device/geo with totals, CPA, ROAS), `gads_change_history` |
| Accounts | `gads_list_accounts` (accessible accounts + MCC hierarchy) |
| Build | `gads_create_search_campaign` (budget + bidding + locations + languages, atomic, PAUSED), `gads_create_ad_group`, `gads_add_keywords` (incl. ad group / campaign negatives), `gads_create_responsive_search_ad` |
| Manage | `gads_set_status` (enable/pause/remove anything), `gads_update_budget`, `gads_recommendations` (list/apply/dismiss), `gads_mutate` (any resource via its service or atomic `googleAds:mutate`) |
| Planning | `gads_keyword_ideas` (Keyword Planner volumes, competition, bids), `gads_geo_targets` |
| Conversions | `gads_list_conversion_actions`, `gads_upload_click_conversions` (offline GCLID/GBRAID/WBRAID + enhanced conversions for leads, hashed) |
| Anything | `gads_api_request` (any Google Ads REST endpoint) |

Every write tool accepts `validate_only: true` to dry-run; new campaigns start PAUSED and removals need `confirm_remove`.

## OpenAI Ads (ChatGPT ads) server tools

| Area | Tools |
|---|---|
| Reporting | `oai_ads_insights` (impressions, clicks, spend, CTR, CPC, CPM by campaign/ad group/ad, per day/month/hour, by country/device/platform/product, plus conversions, CPA and totals), `oai_ads_conversion_insights` (click- and view-through conversions) |
| Build | `oai_ads_launch` (campaign + ad group + ads in one call, all paused), `oai_ads_create_campaign` (objective, daily/lifetime budget, schedule, countries/regions/markets, platforms, audiences, conversion goal, UTM template), `oai_ads_create_ad_group` (context hints, fixed bid or Maximize Results, audience bid multipliers, product sets), `oai_ads_create_ad` (chat card / product template, image auto-upload), `oai_ads_upload`, `oai_ads_preview_ad` |
| Manage | `oai_ads_list`, `oai_ads_get` (review status, serving issues, bid_too_low), `oai_ads_update` (budgets, bids, targeting, creative), `oai_ads_set_status` (activate/pause/archive), `oai_ads_bulk` (Bulk API, up to 1,000 operations) |
| Account | `oai_ads_account` (currency, timezone, review, brand, activate/pause), `oai_ads_spend_limits` (daily or date-range account caps), `oai_ads_geo_lookup` |
| Audiences | `oai_ads_audiences` (list/create/merge/archive; emails and phones hashed locally), `oai_ads_audience_members` (add/remove inline or CSV, replace from CSV, operation status) |
| Conversions | `oai_ads_conversion_setup` (pixels, event settings, Conversions API key saved to `.env`, live Pixel event stream), `oai_ads_send_conversions` (server-side events with hashed user data, `validate_only`) |
| Catalog | `oai_ads_product_feeds` (feeds, uploads, product queries, SFTP status), `oai_ads_update_products` (Delta Feeds: price/stock/title) |
| Anything | `oai_ads_api_request` (any Ads API endpoint; secrets in responses are masked) |

Budgets and bids are entered in the account's currency and converted to micros. Everything is created **paused**, archive needs `confirm_archive`, and create calls send an `Idempotency-Key` so retries can't duplicate. Rate-limited calls (429) are retried automatically.

## GA4 server tools

| Area | Tools |
|---|---|
| Anything | `ga4_api_request` (any Data / Admin API endpoint, v1beta or v1alpha), `ga4_admin_get`, `ga4_admin_update`, `ga4_admin_delete` |
| Reports | `ga4_run_report` (flat rows, simple filters, comparisons, totals), `ga4_run_realtime_report`, `ga4_run_pivot_report`, `ga4_batch_run_reports`, `ga4_run_funnel_report`, `ga4_get_metadata`, `ga4_check_compatibility` |
| Accounts & properties | `ga4_list_account_summaries`, `ga4_list_properties`, `ga4_get_property`, `ga4_create_property`, `ga4_set_data_retention` |
| Streams & MP | `ga4_list_data_streams`, `ga4_create_web_stream`, `ga4_list_mp_secrets`, `ga4_create_mp_secret`, `ga4_mp_send_event` (with debug validation) |
| Events & definitions | `ga4_list_key_events`, `ga4_create_key_event`, `ga4_list_custom_definitions`, `ga4_create_custom_dimension`, `ga4_create_custom_metric`, `ga4_archive_custom_definition` |
| Audiences & links | `ga4_list_audiences`, `ga4_create_audience`, `ga4_list_links`, `ga4_create_google_ads_link` |
| Access & audit | `ga4_list_users`, `ga4_add_user`, `ga4_change_history`, `ga4_run_access_report` |

## Looker Studio server tools

| Area | Tools | Works for |
|---|---|---|
| Create reports (Linking API) | `looker_studio_create_report_link` (any template + GA4, BigQuery, Sheets, Search Console, Looker, Cloud Storage, Spanner, community connectors), `looker_studio_ga4_report_link` | Any Google account |
| Find & share (Looker Studio API) | `looker_studio_search_assets`, `looker_studio_get_permissions`, `looker_studio_share`, `looker_studio_revoke_access`, `looker_studio_link_sharing`, `looker_studio_set_permissions`, `looker_studio_api_status` | Google Workspace / Cloud Identity with admin-approved API access |

Google offers no API to edit charts or pages inside a report; build a template report once, then use the link tools to clone it onto any data source.

## BigQuery server tools

| Area | Tools |
|---|---|
| Query | `bq_query` (GoogleSQL incl. DML/DDL/scripts, named params, dry run with cost estimate, bytes-billed safety cap, rows returned as JSON objects), `bq_get_query_results` |
| Browse | `bq_list_projects`, `bq_list` (datasets, tables/views, routines, models), `bq_get` (schema, size, partitioning, view SQL), `bq_preview_table` (free row preview) |
| Manage | `bq_create_dataset`, `bq_create_table` (schema, partitioning, clustering, views, materialized views), `bq_update`, `bq_delete` |
| Move data | `bq_insert_rows` (streaming), `bq_load_from_gcs`, `bq_export_to_gcs`, `bq_copy_table` |
| Jobs & schedules | `bq_list_jobs`, `bq_get_job`, `bq_cancel_job`, `bq_list_scheduled_queries`, `bq_create_scheduled_query`, `bq_run_scheduled_query_now` |
| Anything | `bq_api_request` (any BigQuery REST v2 endpoint) |

Every query is capped at `BIGQUERY_MAX_BYTES_BILLED` (default 10 GiB) unless a higher `max_bytes_billed` is passed; run with `dry_run: true` to see the bytes and approximate on-demand cost first. GA4 export tables live at `project.analytics_<PROPERTY_ID>.events_*`.

## Stape / server-side GTM tools

| Area | Tools |
|---|---|
| sGTM testing (local) | `sgtm_healthcheck`, `sgtm_send_request` (any request to the tagging server: Data Client `/data`, `/g/collect`, custom loader, webhooks; shows status, cookies set, CORS), `sgtm_send_ga4_event`, `sgtm_audit_website` (GTM/GA4/Ads IDs, first-party or Stape custom loader incl. hidden base64 IDs, `server_container_url`, Meta pixel, tagging-server health and `gtm.js` serving) |
| Stape account (official Stape MCP, proxied) | `stape_container_crud`, `stape_container_lifecycle`, `stape_container_domains`, `stape_container_power_ups`, `stape_container_schedules`, `stape_container_proxy_files`, `stape_container_connections`, `stape_container_resources`, `stape_container_monitoring`, `stape_container_monitoring_logs`, `stape_container_logs`, `stape_container_analytics`, `stape_container_statistics`, `stape_account`, `stape_users`, `stape_user_api_keys`, `stape_company`, `stape_share_access`, `stape_billing`, `stape_invoices`, `stape_subscriptions`, `stape_score_report`, reference data and more |
| Anything | `stape_api_request` (any Stape REST endpoint) |

The `stape_*` tools come live from Stape's official MCP server (`https://mcp.stape.ai/mcp`), authenticated with `STAPE_API_KEY` from `.env`, so they stay current as Stape adds features. Set `SGTM_PREVIEW_HEADER` to make every test hit show up in sGTM Preview. GTM server-container configuration (clients, tags, publishing) lives in the GTM server.

## GTM server tools

| Area | Tools |
|---|---|
| Anything | `gtm_api_request` (any Tag Manager API v2 endpoint), `gtm_list` (accounts, containers, user permissions, workspaces, environments, versions, destinations, tags, triggers, variables, built-in variables, folders, templates, clients, zones, transformations, Google tag config), `gtm_get`, `gtm_create`, `gtm_update` (fingerprint-safe merge), `gtm_delete`, `gtm_revert` |
| Quick builders | `gtm_add_google_tag`, `gtm_add_ga4_event_tag`, `gtm_add_custom_html_tag`, `gtm_add_trigger` (page view, custom event, clicks, forms, scroll, visibility, timer, …), `gtm_add_variable` (data layer, constant, JS, custom JS, cookie, URL query, DOM element), `gtm_add_folder` |
| Workspaces & publishing | `gtm_create_workspace`, `gtm_workspace_status`, `gtm_sync_workspace`, `gtm_quick_preview`, `gtm_create_version` (optionally publish), `gtm_publish_version` (also rollback), `gtm_get_version` (live/any version export) |
| Containers & admin | `gtm_lookup_container` (by GTM-/G-/AW- ID), `gtm_create_container`, `gtm_container_snippet`, `gtm_set_builtin_variables`, `gtm_import_gallery_template`, `gtm_move_to_folder`, `gtm_create_environment`, `gtm_grant_access` |

Containers can be referenced by public ID (`GTM-XXXXXXX`); the workspace defaults to *Default Workspace*. Calls retry automatically on the API's rate limit.

Safety defaults (Meta): campaigns, ad sets and ads are created **PAUSED**; `meta_delete_object` requires `confirm: true`; emails/phones are SHA-256 hashed before they leave your machine; Page tokens are derived automatically and never returned.

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
- **Google Ads** — get a developer token from a manager account (Tools → API Center; test-account access works immediately, Basic access is needed for live accounts), enable the *Google Ads API* in the same Google Cloud project as your OAuth client, set `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` and (if you go through an MCC) `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, then run `npm run auth:google-ads`.
- **OpenAI Ads** — you need an ad account at [ads.openai.com](https://ads.openai.com). Create an Advertiser API key under Ads Manager → Settings and set `OPENAI_ADS_API_KEY` (each key is scoped to one ad account). For the Conversions API, set `OPENAI_ADS_PIXEL_ID` and `OPENAI_ADS_CONVERSIONS_API_KEY` (from the Conversions tab, or let `oai_ads_conversion_setup` create the key — it is written to `.env` directly). API partners using a partner key also set `OPENAI_ADS_AD_ACCOUNT_ID`. Some features (Bulk API, Delta Feeds, pixel/CAPI-key creation, segmented insights) are enabled per account by OpenAI.
- **GA4** — easiest is OAuth as yourself: in Google Cloud enable *Google Analytics Admin API* and *Google Analytics Data API*, create an OAuth client of type *Desktop app*, put its ID/secret in `.env`, then run `npm run auth:ga4`. It opens Google sign-in and writes `GA4_OAUTH_REFRESH_TOKEN` into `.env` for you. Alternatively use a service account (`GOOGLE_APPLICATION_CREDENTIALS`) added as a user in GA4. Set `GA4_ACCOUNT_ID` / `GA4_PROPERTY_ID` as defaults.
- **Looker Studio** — link tools need no credentials. For search/sharing, a Workspace admin must enable the *Looker Studio API* and authorize your OAuth client ID with scope `https://www.googleapis.com/auth/datastudio` under Admin console → Security → API controls → Domain-wide delegation; then run `npm run auth:looker-studio` (it reuses the GA4 OAuth client unless `LOOKER_STUDIO_OAUTH_CLIENT_ID` is set). A service account with `LOOKER_STUDIO_IMPERSONATE_USER` also works.
- **Stape / sGTM** — `SGTM_URL` is your tagging server URL. `STAPE_API_KEY` (Stape → Settings → API key) unlocks the official `stape_*` tools and `stape_api_request`; set `STAPE_REGION=EU` for EU accounts. `GA4_MEASUREMENT_ID` + `GA4_API_SECRET` are needed for `sgtm_send_ga4_event`; `SGTM_PREVIEW_HEADER` is optional.
- **BigQuery** — enable the *BigQuery API* (and *BigQuery Data Transfer API* for scheduled queries) in the same Google Cloud project as your OAuth client, set `BIGQUERY_PROJECT_ID`, then run `npm run auth:bigquery`. A service account with BigQuery roles via `GOOGLE_APPLICATION_CREDENTIALS`, or `gcloud auth application-default login`, also works.
- **GTM** — enable the *Tag Manager API* in the same Google Cloud project as your OAuth client and run `npm run auth:gtm` (reuses the GA4 OAuth client unless `GTM_OAUTH_CLIENT_ID` is set). Set `GTM_ACCOUNT_ID` and `GTM_CONTAINER_ID` (numeric or `GTM-XXXXXXX`) as defaults. A service account added as a GTM user via `GOOGLE_APPLICATION_CREDENTIALS` also works.

Never commit `.env` or service-account JSON files — both are in `.gitignore`.

## Use with Claude Code

```bash
# secrets come from .env, so no -e flags are needed
claude mcp add --scope user meta -- node /absolute/path/to/dist/meta/index.js
claude mcp add --scope user google-ads -- node /absolute/path/to/dist/google-ads/index.js
claude mcp add --scope user openai-ads -- node /absolute/path/to/dist/openai-ads/index.js
claude mcp add --scope user ga4 -- node /absolute/path/to/dist/ga4/index.js
claude mcp add --scope user looker-studio -- node /absolute/path/to/dist/looker-studio/index.js
claude mcp add --scope user bigquery -- node /absolute/path/to/dist/bigquery/index.js

claude mcp add --scope user stape -- node /absolute/path/to/dist/stape/index.js

claude mcp add --scope user gtm -- node /absolute/path/to/dist/gtm/index.js
```

## Use with Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "meta": {
      "command": "node",
      "args": ["/absolute/path/to/dist/meta/index.js"]
    },
    "google-ads": {
      "command": "node",
      "args": ["/absolute/path/to/dist/google-ads/index.js"]
    },
    "openai-ads": {
      "command": "node",
      "args": ["/absolute/path/to/dist/openai-ads/index.js"]
    },
    "ga4": {
      "command": "node",
      "args": ["/absolute/path/to/dist/ga4/index.js"]
    },
    "looker-studio": {
      "command": "node",
      "args": ["/absolute/path/to/dist/looker-studio/index.js"]
    },
    "bigquery": {
      "command": "node",
      "args": ["/absolute/path/to/dist/bigquery/index.js"]
    },
    "stape": {
      "command": "node",
      "args": ["/absolute/path/to/dist/stape/index.js"]
    },
    "gtm": {
      "command": "node",
      "args": ["/absolute/path/to/dist/gtm/index.js"]
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
  shared/   env helpers, JSON fetch, tool-result wrapper, stdio bootstrap,
            google-auth.ts (Google OAuth/service-account profiles), google-signin.ts (npm run auth:*)
  meta/     Meta server: client.ts (Graph calls, paging, tokens) + tools/*.ts per area
  google-ads/ Google Ads server: client.ts (REST, GAQL, micros) + tools/*.ts
  openai-ads/ OpenAI Ads server: client.ts (REST, paging, micros, PII hashing) + tools/*.ts
  ga4/      GA4 server: client.ts (Data/Admin calls) + tools/*.ts
  looker-studio/  Looker Studio server (Linking API URLs + Looker Studio API)
  bigquery/ BigQuery server: client.ts (REST, row decoding, cost helpers) + tools/*.ts
  stape/    Stape + sGTM server: sgtm.ts (local tools) + index.ts (proxy to Stape's official MCP)
  gtm/      GTM server: client.ts (API calls, ID resolution, retries) + tools/*.ts
```

## Example prompts

- "Show yesterday's spend, ROAS and CPA per campaign."
- "Create a paused Sales campaign with a 500 BDT/day ad set targeting Dhaka, 18–35."
- "Pause every ad set whose CPA was above 300 BDT in the last 7 days."
- "Post this image to my Facebook Page and Instagram with this caption."
- "Download today's leads from my lead form."
- "Send a test Purchase event of 1500 BDT to Meta with test code TEST123."
- "Google Ads: campaign performance last 30 days with CPA and ROAS; pause anything with CPA above 500 BDT."
- "Google Ads: keyword ideas for 'running shoes' in Bangladesh, then build a paused Search campaign with the top 20 as phrase match."
- "Google Ads: upload yesterday's offline sales (GCLID + value) to the 'Offline purchase' conversion action."
- "OpenAI Ads: spend, clicks, conversions and CPA per campaign for the last 14 days, and which ads have serving issues."
- "OpenAI Ads: launch a paused clicks campaign in the US with a $50/day budget, an ad group for 'trail running shoes' and two chat-card ads from these images."
- "OpenAI Ads: send yesterday's orders to the Conversions API (validate only first)."
- "GA4: sessions, users and purchase revenue by source/medium for the last 28 days vs the previous 28."
- "GA4: who is on the site right now, by page?"
- "Register payment_type as an event-scoped custom dimension and mark generate_lead as a key event."
- "Validate this purchase event with the Measurement Protocol debug endpoint."
- "Make a Looker Studio report from my template on GA4 property 123456789."
- "Share the 'Monthly SEO' report with client@example.com as viewer and turn off link sharing."
- "BigQuery: from my GA4 export, purchases and revenue by source/medium for the last 7 days — dry run first."
- "BigQuery: create a daily scheduled query that writes yesterday's GA4 purchases to reports.daily_purchases."
- "Is my sGTM server healthy?"
- "Audit example.com: is GTM loaded first-party through Stape's custom loader, and does the tagging server serve gtm.js?"
- "Send a test purchase to /data on my sGTM with the preview header, then show the last Stape logs for that container."
- "List my Stape containers and which power-ups are enabled on each."
- "GTM: add a GA4 purchase event tag with value/currency from the dataLayer, firing on a custom event 'purchase', then preview."
- "GTM: which tags changed in the Default Workspace? Create a version called 'Purchase tracking' and publish it."
- "GTM: roll back GTM-XXXXXXX to the previous version."
- "List all tags in the Default Workspace of my server container."
