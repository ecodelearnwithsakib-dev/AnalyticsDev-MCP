# Privacy Policy

**Analytics Dev MCP** · Effective date: 27 September 2026

This policy explains how Analytics Dev MCP (the "Software") handles data. The Software is open-source, self-hosted software created by Sakib Hossain (Analytics Dev). It is not a hosted service: you install and run it on your own computer, server or container, and you connect your own accounts.

## Summary

- **We do not collect your data.** The Software has no telemetry, analytics, tracking or "phone home" of any kind. Analytics Dev never receives your credentials, your account data or information about how you use the Software.
- **Your data goes only where you send it** — directly from your machine to the platforms you connect (for example Meta, Google, Shopify or HubSpot) and to the AI app you use.
- **Your credentials stay on your machine**, in files or secret stores you control.

## 1. Who is responsible

Because the Software runs under your control, **you (or your organisation) are the controller** of any personal data processed with it. Analytics Dev does not operate the Software on your behalf and does not act as a processor of your data. If you run the Software for clients (for example as an agency), you are responsible to those clients under your own agreements and applicable law.

## 2. Data the Software handles

| Data | Where it comes from | Where it is kept | Where it is sent |
|---|---|---|---|
| **Credentials** (API keys, access and refresh tokens, OAuth client secrets, service-account files) | You enter them, or a sign-in command saves them | `.env` / `.env.<profile>` in the Software's config folder (file mode 600), or the macOS Keychain / 1Password if you choose | Only to the platform they belong to, to authenticate API requests |
| **Account and business data** (campaign metrics, analytics reports, orders, products, CRM records, email and messaging data) | The platform APIs you connect | Not stored by the Software, except where listed below; returned to your AI app as tool results | To your AI app, and to platforms when you ask for a write action |
| **Personal data of your customers** (emails, phone numbers, names, click IDs, order values) — only when you use conversion, audience, CRM, email or messaging tools | Your CRM, store or the request you make | Not stored | Emails, phone numbers and external IDs are **SHA-256 hashed on your machine** before being sent to ad platforms' conversion and audience APIs, as those platforms require. CRM, email and messaging tools send data to those same services as you instruct |
| **Conversion-sync history** | `sync_run` | `.state/conversion-sync*.json`: deal reference, destination, time, value and currency — **no names, emails or phone numbers** | Nowhere |
| **Gateway OAuth records** | Connectors you approve on the gateway | `.state/gateway-oauth.json`: client names, redirect URLs and **SHA-256 hashes** of refresh tokens; access tokens only in memory | Nowhere |
| **Reports and schedules** | `monitor_report`, `monitor_schedule` | `reports/`, `schedules/` (and log files) in the config folder | To Slack or Google Sheets only when you ask and confirm |

You can delete any of these files at any time. Removing the Software and its config folder removes everything it stored.

## 3. Third parties the Software contacts

The Software only connects to:

1. **The platforms you configure** — for example Meta, Google (Ads, Analytics, Tag Manager, Search Console, Merchant Center, YouTube, Sheets, BigQuery, Looker Studio), Microsoft Advertising, OpenAI Ads, LinkedIn, TikTok, Pinterest, Snapchat, X, Amazon Ads, Reddit, Shopify, WooCommerce, HubSpot, Salesforce, Pipedrive, Zoho, Odoo, HighLevel, PostHog, Mixpanel, Amplitude, Microsoft Clarity, Matomo, Klaviyo, Mailchimp, WhatsApp (Meta), Slack, ClickUp, n8n, Airtable, Notion and Stape. Each platform's own privacy policy and terms apply to the data it receives.
2. **open.er-api.com** — for currency exchange rates in cross-platform reports. Only currency codes are requested; no account or personal data is sent. Set `FX_RATES` to avoid this request.
3. **Websites you ask to audit** — the tracking audit downloads public pages and public Google Tag Manager containers (`googletagmanager.com`), identifying itself with the user agent `AnalyticsDev-Audit/1.0`.
4. **Your AI application** (Claude, ChatGPT, Cursor, Gemini and others) — it receives tool results and decides which tools to call. Its provider's privacy policy governs that data.
5. **Optional infrastructure you choose** — tunnel providers (Cloudflare, ngrok, Tailscale) if you expose the HTTP gateway, and GitHub or npm when you download the Software.

## 4. Google user data

The Software's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the **Limited Use** requirements. Google user data is used only to provide the features you request through the Software, is not used for advertising, is not sold, is not used to train generalised AI or machine-learning models by Analytics Dev, and is not read by any person at Analytics Dev. The OAuth scopes requested are listed in `src/shared/google-auth.ts` and are limited to the features of each server.

## 5. Other platform data

Data obtained from Meta, Microsoft, LinkedIn, TikTok, Amazon and other platforms is used only to perform the actions you request, is not sold or shared with anyone else, and is not retained by the Software beyond what is listed in section 2. You remain responsible for following each platform's developer and data-use policies.

## 6. Security

- Secrets are read from local files or OS secret stores and are never included in tool results or logs.
- Write, send, spend and delete actions require explicit confirmation (`confirm: true`); read-only mode and tool allow/deny lists can restrict what an AI app may do.
- The HTTP gateway listens on localhost by default and requires a token or OAuth 2.1 with PKCE.

No software is perfectly secure. Protect your config folder, rotate credentials you suspect are exposed, and see [SECURITY.md](SECURITY.md) to report a vulnerability.

## 7. Your rights and your customers' rights

Analytics Dev holds no personal data about you or your customers through the Software, so there is nothing for us to access, correct or delete. To exercise rights over data held by a connected platform, use that platform's tools. If you process personal data of others with the Software, you are responsible for having a lawful basis (for example consent for marketing messages), honouring data-subject requests and complying with laws such as the GDPR, UK GDPR, CCPA/CPRA and Bangladesh's data-protection rules where they apply.

## 8. Children

The Software is a professional tool and is not directed to children under 16.

## 9. Changes

Changes to this policy are published in this file in the repository, with a new effective date. The commit history shows every earlier version.

## 10. Contact

Questions about this policy: open an issue at [github.com/ecodelearnwithsakib-dev/AnalyticsDev-MCP/issues](https://github.com/ecodelearnwithsakib-dev/AnalyticsDev-MCP/issues). Please do not post credentials or personal data in public issues. For security matters, follow [SECURITY.md](SECURITY.md).
