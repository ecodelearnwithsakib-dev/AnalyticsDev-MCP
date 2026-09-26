# More platforms: search, ecommerce, social ads, product analytics, email, messaging, workspace

Twenty-two more servers, each built the same way as the rest of the repo: secrets in `.env` (or the Keychain), one server per platform, write actions behind `confirm: true`, and every server works with `MCP_READ_ONLY`, `MCP_ALLOW_TOOLS` / `MCP_DENY_TOOLS` and agency profiles (`MCP_PROFILE`). The ad platforms plug into `ads-hub`, the stores into MER / conversion-gap reports and HubSpot into `conversion-sync`.

| Group | Servers |
|---|---|
| Google | [search-console](#google-search-console) · [merchant-center](#google-merchant-center) · [youtube-analytics](#youtube-analytics) · [google-sheets](#google-sheets) |
| Ads | [linkedin-ads](#linkedin-ads) · [pinterest-ads](#pinterest-ads) · [snapchat-ads](#snapchat-ads) · [x-ads](#x-twitter-ads) · [amazon-ads](#amazon-ads) · [tiktok-business](#tiktok-business-api) |
| Ecommerce | [shopify](#shopify) · [woocommerce](#woocommerce) |
| CRM | [hubspot](#hubspot) |
| Product analytics | [posthog](#posthog) · [mixpanel](#mixpanel) · [amplitude](#amplitude) · [clarity](#microsoft-clarity) |
| Email & messaging | [klaviyo](#klaviyo) · [mailchimp](#mailchimp) · [whatsapp](#whatsapp-business-cloud-api) |
| Workspace | [airtable](#airtable) · [notion](#notion) |

Register any of them with Claude Code:

```bash
claude mcp add --scope user shopify -- node /absolute/path/to/dist/shopify/index.js
npm run config -- cursor shopify,hubspot,klaviyo     # or print a config for any other client
```

---

## Google Search Console

| Tool | Use |
|---|---|
| `gsc_sites` | Properties you can access and your permission level |
| `gsc_performance` | Clicks, impressions, CTR and position by query, page, country, device, date or search appearance, with filters (regex supported) and comparison with the previous period |
| `gsc_opportunities` | Quick wins: striking-distance queries (positions 4–20), high-impression / low-CTR queries (title and meta rewrites), pages losing clicks, and cannibalisation (several of your pages competing for one query) |
| `gsc_inspect_url` | URL Inspection for up to 20 URLs: indexed or not and why, last crawl, Google vs your canonical, mobile usability, rich results |
| `gsc_sitemaps` | List sitemaps with errors and indexed counts, submit one, or delete one (`confirm`) |
| `gsc_api` | Any Search Console API call |

**Setup:** enable *Google Search Console API* in the same Google Cloud project as GA4, then `npm run auth:search-console`. Set `SEARCH_CONSOLE_SITE` (`https://www.example.com/` or `sc-domain:example.com`).

## Google Merchant Center

| Tool | Use |
|---|---|
| `merchant_products` | Products with status per destination (Shopping ads, free listings) and item-level issues |
| `merchant_account_issues` | Account-level issues and suspensions with severity and how to fix |
| `merchant_report` | Merchant Reports (MCQL): product performance (clicks, impressions, CTR, conversions), price competitiveness, best sellers |
| `merchant_update_products` | Insert full products or update some fields (price, sale price, availability, title…) through an API or supplemental data source; deletes need `confirm` |
| `merchant_data_sources` | Feeds / data sources and their last fetch |
| `merchant_api` | Any Merchant API v1 call |

**Setup:** enable *Merchant API*, then `npm run auth:merchant`. Set `MERCHANT_ACCOUNT_ID` (and, for product updates, `MERCHANT_DATA_SOURCE`, `MERCHANT_FEED_LABEL`, `MERCHANT_CURRENCY`).

## YouTube Analytics

| Tool | Use |
|---|---|
| `yt_channel` | Channel totals plus the period’s views, watch time, average view duration, subscribers gained/lost and engagement vs the previous period |
| `yt_top_videos` | Top videos by views, watch time, likes or subscribers gained |
| `yt_report` | Views and watch time by traffic source, search term, country, device, OS, playback location, subscribed status, age × gender or day — for the channel or one video |
| `yt_retention` | Audience retention curve for a video |
| `yt_revenue` | Estimated revenue, ad revenue, RPM, CPM (monetised channels) |
| `yt_api` | Any YouTube Analytics / Data API call |

**Setup:** enable *YouTube Analytics API* and *YouTube Data API v3*, then `npm run auth:youtube`. `YOUTUBE_CHANNEL_ID` is optional.

## Google Sheets

| Tool | Use |
|---|---|
| `sheets_find` | Find spreadsheets by name in Drive |
| `sheets_info` | Tabs, sizes and named ranges |
| `sheets_read` | Read a range (as rows or as objects keyed by the header row) |
| `sheets_append` | Append rows (used by `monitor_report` to log reports) |
| `sheets_write` | Overwrite a range, or clear it (`confirm`; overwriting more than 100 cells also needs `confirm`) |
| `sheets_create` | Create a spreadsheet (tabs and header row), or add a tab to an existing one |
| `sheets_api` | Any Sheets API call (formatting, charts, batchUpdate) |

**Setup:** enable *Google Sheets API* and *Google Drive API*, then `npm run auth:sheets`.

---

## LinkedIn Ads

| Tool | Use |
|---|---|
| `linkedin_accounts` | Ad accounts you can access |
| `linkedin_report` | Spend, impressions, clicks, CTR, CPC, CPM, conversions, value, leads, CPA and ROAS by campaign / group / creative / account — or B2B pivots by company, job function, seniority, industry, country, company size |
| `linkedin_campaigns` | List campaigns and groups, pause/activate, change daily or total budgets |
| `linkedin_conversions` | Conversion rules; send offline conversions via the Conversions API (hashed email, `li_fat_id`) — test first, `confirm` for real sends |
| `linkedin_leads` | Lead Gen Form responses |
| `linkedin_api` | Any Marketing API call (the `LinkedIn-Version` header is set) |

**Setup:** in the LinkedIn developer portal create an app, request the **Advertising API** (and **Conversions API**) product, add redirect `http://localhost:53687/callback`, put the client ID/secret in `.env`, then `npm run auth:linkedin`. Set `LINKEDIN_AD_ACCOUNT_ID`.

## Pinterest Ads

| Tool | Use |
|---|---|
| `pinterest_accounts` | Ad accounts |
| `pinterest_report` | Spend, impressions, clicks, checkouts and checkout value by campaign, total or daily |
| `pinterest_campaigns` | List, pause/activate, change budgets |
| `pinterest_conversions` | Conversions API events with hashed identifiers and dedup `event_id` (test mode first) |
| `pinterest_api` | Any Pinterest API v5 call |

**Setup:** create an app at developers.pinterest.com, redirect `http://localhost:53687/callback`, then `npm run auth:pinterest`. Set `PINTEREST_AD_ACCOUNT_ID`.

## Snapchat Ads

| Tool | Use |
|---|---|
| `snapchat_accounts` | Organisations and ad accounts |
| `snapchat_report` | Spend, impressions, swipes, conversions (purchases, sign-ups) and purchase value by campaign |
| `snapchat_campaigns` | List, pause/activate, change budgets |
| `snapchat_conversions` | Conversions API v3 events (validate endpoint in test mode) |
| `snapchat_api` | Any Snapchat Marketing API call |

**Setup:** Ads Manager → Business Details → OAuth App (redirect `http://localhost:53687/callback`), then `npm run auth:snapchat`. For CAPI set `SNAPCHAT_PIXEL_ID` and `SNAPCHAT_CAPI_TOKEN`.

## X (Twitter) Ads

| Tool | Use |
|---|---|
| `x_accounts` | Ad accounts and funding instruments |
| `x_report` | Spend, impressions, engagements, clicks, conversions by campaign (7-day chunks handled automatically) |
| `x_campaigns` | List, pause/activate, change budgets |
| `x_conversions` | Conversion API events with `twclid` and hashed identifiers |
| `x_api` | Any X Ads API call (OAuth 1.0a signing is handled) |

**Setup:** an X developer app with **Ads API** access; put the consumer key/secret and the user access token/secret in `.env`. Set `X_ADS_ACCOUNT_ID`.

## Amazon Ads

| Tool | Use |
|---|---|
| `amazon_profiles` | Advertising profiles (marketplaces / accounts) |
| `amazon_report` | Sponsored Products, Brands and Display reports: spend, sales, orders, ACOS, ROAS by campaign or day (async reports, polled and unzipped for you) |
| `amazon_campaigns` | List Sponsored Products campaigns, pause/enable/archive, change daily budgets |
| `amazon_keywords` | Keywords of a campaign or ad group (match type, bid, state); update bids or pause keywords |
| `amazon_api` | Any Amazon Ads API call |

**Setup:** a Login with Amazon security profile approved for the Advertising API, allowed return URL `http://localhost:53687/callback`, then `npm run auth:amazon-ads`. Set `AMAZON_ADS_REGION` (NA/EU/FE) and `AMAZON_ADS_PROFILE_ID`.

## TikTok Business API

Complements TikTok's official remote MCP (already in this repo) with the pieces cross-platform servers need.

| Tool | Use |
|---|---|
| `tiktok_events` | Events API: web / offline / CRM events with hashed identifiers, `ttclid` and dedup `event_id`; `test_event_code` first |
| `tiktok_report` | Spend, conversions, purchases, value and ROAS by campaign / ad group / ad, total or daily |
| `tiktok_campaigns` | List, enable/disable, change budgets |
| `tiktok_api` | Any Business API v1.3 call |

**Setup:** a TikTok for Business developer app → long-lived access token. Set `TIKTOK_ADVERTISER_ID` and `TIKTOK_PIXEL_CODE`.

---

## Shopify

| Tool | Use |
|---|---|
| `shopify_shop` | Store currency, time zone, plan |
| `shopify_sales_report` | **True sales**: net revenue after refunds, orders, AOV, discounts, new vs returning, by day, channel, first/last-visit UTM source and top products — the ground truth for MER and conversion-gap checks |
| `shopify_orders` | Search orders (Shopify search syntax) or get one with items and attribution |
| `shopify_products` | Products, variants, SKUs, inventory; update prices or inventory (`confirm`) |
| `shopify_customers` | Customers with order count, spend and marketing consent |
| `shopify_discounts` | Create percentage / fixed discount codes (`confirm`) |
| `shopify_graphql` | Any Admin GraphQL query (mutations need `confirm`) |

**Setup:** Shopify admin → Settings → Apps → *Develop apps* (or the Dev Dashboard) → Admin API scopes `read_orders` (+ `read_all_orders` for data older than 60 days), `read_products`, `write_products`, `read_customers`, `read_inventory`, `write_inventory`, `write_discounts` → install → copy the Admin API access token into `SHOPIFY_ACCESS_TOKEN`. Set `SHOPIFY_STORE`.

## WooCommerce

| Tool | Use |
|---|---|
| `woo_store` | Store currency, WooCommerce/WordPress versions |
| `woo_sales_report` | Revenue after refunds, orders, AOV, by day, payment method, **order attribution** source (WooCommerce 8.5+) and top products |
| `woo_orders` | List/search/get orders; change status or add notes (`confirm`) |
| `woo_products` | Search products; update price, sale price, stock (`confirm`) |
| `woo_customers` | Customers with order count and total spent |
| `woo_api` | Any WooCommerce REST v3 call |

**Setup:** WP admin → WooCommerce → Settings → Advanced → REST API → *Add key* (Read/Write). Set `WOO_URL`, `WOO_CONSUMER_KEY`, `WOO_CONSUMER_SECRET`. The site must use HTTPS.

---

## HubSpot

| Tool | Use |
|---|---|
| `hubspot_account` | Portal, time zone, currency, API usage |
| `hubspot_search` | Search any CRM object with text, filters and sorting |
| `hubspot_records` | Get / create / update / upsert (by email, domain or a unique property) in batches; delete and merge need `confirm`; deal stages by label |
| `hubspot_associations` | List or create/remove associations (contact ↔ deal ↔ company) |
| `hubspot_pipeline_report` | Open pipeline by stage, created/won/lost, win rate, average deal, sales cycle, won revenue by owner and original source |
| `hubspot_won_deals` | Closed-won deals with contact email/phone and ad click IDs — the source `conversion-sync` uses |
| `hubspot_meta` | Owners, properties (with options), pipelines, forms |
| `hubspot_api` | Any HubSpot API call |

**Setup:** HubSpot → Settings → Integrations → *Private apps* → scopes `crm.objects.contacts/companies/deals.read` (+ `.write`), `crm.schemas.*.read`, `forms` → copy the token into `HUBSPOT_ACCESS_TOKEN`. HubSpot's official remote MCP can be connected alongside.

---

## PostHog

| Tool | Use |
|---|---|
| `posthog_projects` | Projects and time zones |
| `posthog_query` | HogQL (SQL) over events, persons, sessions and warehouse tables |
| `posthog_trends` | Counts, unique users and property sums per day/week/month with breakdown |
| `posthog_funnel` | Ordered funnel with conversion per step and breakdown |
| `posthog_web_overview` | Visitors, pageviews, sessions, bounce rate, duration, top pages, referrers, UTM, countries, devices |
| `posthog_persons` | Find a person and their recent events |
| `posthog_flags` | Feature flags; toggle or change rollout (`confirm`) |
| `posthog_api` | Any PostHog API call |

**Setup:** Settings → *Personal API keys* (scopes `query:read`, `project:read`, `person:read`, `feature_flag:read/write`) → `POSTHOG_API_KEY`; set `POSTHOG_HOST` (`https://us.posthog.com`, `https://eu.posthog.com` or self-hosted) and `POSTHOG_PROJECT_ID`.

## Mixpanel

| Tool | Use |
|---|---|
| `mixpanel_events` | Top events |
| `mixpanel_segmentation` | Event counts / uniques over time, segmented and filtered |
| `mixpanel_funnels` | Saved funnels and their conversion |
| `mixpanel_retention` | Cohort retention |
| `mixpanel_insights` | Run a saved Insights report |
| `mixpanel_profiles` | Query user profiles |
| `mixpanel_export` | Raw event export |
| `mixpanel_import` | Server-side events via the Import API (`confirm`) |
| `mixpanel_api` | Any Query or App API call |

**Setup:** Organization settings → *Service accounts* → add one with access to the project → `MIXPANEL_SERVICE_ACCOUNT`, `MIXPANEL_SERVICE_SECRET`, `MIXPANEL_PROJECT_ID`, `MIXPANEL_REGION` (us/eu/in).

## Amplitude

| Tool | Use |
|---|---|
| `amp_events` | Event types with weekly totals |
| `amp_segmentation` | Totals, uniques, averages or property sums over time with group-by |
| `amp_funnel` | Funnel conversion per step |
| `amp_retention` | N-day / rolling retention |
| `amp_users` | Active / new users, revenue LTV |
| `amp_chart` | Results of a saved chart |
| `amp_user` | Look up a user and their event stream |
| `amp_upload` | Server-side events via HTTP V2 (`confirm`) |
| `amp_api` | Any Dashboard REST call |

**Setup:** Project settings → *General* → API key and Secret key → `AMPLITUDE_API_KEY`, `AMPLITUDE_SECRET_KEY`, `AMPLITUDE_REGION` (us/eu).

## Microsoft Clarity

| Tool | Use |
|---|---|
| `clarity_insights` | Sessions, bots, pages per session, scroll depth, engagement time, dead/rage clicks, quick backs, script errors for the last 1–3 days by up to three dimensions (URL, device, source, campaign…) |
| `clarity_friction` | Pages ranked by UX friction (rage clicks and script errors weighted double) |

**Setup:** Clarity project → Settings → *Data Export* → *Generate new API token* → `CLARITY_API_TOKEN`. Clarity allows **10 export calls per project per day**; results are cached for an hour.

---

## Klaviyo

| Tool | Use |
|---|---|
| `klaviyo_account` | Account, currency, time zone |
| `klaviyo_performance` | Campaign or flow performance: recipients, open/click rate, conversions, **attributed revenue**, revenue per recipient, unsubscribes |
| `klaviyo_campaigns` | Email/SMS campaigns and flows with status |
| `klaviyo_metrics` | Metrics list; aggregate any metric over time with grouping |
| `klaviyo_audiences` | Lists and segments with profile counts |
| `klaviyo_profiles` | Find / upsert profiles; subscribe to a list (`confirm`, only with consent) |
| `klaviyo_events` | Server-side events that can trigger flows (`confirm`) |
| `klaviyo_api` | Any Klaviyo API call |

**Setup:** Settings → *API keys* → create a private key → `KLAVIYO_API_KEY`.

## Mailchimp

| Tool | Use |
|---|---|
| `mailchimp_account` | Account and audiences with member counts and rates |
| `mailchimp_campaign_report` | Sent campaigns in a period (opens, clicks, unsubscribes, e-commerce revenue), or one campaign's full report |
| `mailchimp_growth` | Monthly audience growth and top locations |
| `mailchimp_members` | Look up, add/update (double opt-in by default), tag members |
| `mailchimp_send` | Test email, schedule or send a campaign (`confirm`) |
| `mailchimp_api` | Any Marketing API call |

**Setup:** Profile → Extras → *API keys* → `MAILCHIMP_API_KEY` (ends with `-usXX`), and `MAILCHIMP_AUDIENCE_ID`.

## WhatsApp Business (Cloud API)

| Tool | Use |
|---|---|
| `wa_numbers` | Business phone numbers with quality rating and messaging limit |
| `wa_templates` | List templates or submit a new one for review (`confirm`) |
| `wa_send` | Send an approved template (any time, to opted-in users) or free-form text/media (within 24h of the customer's last message) — preview first, `confirm` to send |
| `wa_analytics` | Messages sent/delivered, conversations and pricing by category and country |
| `wa_api` | Any WhatsApp Graph API call |

**Setup:** Meta Business Suite → *System users* → generate a permanent token with `whatsapp_business_messaging` and `whatsapp_business_management` → `WHATSAPP_ACCESS_TOKEN`; the phone number ID and WhatsApp Business Account ID are on your app's *WhatsApp → API Setup* page. Only message people who opted in.

---

## Airtable

| Tool | Use |
|---|---|
| `airtable_bases` | Bases the token can access |
| `airtable_schema` | Tables, fields (with select options) and views |
| `airtable_records` | List/search with formulas, views, sorting, or get one |
| `airtable_write` | Create, update, upsert any number of records (sent 10 at a time with typecast); delete needs `confirm` |
| `airtable_schema_write` | Create tables and fields (`confirm`) |
| `airtable_api` | Any Airtable API call |

**Setup:** airtable.com/create/tokens → scopes `data.records:read/write`, `schema.bases:read/write` → add the bases → `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`.

## Notion

| Tool | Use |
|---|---|
| `notion_search` | Search pages and databases |
| `notion_query` | Query a database with simple or raw filters; rows come back as plain values |
| `notion_page` | Page properties and content as text |
| `notion_write` | Create database rows (plain values mapped to the schema) or pages with markdown content, update properties, append content, archive (`confirm`) |
| `notion_api` | Any Notion API call |

**Setup:** notion.so/profile/integrations → *New internal integration* → `NOTION_TOKEN`, then share each page or database with the integration (••• → Connections).
