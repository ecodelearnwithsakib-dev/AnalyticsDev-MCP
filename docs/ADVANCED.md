# Cross-platform servers

Four servers work *across* the single-platform ones. They start the platform servers as children and call their tools, so every platform's sign-in, agency profile (`MCP_PROFILE`) and read-only policy apply automatically — connect the platforms first, then add these.

| Server | What it does |
|---|---|
| `ads-hub` | Blended reporting in one currency, rules engine, budget pacing |
| `tracking-audit` | Website + GTM + consent + sGTM audit, conversion-gap analysis, Meta CAPI check |
| `conversion-sync` | Closed-won CRM deals → offline conversions in ad platforms |
| `monitor` | Daily anomaly alerts and period reports (Slack, Sheets, files), with schedules |

## ads-hub

| Tool | Use |
|---|---|
| `ads_platforms` | Which ad platforms are connected |
| `ads_report` | Blended spend, conversions, value, CTR, CPC, CPA, ROAS across Meta, Google Ads, Microsoft Ads, OpenAI Ads, Reddit (and LinkedIn, TikTok, Pinterest, Snapchat, X, Amazon when connected) — per-platform split, top campaigns, change vs previous period, and **MER / blended CAC** against GA4, Shopify or WooCommerce revenue |
| `ads_daily` | Day-by-day series per platform and blended |
| `ads_rules` | Rules such as “CPA > 500 BDT and spend ≥ 1,000 → pause”, “ROAS < 1.5 → flag”, “spend > 0 and conversions == 0 → flag”; dry run by default, pauses only with `apply: true` + `confirm: true` |
| `ads_pacing` | Month-to-date spend vs monthly budgets, projected month-end, daily spend needed |

Currency: set `ADS_HUB_CURRENCY` (e.g. `BDT`). Rates come from open.er-api.com; pin them with `FX_RATES="USD:BDT=121,EUR:BDT=131"`.

## tracking-audit

| Tool | Use |
|---|---|
| `audit_site` | Crawls the home page and key funnel pages plus published GTM containers: GTM/Google tag, GA4 and Google Ads IDs, Meta/TikTok/LinkedIn/UET/Pinterest/Snap/X/Reddit pixels, Clarity/Hotjar/HubSpot/Klaviyo, **duplicate tagging** (page code + GTM), **Consent Mode default and v2**, CMP, first-party loader and **sGTM health**, UA leftovers, Custom HTML load — scored 0–100 with prioritized fixes |
| `audit_gtm_workspace` | Through the GTM API: paused tags, tags without triggers, third-party tags without consent checks, duplicate Google tags, UA tags, unused triggers and variables |
| `audit_conversion_gap` | Purchases and revenue per ad platform vs GA4 vs the store in one currency — tracking loss, duplicates, over-attribution |
| `audit_meta_capi` | Browser vs server event volume and which customer-information keys are sent |
| `audit_full` | Everything above in one scored, client-ready fix list |

Static analysis sees what's in the HTML and the published container; tags injected by JavaScript apps or only after consent are reported as such — confirm with Tag Assistant or the stape server's `sgtm_audit_website`.

## conversion-sync

Won deals from **Pipedrive, Salesforce, HighLevel, Zoho CRM, Odoo, HubSpot** → **Google Ads** (offline click conversions / enhanced conversions for leads), **Meta CAPI**, **Microsoft Ads** offline conversions, **Reddit CAPI**, **OpenAI Ads CAPI**, **LinkedIn CAPI**.

1. `sync_setup` — what's connected and which settings each destination needs.
2. `sync_preview` — each deal's identifiers (email, phone, gclid, gbraid/wbraid, msclkid, fbc, rdt_cid, oppref) and, per platform, *will send / already sent / why not*.
3. `sync_run` — test mode by default (Google `validate_only`, Meta test code, Reddit test ID, OpenAI validate-only); `test: false` + `confirm: true` sends for real.
4. `sync_history` — what went where; each deal goes to each platform once (state in `.state/`, per profile).

Click IDs are picked up from any CRM field or contact attribution whose name contains gclid, gbraid, wbraid, msclkid, fbclid/fbc, rdt_cid or oppref. For Salesforce, Zoho and Odoo list custom fields to read in `CONVSYNC_SF_FIELDS`, `CONVSYNC_ZOHO_FIELDS`, `CONVSYNC_ODOO_FIELDS`. Emails and phones are hashed by the destination servers before they leave your machine.

Run it daily with `monitor_schedule`-style launchd/cron, or ask the AI “sync yesterday's won deals”.

## monitor

| Tool | Use |
|---|---|
| `monitor_check` | Yesterday vs the median of the previous 14 days: spend spikes/drops (incl. a platform that stopped), spend with zero conversions, conversion drops, CPA jumps, ROAS drops, GA4 sessions or purchases collapsing; returns a Slack-ready message |
| `monitor_report` | Period report vs previous period: KPIs with change, MER, platform split, best and highest-CPA campaigns, GA4 comparison → Markdown/HTML file, Slack summary, Google Sheets row |
| `monitor_schedule` | Writes a launchd job (plus the cron line) for “daily 09:00” checks or “weekly monday 09:00” reports; prints the one command to activate it |

Command line (used by schedules):

```bash
npm run monitor -- check --slack "#alerts" --only-if-alerts           # prints; add --send to post
npm run monitor -- report --slack "#marketing" --revenue ga4 --save --html --send
```

Agency mode: create one schedule per client with `MCP_PROFILE=acme` so each client's check uses its own accounts and channel.
