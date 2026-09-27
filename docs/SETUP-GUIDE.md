# Analytics Dev MCP — Complete Setup Guide

Step-by-step setup for every Analytics Dev server: what you need, where to click, the one command to run, and how to check it works. Set up **only the platforms you use** — each server is independent.

> New to all this? Do [GETTING-STARTED.md](GETTING-STARTED.md) sections 1–3 first (install Node.js, download and build). This guide starts from a built project.

## Contents

1. [How setup works (read once)](#1-how-setup-works)
2. [Add the servers to Claude](#2-add-the-servers-to-claude)
3. [One Google OAuth client for all Google servers](#3-one-google-oauth-client-for-all-google-servers)
4. [Google servers](#4-google-servers) — GA4 · GTM · Search Console · Merchant Center · YouTube · Sheets · BigQuery · Looker Studio · Google Ads
5. [Ad platforms](#5-ad-platforms) — Meta · Microsoft Ads · OpenAI Ads · LinkedIn · TikTok · Pinterest · Snapchat · X · Amazon · Reddit
6. [Tracking and analytics](#6-tracking-and-analytics) — Stape / sGTM · Matomo · PostHog · Mixpanel · Amplitude · Clarity
7. [Ecommerce](#7-ecommerce) — Shopify · WooCommerce
8. [CRM](#8-crm) — HubSpot · Salesforce · Pipedrive · Zoho CRM · Odoo · HighLevel
9. [Email and messaging](#9-email-and-messaging) — Klaviyo · Mailchimp · WhatsApp · Slack
10. [Work tools](#10-work-tools) — ClickUp · n8n · Airtable · Notion
11. [Cross-platform servers](#11-cross-platform-servers) — Ads Hub · Tracking Audit · Conversion Sync · Monitor
12. [Official remote servers](#12-official-remote-servers)
13. [Check everything](#13-check-everything)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. How setup works

Every server follows the same four steps:

| Step | What you do | Command |
|---|---|---|
| **1. Get credentials** | Create an API key, token or app in the platform (this guide shows where) | — |
| **2. Guided setup** | Answer the questions in the terminal. Secrets are hidden while you type. Values are saved to `.env` on your computer | `npm run setup -- <server>` |
| **3. Sign in** (some platforms) | The setup opens the browser; sign in and click **Allow**. The token is saved automatically | runs inside step 2 |
| **4. Restart Claude** | Quit Claude completely (**Cmd+Q**) and reopen it so the server reads the new values | — |

Useful commands (run them in the project folder):

```bash
npm run setup                    # status: ✓ ready · ◐ partly set · ✗ not set up
npm run setup -- gtm             # set up one server
npm run setup -- shopify hubspot # several in a row
```

Rules that apply to every platform:

- Press **Enter** to keep a value that is already set, or to skip an optional one.
- **Never paste credentials into a chat** with any AI. Type them only into the setup prompt or `.env`.
- Give each key the **smallest permissions** you need. For reporting only, add `MCP_READ_ONLY=true` to `.env`.
- Write actions (spend, send, publish, delete) always ask for confirmation first.

## 2. Add the servers to Claude

**Claude Code** (terminal, VS Code, desktop Code tab):

```bash
npm run config -- claude-code            # prints one "claude mcp add" line per server — run them
npm run config -- claude-code gtm,ga4    # only some servers
claude mcp list                          # every server should say ✔ Connected
```

**Claude Desktop** (Chat / Cowork): run this from the macOS **Terminal** app — not from inside Claude, because it quits and reopens Claude (Claude rewrites its config while it is open):

```bash
npm run claude-desktop               # every server, named "Analytics Dev <Platform>"
npm run claude-desktop -- gtm ga4    # only some
```

Your other MCP servers are kept, and a backup of the config is saved next to it. In a chat, open the tools menu to switch servers on and off — keep only the ones you use turned on.

**Other apps** (Cursor, VS Code, Codex, Gemini CLI, Windsurf, ChatGPT…): see [LLM-PLATFORMS.md](LLM-PLATFORMS.md), or `npm run config -- <app>`.

---

## 3. One Google OAuth client for all Google servers

All Google servers (GA4, GTM, Search Console, Merchant Center, YouTube, Sheets, BigQuery, Looker Studio, Google Ads, and Microsoft Ads when you log in with Google) share **one** OAuth client. Create it once:

1. Open [console.cloud.google.com](https://console.cloud.google.com) → create a project (e.g. *Analytics Dev MCP*) or pick one.
2. **APIs & Services → OAuth consent screen**: user type **External** → app name, your email → Save. Under **Audience / Test users** add every Google account you will sign in with.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → application type **Desktop app** → Create.
4. Keep the **Client ID** and **Client secret** ready. The first Google setup asks for them and saves them as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`; later Google setups reuse them.
5. For each Google server, enable its API in **APIs & Services → Library** (listed in each section below).

When Google shows *"Google hasn't verified this app"*, click **Advanced → Go to <your app>** — it is your own app. While the consent screen is in *Testing*, Google expires sign-ins after 7 days; publish the app (**Publish app**) to keep them longer.

**Alternative:** a service account JSON key (`GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`) added as a user in GA4 / GTM / BigQuery works for servers that support it — useful for servers and agencies.

---

## 4. Google servers

### GA4 — `ga4`
- **Enable APIs:** Google Analytics Admin API, Google Analytics Data API.
- **Run:** `npm run setup -- ga4` → optionally set `GA4_ACCOUNT_ID` and `GA4_PROPERTY_ID` (Admin → Property details) as defaults → sign in.
- **Measurement Protocol (optional, for test events):** GA4 Admin → Data streams → your stream → *Measurement Protocol API secrets* → Create; set `GA4_MEASUREMENT_ID` (G-XXXX) and `GA4_API_SECRET` (asked in the Stape section).
- **Test:** *"GA4: sessions and conversions by channel for the last 7 days."*

### Google Tag Manager — `gtm`
- **Enable API:** Tag Manager API.
- **Run:** `npm run setup -- gtm` → optionally set `GTM_ACCOUNT_ID` and `GTM_CONTAINER_ID` (numeric or `GTM-XXXXXXX`) → sign in with the Google account that has access to the container.
- **Test:** *"GTM: list my accounts and containers."*

### Google Search Console — `search-console`
- **Enable API:** Google Search Console API.
- **Run:** `npm run setup -- search-console` → `SEARCH_CONSOLE_SITE` = `https://www.example.com/` (URL-prefix property) or `sc-domain:example.com` (domain property) → sign in with an account that has access to the property.
- **Test:** *"Search Console: top queries and pages for the last 28 days."*

### Google Merchant Center — `merchant-center`
- **Enable API:** Merchant API.
- **Run:** `npm run setup -- merchant-center` → `MERCHANT_ACCOUNT_ID` (the number in the Merchant Center URL). For product updates also set `MERCHANT_DATA_SOURCE`, `MERCHANT_FEED_LABEL`, `MERCHANT_CURRENCY` → sign in.
- **Test:** *"Merchant Center: disapproved products and account issues."*

### YouTube Analytics — `youtube-analytics`
- **Enable APIs:** YouTube Analytics API, YouTube Data API v3.
- **Run:** `npm run setup -- youtube-analytics` → `YOUTUBE_CHANNEL_ID` is optional (default: your channel) → sign in with the channel's Google account (choose the brand account if asked).
- **Test:** *"YouTube: top videos by watch time this month."*

### Google Sheets — `google-sheets`
- **Enable APIs:** Google Sheets API, Google Drive API.
- **Run:** `npm run setup -- google-sheets` → sign in.
- **Test:** *"Sheets: find my spreadsheets named 'report'."*

### BigQuery — `bigquery`
- **Enable APIs:** BigQuery API (and BigQuery Data Transfer API for scheduled queries). Billing must be enabled on the project.
- **Run:** `npm run setup -- bigquery` → `BIGQUERY_PROJECT_ID`, `BIGQUERY_LOCATION` (e.g. `US`, `EU`, `asia-south1`), `BIGQUERY_MAX_BYTES_BILLED` is a cost safety cap → sign in.
- **Test:** *"BigQuery: list my datasets."*

### Looker Studio — `looker-studio`
- **Report links** need nothing — they work immediately.
- **Search and sharing** need the Looker Studio API, available only to Google Workspace accounts: an admin enables it and authorises your OAuth client ID in Admin console → Security → API controls → Domain-wide delegation with scope `https://www.googleapis.com/auth/datastudio`.
- **Run:** `npm run setup -- looker-studio` → sign in.
- **Test:** *"Looker Studio: create a GA4 report link for property 123456."*

### Google Ads — `google-ads`
- **You need:** a **developer token** from a Google Ads *manager* (MCC) account → Tools → API Center (test access works at once; *Basic access* is needed for real accounts — Google reviews the request).
- **Enable API:** Google Ads API.
- **Run:** `npm run setup -- google-ads` → `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` (10 digits, no dashes), `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (your MCC ID, only if you access the account through it) → sign in.
- **Test:** *"Google Ads: campaign spend, conversions and CPA for the last 7 days."*

---

## 5. Ad platforms

### Meta (Facebook, Instagram, CAPI) — `meta`
1. Business Settings → **Users → System users** → Add (Admin).
2. **Assign assets** to the system user: ad account, Pages, pixel/dataset, catalog.
3. **Generate token** → choose your app → tick: `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_engagement`, `pages_manage_metadata`, `read_insights`, `leads_retrieval`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `catalog_management` → set expiry **Never**.
4. **Run:** `npm run setup -- meta` → `META_ACCESS_TOKEN`, optional `META_APP_SECRET`, defaults `META_AD_ACCOUNT_ID` (`act_…`), `META_PIXEL_ID`, `META_BUSINESS_ID`.
- **Test:** *"Meta: spend and ROAS by campaign yesterday."*

### Microsoft Advertising (Bing) — `microsoft-ads`
1. ads.microsoft.com → **Settings → Developer settings** → *Request token* (Super Admin) → `MSADS_DEVELOPER_TOKEN`.
2. `MSADS_ACCOUNT_ID` = the `aid=` number in the Ads URL.
3. **Run:** `npm run setup -- microsoft-ads`. It asks how you log in:
   - **With Google** → answer *y*; it reuses the shared Google OAuth client.
   - **With a Microsoft account** → first register an app in Entra ID (portal.azure.com → App registrations → *Accounts in any organizational directory and personal Microsoft accounts* → redirect `http://localhost:53683/callback` under *Mobile and desktop*) and give its Application ID as `MSADS_CLIENT_ID`.
- **Test:** *"Microsoft Ads: campaign performance last 14 days."*

### OpenAI Ads (ads in ChatGPT) — `openai-ads`
1. ads.openai.com → **Settings → API keys** → create an Advertiser API key (one key per ad account).
2. For the Conversions API: Pixel ID and CAPI key from the **Conversions** tab.
3. **Run:** `npm run setup -- openai-ads`.
- **Test:** *"OpenAI Ads: spend and conversions by campaign."*

### LinkedIn Ads — `linkedin-ads`
1. [linkedin.com/developers](https://www.linkedin.com/developers/apps) → **Create app** (linked to your Company Page).
2. **Products** tab → request **Advertising API** (and **Conversions API** if needed) — LinkedIn reviews access.
3. **Auth** tab → add redirect URL `http://localhost:53687/callback` → copy Client ID and Client Secret.
4. **Run:** `npm run setup -- linkedin-ads` → client ID/secret, `LINKEDIN_AD_ACCOUNT_ID` → sign in.
- **Test:** *"LinkedIn Ads: spend and leads by campaign last 30 days."*

### TikTok — `tiktok-business` + official `tiktok-ads`
- **Official remote server (`tiktok-ads`)** — campaign management; nothing to configure, sign in with `/mcp` ([section 12](#12-official-remote-servers)).
- **Local `tiktok-business`** — reports, Events API and budgets for the cross-platform servers:
  1. [business-api.tiktok.com](https://business-api.tiktok.com) → become a developer → **My Apps → Create app** → approve for your advertiser account → copy the long-lived **access token**.
  2. Or, for server-side events only: Events Manager → your pixel → **Settings → Generate access token**.
  3. **Run:** `npm run setup -- tiktok-business` → `TIKTOK_ACCESS_TOKEN`, `TIKTOK_ADVERTISER_ID`, `TIKTOK_PIXEL_CODE`.
- **Test:** *"TikTok: spend and conversions by campaign this week."*

### Pinterest Ads — `pinterest-ads`
1. [developers.pinterest.com](https://developers.pinterest.com) → **My apps → Connect app** (request Standard access for ads).
2. Add redirect URI `http://localhost:53687/callback`; copy App ID and secret.
3. **Run:** `npm run setup -- pinterest-ads` → `PINTEREST_AD_ACCOUNT_ID` → sign in.

### Snapchat Ads — `snapchat-ads`
1. Snapchat Ads Manager → **Business Details → OAuth Apps** → create; redirect URI `http://localhost:53687/callback`.
2. For the Conversions API: Events Manager → pixel ID and a CAPI token.
3. **Run:** `npm run setup -- snapchat-ads` → client ID/secret, `SNAPCHAT_AD_ACCOUNT_ID`, optional pixel/CAPI → sign in.

### X (Twitter) Ads — `x-ads`
1. [developer.x.com](https://developer.x.com) → project and app → apply for **Ads API** access.
2. App → **Keys and tokens**: API Key and Secret (consumer), plus **Access Token and Secret** for a user who has access to the ad account (read and write).
3. **Run:** `npm run setup -- x-ads` → the four keys, `X_ADS_ACCOUNT_ID`, `X_ADS_CURRENCY`.

### Amazon Ads — `amazon-ads`
1. Create a **Login with Amazon** security profile ([developer.amazon.com](https://developer.amazon.com) → Login with Amazon), then apply for **Amazon Ads API** access with it.
2. Security profile → **Web settings** → *Allowed return URLs* `http://localhost:53687/callback`.
3. **Run:** `npm run setup -- amazon-ads` → client ID/secret, `AMAZON_ADS_REGION` (`NA`, `EU` or `FE`) → sign in → then ask Claude for your profiles and set `AMAZON_ADS_PROFILE_ID`.
- **Test:** *"Amazon Ads: list my profiles."*

### Reddit (Ads + community) — `reddit`
1. [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) → **create app** → type **web app** → redirect URI `http://localhost:53686/callback`.
2. **Run:** `npm run setup -- reddit` → the id under the app name, the secret, a `REDDIT_USER_AGENT` like `node:analytics-dev:1.0 (by /u/yourname)`, ad account and pixel IDs → sign in (one sign-in covers Ads and community).

---

## 6. Tracking and analytics

### Stape / server-side GTM — `stape`
- **Run:** `npm run setup -- stape` → `SGTM_URL` (your tagging server, e.g. `https://sgtm.example.com`), optional `SGTM_PREVIEW_HEADER` (server container → Preview → ⋮ → *Send requests manually*), `GA4_MEASUREMENT_ID` + `GA4_API_SECRET` for test events, `STAPE_API_KEY` (Stape → Settings → API key) to unlock all official Stape tools, `STAPE_REGION=EU` for EU accounts.
- **Test:** *"Stape: health check of my sGTM server."*

### Matomo — `matomo`
- Administration → **Personal → Security → Create new token** (a view-only user is enough for reports).
- **Run:** `npm run setup -- matomo` → `MATOMO_URL`, `MATOMO_TOKEN`, `MATOMO_SITE_ID`.

### PostHog — `posthog`
- Settings → **Personal API keys** → create with scopes `query:read`, `project:read`, `person:read`, `feature_flag:read/write`, `insight:read`.
- **Run:** `npm run setup -- posthog` → key, `POSTHOG_HOST` (`https://us.posthog.com`, `https://eu.posthog.com` or self-hosted), `POSTHOG_PROJECT_ID` (in the project URL).

### Mixpanel — `mixpanel`
- Organization settings → **Service accounts** → add one with access to the project.
- **Run:** `npm run setup -- mixpanel` → username, secret, `MIXPANEL_PROJECT_ID`, `MIXPANEL_REGION` (`us`, `eu`, `in`).

### Amplitude — `amplitude`
- Project settings → **General** → API key and Secret key.
- **Run:** `npm run setup -- amplitude` → both keys, `AMPLITUDE_REGION` (`us` or `eu`).

### Microsoft Clarity — `clarity`
- Clarity project → **Settings → Data Export → Generate new API token**.
- **Run:** `npm run setup -- clarity`. Clarity allows 10 export calls per day and covers the last 1–3 days.

---

## 7. Ecommerce

### Shopify — `shopify`
1. Shopify admin → **Settings → Apps and sales channels → Develop apps** (or the Dev Dashboard) → *Create an app*.
2. **Configure Admin API scopes:** `read_orders` (+ `read_all_orders` for data older than 60 days), `read_products`, `write_products`, `read_customers`, `read_inventory`, `write_inventory`, `write_discounts`.
3. **Install app** → reveal the **Admin API access token** (`shpat_…`, shown once).
4. **Run:** `npm run setup -- shopify` → `SHOPIFY_STORE` (`your-store.myshopify.com`), `SHOPIFY_ACCESS_TOKEN`.
- **Test:** *"Shopify: net revenue, orders and AOV last month by UTM source."*

### WooCommerce — `woocommerce`
1. WP admin → **WooCommerce → Settings → Advanced → REST API → Add key** → permission **Read/Write** → copy Consumer key and secret.
2. The site must use **HTTPS**, and permalinks must not be *Plain*.
3. **Run:** `npm run setup -- woocommerce` → `WOO_URL`, key, secret.

---

## 8. CRM

### HubSpot — `hubspot`
1. HubSpot → **Settings → Integrations → Private apps** (in newer portals: *Development → Legacy apps*) → Create.
2. Scopes: `crm.objects.contacts/companies/deals.read` (+ `.write`), `crm.schemas.*.read`, `forms`, `account-info.security.read`.
3. **Run:** `npm run setup -- hubspot` → token (`pat-…`), optional `HUBSPOT_CURRENCY`.

### Salesforce — `salesforce`
1. Setup → **External Client App Manager → New External Client App** → enable OAuth, callback `http://localhost:53685/callback`, scopes *Manage user data via APIs (api)* and *Perform requests at any time (refresh_token, offline_access)*, require **PKCE**.
2. Copy Consumer Key and Secret.
3. **Run:** `npm run setup -- salesforce` → key, secret, `SF_LOGIN_URL` (your My Domain, e.g. `https://acme.my.salesforce.com`) → sign in.

### Pipedrive — `pipedrive` (+ official)
- Avatar → **Personal preferences → API** → copy the token.
- **Run:** `npm run setup -- pipedrive` → `PIPEDRIVE_DOMAIN` (the `acme` in `acme.pipedrive.com`), token.

### Zoho CRM — `zoho-crm` (+ official)
1. API console of your data centre (`api-console.zoho.com`, `.eu`, `.in`, `.com.au`…) → **Add Client → Server-based Applications** → homepage `http://localhost`, redirect `http://localhost:53684/callback`.
2. **Run:** `npm run setup -- zoho-crm` → client ID/secret, `ZOHO_DC` (`com`, `eu`, `in`, `com.au`, `jp`, `ca`, `sa`, `com.cn`) → sign in (API domain is filled automatically).

### Odoo — `odoo`
- Avatar → **My Preferences → Account Security → New API Key** (Odoo 19+ keys last at most 3 months — set a reminder to rotate).
- **Run:** `npm run setup -- odoo` → `ODOO_URL`, `ODOO_API_KEY`; `ODOO_DB` only if the server hosts several databases; `ODOO_LOGIN` (your email) only for Odoo 18 and older.

### HighLevel (GoHighLevel) — `ghl` (+ official)
- Sub-account → **Settings → Private Integrations → Create new integration** → tick the scopes you need → copy the token (`pit-…`).
- **Run:** `npm run setup -- ghl` → token, `GHL_LOCATION_ID` (in `app.gohighlevel.com/v2/location/<ID>/`).

---

## 9. Email and messaging

### Klaviyo — `klaviyo`
- **Settings → API keys → Create private API key** (read access, plus write for profiles/events if you need them).
- **Run:** `npm run setup -- klaviyo`.

### Mailchimp — `mailchimp`
- Profile → **Extras → API keys → Create a key** (it ends with `-usXX`).
- **Run:** `npm run setup -- mailchimp` → key, `MAILCHIMP_AUDIENCE_ID` (Audience → Settings → Audience name and defaults).

### WhatsApp Business (Cloud API) — `whatsapp`
1. [business.facebook.com](https://business.facebook.com) → **Users → System users** → generate a permanent token with `whatsapp_business_messaging` and `whatsapp_business_management`.
2. developers.facebook.com → your app → **WhatsApp → API Setup** → Phone number ID and WhatsApp Business Account ID.
3. **Run:** `npm run setup -- whatsapp`. Only message people who opted in.

### Slack — `slack`
1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From a manifest** → paste [`slack-app-manifest.json`](../slack-app-manifest.json) → **Install to Workspace**.
2. **OAuth & Permissions** → copy the **User OAuth Token** (`xoxp-…`); optional Bot token (`xoxb-…`).
3. **Run:** `npm run setup -- slack`.

---

## 10. Work tools

### ClickUp — `clickup` (+ official)
- Avatar → **Settings → Apps → API Token** (`pk_…`).
- **Run:** `npm run setup -- clickup` → token, `CLICKUP_TEAM_ID` if you have several workspaces.

### n8n — `n8n`
- **Settings → n8n API → Create an API key** (not on the free trial). For n8n's own build/test tools: **Settings → Instance-level MCP → Connect → API key**.
- **Run:** `npm run setup -- n8n` → `N8N_URL`, `N8N_API_KEY`, optional `N8N_MCP_TOKEN`.

### Airtable — `airtable`
- [airtable.com/create/tokens](https://airtable.com/create/tokens) → scopes `data.records:read/write`, `schema.bases:read/write` → add the bases.
- **Run:** `npm run setup -- airtable` → token, `AIRTABLE_BASE_ID` (`app…` in the base URL).

### Notion — `notion`
1. [notion.so/profile/integrations](https://www.notion.so/profile/integrations) → **New internal integration** → copy the secret.
2. In Notion, open each page or database → **••• → Connections → add your integration**.
3. **Run:** `npm run setup -- notion`.

---

## 11. Cross-platform servers

`ads-hub`, `tracking-audit`, `conversion-sync` and `monitor` use the platform servers above — set those up first. Their optional settings go straight into `.env` (section *Cross-platform servers*):

- `ADS_HUB_CURRENCY` — report currency, e.g. `BDT`; pin rates with `FX_RATES="USD:BDT=121,EUR:BDT=131"`.
- Conversion Sync: `CONVSYNC_GOOGLE_ACTION_ID`, `CONVSYNC_MSADS_GOAL`, `CONVSYNC_META_EVENT`, `CONVSYNC_LINKEDIN_RULE`, `CONVSYNC_CURRENCY`.

`tracking-audit` needs nothing for website audits — try *"Audit the tracking on example.com."* Details: [ADVANCED.md](ADVANCED.md).

## 12. Official remote servers

These are hosted by the platforms and sign in with OAuth — no keys in `.env`:

| Server | URL |
|---|---|
| TikTok Ads | `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat` |
| ClickUp | `https://mcp.clickup.com/mcp` |
| HighLevel | `https://services.leadconnectorhq.com/mcp/anthropic/v2` |
| Pipedrive | `https://mcp.pipedrive.ai/mcp` |
| Zoho CRM (4 servers) | see the README |

- **Claude Code:** `claude mcp add --scope user --transport http <name> <url>`, then in a terminal run `claude`, type `/mcp`, pick the server → **Authenticate**.
- **Claude Desktop / claude.ai:** Settings → **Connectors → Add custom connector** → paste the URL → sign in.

## 13. Check everything

```bash
npm run setup          # every server you use should show ✓
claude mcp list        # ✔ Connected
```

Then ask Claude one test question per platform (listed in each section). If a tool says *Missing environment variable*, run `npm run setup -- <server>` again and restart Claude.

## 14. Troubleshooting

| Problem | Fix |
|---|---|
| *Missing environment variable X* | `npm run setup -- <server>`, then quit (Cmd+Q) and reopen Claude |
| Server missing in Claude Desktop after editing | Claude rewrote its config while open — run `npm run claude-desktop` from the Terminal app |
| Google: *access_denied* / *app not verified* | Add your account under OAuth consent screen → Test users; click Advanced → Go to app |
| Google: works for a week, then *invalid_grant* | Consent screen is in Testing mode — publish it, then `npm run setup -- <server>` and sign in again |
| Google: *API has not been used in project* | Enable that API in APIs & Services → Library (same project as the OAuth client) |
| Browser sign-in: *redirect_uri mismatch* | The redirect URL in the platform app must match exactly (`http://localhost:5368x/callback` as listed above) |
| *401 / invalid token* | Token expired or revoked — create a new one and run setup again |
| *403 / permission / scope* | Add the missing scope or give the user/system user access to that account |
| Google Ads: *DEVELOPER_TOKEN_NOT_APPROVED* | Apply for Basic access in API Center, or use a test account |
| Too many tools / Claude slow | Turn off unused servers in the chat's tools menu, or add fewer servers |

Still stuck? Open an issue with the error message — never include tokens or `.env` contents.
