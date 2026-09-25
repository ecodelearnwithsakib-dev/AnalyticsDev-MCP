# AnalyticsDev MCP servers — Meta · Google Ads · Microsoft Ads (Bing) · OpenAI Ads · TikTok Ads · GA4 · Looker Studio · BigQuery · Stape · GTM · n8n · ClickUp · Slack · Matomo

Thirteen [Model Context Protocol](https://modelcontextprotocol.io) servers for ads and server-side tracking work, plus setup for TikTok's and ClickUp's official MCP servers, usable from Claude Code, Claude Desktop, Cursor or any MCP client.

| Server | Entry | Tools |
|---|---|---|
| **Meta** (Ads, Pages, Instagram, CAPI, Catalog) | `dist/meta/index.js` | 45 tools — see below |
| **Google Ads** (reporting, campaign management, Keyword Planner, conversions) | `dist/google-ads/index.js` | 17 tools — see below |
| **Microsoft Advertising / Bing Ads** (reports, campaign management, keyword planner, UET & offline conversions) | `dist/microsoft-ads/index.js` | 14 tools — see below |
| **OpenAI Ads** (ads in ChatGPT: campaigns, insights, audiences, Conversions API, product feeds) | `dist/openai-ads/index.js` | 23 tools — see below |
| **TikTok Ads** (TikTok's official remote MCP) | `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat` | ~400 official tools — see below |
| **Google Analytics 4** (Data + Admin API, Measurement Protocol) | `dist/ga4/index.js` | 35 tools — see below |
| **Matomo** (overview with comparisons, 40+ reports, real-time, segments, goals, sites, Tag Manager) + official Matomo MCP plugin tools | `dist/matomo/index.js` | 13 tools + plugin tools when installed — see below |
| **Looker Studio** (Linking API + Looker Studio API) | `dist/looker-studio/index.js` | 9 tools — see below |
| **BigQuery** (SQL, tables, loads/exports, jobs, scheduled queries) | `dist/bigquery/index.js` | 21 tools — see below |
| **Stape / server-side GTM** (sGTM testing + all official Stape tools) | `dist/stape/index.js` | 5 local + 37 Stape tools — see below |
| **Google Tag Manager** (web + server containers, read/write/publish) | `dist/gtm/index.js` | 28 tools — see below |
| **ClickUp** (tasks, reports, time, goals, views, webhooks, docs, chat, admin) + ClickUp's official MCP | `dist/clickup/index.js` + `https://mcp.clickup.com/mcp` | 18 tools + ~50 official — see below |
| **Slack** (messages, search, channels, people, files, canvases, reminders, digest) + Slack's official MCP tools | `dist/slack/index.js` | 11 tools + official tools when enabled — see below |
| **n8n** (whole public REST API + n8n's native MCP: build, validate, test and run workflows) | `dist/n8n/index.js` | 11 local + ~56 native tools — see below |

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

## Microsoft Advertising (Bing Ads) server tools

| Area | Tools |
|---|---|
| Reporting | `msads_report` (account, campaign, ad group, ad, keyword, search query, geographic, PMax asset group, product, age/gender — summary/daily/weekly/monthly, totals with CTR, CPC, CPA, ROAS), `msads_accounts` (signed-in user + every accessible account) |
| Build | `msads_create_search_campaign` (budget, bid strategy, languages, locations, ad group, keywords and RSA in one call — all PAUSED), `msads_create_ad_group`, `msads_add_keywords` (incl. ad group / campaign negatives), `msads_create_responsive_search_ad` |
| Manage | `msads_list` (campaigns of every type, ad groups, ads, keywords, negatives), `msads_set_status` (activate / pause / delete with confirm), `msads_update_budget_bids` (campaign budgets, ad group and keyword bids) |
| Planning | `msads_keyword_ideas` (monthly volume, competition, suggested bid), `msads_geo_locations` (location IDs by name) |
| Conversions | `msads_conversion_tracking` (UET tags, conversion goals — list and create), `msads_upload_offline_conversions` (MSCLKID + hashed email/phone) |
| Anything | `msads_api_request` (any Bing Ads REST v13 operation across Campaign, Reporting, Customer, Ad Insight and Bulk) |

Uses the REST (JSON) Bing Ads API v13 — Microsoft's go-forward protocol as SOAP is retired in 2027. Partial failures inside a batch are reported per item; throttled calls are retried.

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

## TikTok Ads (official TikTok MCP)

TikTok runs its own Ads MCP server, so this repo connects to it instead of re-implementing the Marketing API. TikTok describes it as covering the full campaign lifecycle — campaign creation, performance insights, creative analysis, audience discovery and budget optimization — and keeps it current; the exact tool list appears in your client after sign-in.

| Endpoint | Tools | Use when |
|---|---|---|
| `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat` | all ~400 tools loaded up front | Claude (TikTok's recommendation) |
| `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer` | ~40 core tools, the rest discovered on demand | clients with small tool limits |

Sign-in is a browser OAuth flow with your normal TikTok for Business account (dynamic client registration + PKCE) — no developer app, app review or `.env` values are needed, and the token is stored by your MCP client, not in this repo. It can only reach the ad accounts that TikTok login can access.

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

## Matomo server tools

| Area | Tools |
|---|---|
| Reports | `matomo_overview` (visits, users, pageviews, bounce, time, conversions, revenue, conversion rate vs previous period; daily/weekly/monthly trend; segments), `matomo_report` (pages, entry/exit pages, titles, downloads, outlinks, site search, channels, websites, search engines, social, campaigns, countries/regions/cities, languages, devices/brands/models, OS, browsers, resolutions, hours, weekdays, engagement, new vs returning, events, goals, ecommerce products/SKUs/categories, abandoned carts, page performance, content — or any method), `matomo_compare` (segments or sites side by side in one bulk request) |
| Live | `matomo_realtime` (last N minutes counters + latest visits with pages, source, device, goals), `matomo_visitor` (full visitor profile by visitor ID or User ID) |
| Admin | `matomo_sites` (list, add, update, tracking code, delete with confirm), `matomo_goals` (URL/title/event/download/outlink/engagement goals, revenue), `matomo_segments` (saved segments and every segmentable dimension), `matomo_annotations`, `matomo_users` (roles, invite, access), `matomo_tag_manager` (containers, draft tags/triggers/variables, create + publish version, embed code, custom dimensions), `matomo_health` |
| Official Matomo MCP (proxied) | tools of the free "MCP Server" plugin (Matomo 5.8+) such as `matomo_report_processed` and `matomo_api_*`, reached at `index.php?module=API&method=McpServer.mcp&format=mcp` with the same token |
| Anything | `matomo_api` (any Reporting API method) |

Works with Matomo On-Premise and Matomo Cloud. The token is always sent in the POST body (Matomo 5 rejects it in URLs by default). Dates default to the last 7 complete days; presets like `last_30_days`, `last_month` or explicit `from`/`to` are accepted.

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

## ClickUp server tools

| Area | Tools |
|---|---|
| Find & report | `clickup_find_tasks` (workspace-wide filters: lists/folders/spaces, statuses, assignees by name/email, tags, due/created/updated/closed dates, custom fields, presets overdue / due_today / due_this_week / my_open_tasks / unassigned — with counts by status, person and list), `clickup_report` (open by status and person, overdue, due next 7 days, unassigned, completed per person) |
| Tasks | `clickup_task` (get, create with markdown, people by name, due "tomorrow", priority, estimate, tags, custom fields by name, subtasks; partial update incl. add/remove assignees; move, multi-list, from template, merge, delete with confirm), `clickup_bulk_tasks` (create many, or apply one change to IDs or a filter, with dry run) |
| Structure | `clickup_workspace` (me, workspaces, full space → folder → list hierarchy, members, groups, roles, task types, plan, seats), `clickup_structure` (create/update/archive/delete spaces, folders and lists, templates), `clickup_custom_fields` (definitions and options; set/clear by name) |
| Collaboration | `clickup_comments` (read, post, reply, assign, resolve), `clickup_checklists`, `clickup_relations` (dependencies, links, task and space tags), `clickup_people` (invite members/guests, roles, guest access, user groups), `clickup_docs` (search, read all pages, create, add/edit pages), `clickup_chat` (channels, messages, send, reply, DMs) |
| Time & goals | `clickup_time` (hours report by person/task/list/tag/day with billable split, entries, start/stop timer, log, edit, time in status), `clickup_goals` (goals and key results with progress) |
| Automation | `clickup_views` (list/create/read view tasks), `clickup_webhooks` (subscribe any event to an n8n/Make URL; secrets hidden in listings) |
| Anything | `clickup_api_request` (any v2 or v3 endpoint) |

ClickUp also runs an official MCP server (`https://mcp.clickup.com/mcp`, OAuth) with ~50 tools for search, tasks, bulk edits, comments, time, docs and chat. Add both: this server covers what the official one doesn't (spaces, goals, webhooks, views, checklists, templates, guests, groups, workspace reports, time reports, deletes) and works with a personal token. Requests are paced to ClickUp's rate limit (100/min on most plans) and retried after 429s.

## Slack server tools

| Area | Tools |
|---|---|
| Messages | `slack_send` (to #channel, @person/email DM or thread; schedule for later; broadcast; Block Kit), `slack_read` (channel/DM/thread over a time window, optional threads, names resolved), `slack_search` (full Slack search syntax: in:, from:, has:, before:/after:, files), `slack_message` (edit, delete with confirm, react, pin, permalink, mark read, scheduled list/cancel) |
| Catch-up | `slack_digest` (mentions of you, activity per channel with top posters and busiest threads, unanswered questions) |
| Workspace | `slack_channels` (list, info, members, create, join/leave, invite/remove, topic/purpose, rename, archive), `slack_people` (find by name/email, profile + presence, set/clear your status, presence, Do Not Disturb), `slack_files` (upload local files to channels/threads, list, delete), `slack_canvases` (create from markdown, channel canvas, append/replace, share, delete), `slack_workspace` (reminders, bookmarks, user groups, emoji, team info) |
| Anything | `slack_api` (any Web API method) |
| Official Slack MCP (proxied) | Slack's own tools from `https://mcp.slack.com/mcp`, using the same user token, once MCP is enabled in your Slack app |

Everything runs as you with a user token from a Slack app you create from [`slack-app-manifest.json`](slack-app-manifest.json) (all scopes pre-filled). Slack's hosted MCP server doesn't support dynamic client registration, so Claude can't connect to it directly; this server reuses your token for it instead. Rate-limited calls wait for `Retry-After`.

## n8n server tools

| Area | Tools |
|---|---|
| Workflows (every workflow, not only MCP-enabled) | `n8n_workflows` (list with triggers/tags/MCP flag, get, export to .json), `n8n_workflow_save` (create, import a .json, partial update — only what changes), `n8n_workflow_action` (publish, unpublish, archive, enable/disable MCP access, tags, move project, duplicate, delete with confirm), `n8n_trigger_webhook` (run through its Webhook trigger, production or test URL) |
| Executions | `n8n_executions` (list with status counts, explain one run node by node — timing, items, errors, sample output — failure digest grouped by workflow + error, retry with latest version, stop, delete) |
| Admin | `n8n_credentials` (list, type schema, create with secrets read from .env, rename, test, transfer, delete), `n8n_data_tables` (tables, columns, query/insert/update/upsert rows, dry-run deletes), `n8n_organize` (tags, variables, projects, members, folders), `n8n_users`, `n8n_instance` (health, security audit, insights, API capabilities, source control status/pull/push) |
| n8n native MCP (proxied when `N8N_MCP_TOKEN` is set) | `search_workflows`, `get_workflow_details`, `search_nodes`, `get_node_types`, `get_workflow_sdk_reference`, `create_workflow_from_code`, `update_workflow`, `validate_workflow`, `validate_node_config`, `prepare_workflow_pin_data`, `test_workflow`, `execute_workflow`, `publish_workflow`, version history/diff/restore, executions, data tables, agents and more |
| Anything | `n8n_api_request` (any public REST API endpoint) |

The native tools come live from your instance's own MCP server (`<N8N_URL>/mcp-server/http`, instance-level MCP must be on), so they follow your n8n version. Native tools can only open, run or edit workflows with MCP access — `n8n_workflow_action … enable_mcp` turns it on for a workflow. Credential secrets are never passed through chat: name the .env variable in `data_from_env`.

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
- **Microsoft Advertising (Bing)** — get a developer token at ads.microsoft.com → Settings → Developer settings (Super Admin, *Request token*), set `MSADS_DEVELOPER_TOKEN` and `MSADS_ACCOUNT_ID` (the `aid` in the Ads URL). Then sign in once: if you log in to Microsoft Ads with Google, run `npm run auth:microsoft-ads-google` (reuses the GA4 OAuth client); otherwise register an Entra app (*Any Entra ID tenant + personal accounts*, redirect `http://localhost:53683/callback` under *Mobile and desktop*), set `MSADS_CLIENT_ID` and run `npm run auth:microsoft-ads`. Set `MSADS_ENVIRONMENT=sandbox` to try it against the Bing Ads sandbox.
- **OpenAI Ads** — you need an ad account at [ads.openai.com](https://ads.openai.com). Create an Advertiser API key under Ads Manager → Settings and set `OPENAI_ADS_API_KEY` (each key is scoped to one ad account). For the Conversions API, set `OPENAI_ADS_PIXEL_ID` and `OPENAI_ADS_CONVERSIONS_API_KEY` (from the Conversions tab, or let `oai_ads_conversion_setup` create the key — it is written to `.env` directly). API partners using a partner key also set `OPENAI_ADS_AD_ACCOUNT_ID`. Some features (Bulk API, Delta Feeds, pixel/CAPI-key creation, segmented insights) are enabled per account by OpenAI.
- **TikTok Ads** — nothing to configure. After adding the server (below), authenticate once: in Claude Code run `/mcp`, pick `tiktok-ads` → *Authenticate*, and sign in with TikTok for Business in the browser.
- **Slack** — at [api.slack.com/apps](https://api.slack.com/apps) choose *Create New App → From a manifest*, pick your workspace and paste [`slack-app-manifest.json`](slack-app-manifest.json); then *Install to Workspace* and copy *OAuth & Permissions → User OAuth Token* (`xoxp-…`) into `SLACK_USER_TOKEN` (optionally the bot token into `SLACK_BOT_TOKEN`). To add Slack's official MCP tools too, open *Agents & AI Apps* in the app and turn on *Model Context Protocol*. Some workspaces require an admin to approve new apps.
- **ClickUp** — create a personal token (avatar → Settings → Apps → API Token) and set `CLICKUP_API_TOKEN`; set `CLICKUP_TEAM_ID` if you belong to several workspaces. For the official server, add it and sign in once with `/mcp` → `clickup-official` → *Authenticate*.
- **n8n** — set `N8N_URL` (your instance root) and `N8N_API_KEY` (Settings → n8n API; not available on the free trial). For the native build/test tools, turn on **Settings → Instance-level MCP**, open *Connect → API key* and put that token in `N8N_MCP_TOKEN`. Alternatively connect the native server on its own with OAuth: `claude mcp add --transport http n8n-native <N8N_URL>/mcp-server/http`, then authenticate with `/mcp`.
- **GA4** — easiest is OAuth as yourself: in Google Cloud enable *Google Analytics Admin API* and *Google Analytics Data API*, create an OAuth client of type *Desktop app*, put its ID/secret in `.env`, then run `npm run auth:ga4`. It opens Google sign-in and writes `GA4_OAUTH_REFRESH_TOKEN` into `.env` for you. Alternatively use a service account (`GOOGLE_APPLICATION_CREDENTIALS`) added as a user in GA4. Set `GA4_ACCOUNT_ID` / `GA4_PROPERTY_ID` as defaults.
- **Matomo** — set `MATOMO_URL`, `MATOMO_SITE_ID` and a personal token in `MATOMO_TOKEN` (Administration → Personal → Security → *Create new token*; a view-only user is enough for reports). Optional: install the free *MCP Server* plugin from the Marketplace (Matomo 5.8+) to add its tools automatically.
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
claude mcp add --scope user microsoft-ads -- node /absolute/path/to/dist/microsoft-ads/index.js
claude mcp add --scope user openai-ads -- node /absolute/path/to/dist/openai-ads/index.js
claude mcp add --scope user --transport http tiktok-ads https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat
claude mcp add --scope user ga4 -- node /absolute/path/to/dist/ga4/index.js
claude mcp add --scope user matomo -- node /absolute/path/to/dist/matomo/index.js
claude mcp add --scope user looker-studio -- node /absolute/path/to/dist/looker-studio/index.js
claude mcp add --scope user bigquery -- node /absolute/path/to/dist/bigquery/index.js

claude mcp add --scope user stape -- node /absolute/path/to/dist/stape/index.js

claude mcp add --scope user gtm -- node /absolute/path/to/dist/gtm/index.js
claude mcp add --scope user n8n -- node /absolute/path/to/dist/n8n/index.js
claude mcp add --scope user clickup -- node /absolute/path/to/dist/clickup/index.js
claude mcp add --scope user --transport http clickup-official https://mcp.clickup.com/mcp
claude mcp add --scope user slack -- node /absolute/path/to/dist/slack/index.js
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
    "microsoft-ads": {
      "command": "node",
      "args": ["/absolute/path/to/dist/microsoft-ads/index.js"]
    },
    "openai-ads": {
      "command": "node",
      "args": ["/absolute/path/to/dist/openai-ads/index.js"]
    },
    "ga4": {
      "command": "node",
      "args": ["/absolute/path/to/dist/ga4/index.js"]
    },
    "matomo": {
      "command": "node",
      "args": ["/absolute/path/to/dist/matomo/index.js"]
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
    },
    "n8n": {
      "command": "node",
      "args": ["/absolute/path/to/dist/n8n/index.js"]
    },
    "clickup": {
      "command": "node",
      "args": ["/absolute/path/to/dist/clickup/index.js"]
    },
    "slack": {
      "command": "node",
      "args": ["/absolute/path/to/dist/slack/index.js"]
    }
  }
}
```

For TikTok and ClickUp's official servers in Claude Desktop, add `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat` and `https://mcp.clickup.com/mcp` as custom connectors (Settings → Connectors); in Cursor use `{ "url": "…" }` entries.

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
  microsoft-ads/ Microsoft Advertising server: client.ts (REST v13, Microsoft/Google sign-in, report unzip + CSV) + signin.ts + tools/*.ts
  openai-ads/ OpenAI Ads server: client.ts (REST, paging, micros, PII hashing) + tools/*.ts
  ga4/      GA4 server: client.ts (Data/Admin calls) + tools/*.ts
  matomo/   Matomo server: client.ts (Reporting API, date presets, comparisons) + tools/*.ts + index.ts (proxy to the MCP Server plugin)
  looker-studio/  Looker Studio server (Linking API URLs + Looker Studio API)
  bigquery/ BigQuery server: client.ts (REST, row decoding, cost helpers) + tools/*.ts
  stape/    Stape + sGTM server: sgtm.ts (local tools) + index.ts (proxy to Stape's official MCP)
  gtm/      GTM server: client.ts (API calls, ID resolution, retries) + tools/*.ts
  n8n/      n8n server: client.ts (public REST API) + tools/*.ts + index.ts (proxy to the instance's native MCP)
  clickup/  ClickUp server: client.ts (v2/v3 REST, rate limits, people/date/custom-field resolution) + tools/*.ts
  slack/    Slack server: client.ts (Web API, name/email/#channel resolution) + tools/*.ts + index.ts (proxy to Slack's official MCP)
slack-app-manifest.json   one-paste Slack app with every scope the Slack server uses
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
- "Bing Ads: search terms from the last 30 days with spend but no conversions — add the worst ones as negatives."
- "Bing Ads: keyword ideas for 'running shoes' in the US, then build a paused Search campaign with the top 15."
- "OpenAI Ads: spend, clicks, conversions and CPA per campaign for the last 14 days, and which ads have serving issues."
- "OpenAI Ads: launch a paused clicks campaign in the US with a $50/day budget, an ad group for 'trail running shoes' and two chat-card ads from these images."
- "OpenAI Ads: send yesterday's orders to the Conversions API (validate only first)."
- "TikTok Ads: spend, CPA and ROAS per campaign for the last 7 days; which ad groups are limited by budget?"
- "TikTok Ads: duplicate my best-performing ad group with a 20% higher budget, paused."
- "GA4: sessions, users and purchase revenue by source/medium for the last 28 days vs the previous 28."
- "GA4: who is on the site right now, by page?"
- "Register payment_type as an event-scoped custom dimension and mark generate_lead as a key event."
- "Validate this purchase event with the Measurement Protocol debug endpoint."
- "Matomo: last 30 days vs the 30 before — visits, conversion rate and revenue — and which channels grew most?"
- "Matomo: compare mobile vs desktop conversion rate this month, and add an annotation for yesterday's campaign launch."
- "Matomo: create a goal for /thank-you with 1500 BDT revenue and show me the tracking code for site 2."
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
- "n8n: which workflows failed in the last 24 hours and why? Explain the latest failed run node by node."
- "n8n: build a workflow that takes a webhook lead, adds it to a data table and posts to Slack — validate and test it before publishing."
- "ClickUp: what's overdue in the Marketing space, grouped by person? Move everything overdue for Rahim to next Monday."
- "ClickUp: create tasks in 'Sprint 12' from this list, assign them to Rahima, due Friday, priority high, Stage = Lead."
- "ClickUp: hours logged per person last week, billable vs non-billable, and a webhook to n8n when a task moves to 'Done'."
- "Slack: catch me up on the last 24 hours — mentions, busiest threads and unanswered questions."
- "Slack: post the weekly report to #marketing tomorrow at 9am and DM Rahima the PDF."
- "Slack: set my status to 'In a client call' with :phone: for 2 hours and snooze notifications."
- "n8n: enable MCP access for 'Lead intake', create a Slack credential from SLACK_BOT_TOKEN in .env, and run a security audit."
