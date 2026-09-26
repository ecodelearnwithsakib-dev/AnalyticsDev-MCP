---
name: client-monthly-report
description: Agency month-end report for one client profile: ads, analytics, SEO, email and CRM in one document. Uses the AnalyticsDev MCP servers (ads-hub, ga4, search-console, klaviyo, mailchimp, hubspot, monitor).
---

# Client monthly report

## Inputs

- **client** — Client name (agency profile)
- **currency** — Report currency

Ask for required inputs that the user has not given.

## Servers

Needs these AnalyticsDev MCP servers connected (skip steps whose server is missing and say so): `ads-hub`, `ga4`, `search-console`, `klaviyo`, `mailchimp`, `hubspot`, `monitor`.

## Steps

Prepare last month's report for this client. (Agency mode: servers must run with MCP_PROFILE set to this client.)

1. `ads_report` preset last_month with MER — and `ads_pacing` for this month's budgets.
2. GA4: `ga4_run_report` sessions, users, conversions and revenue by default channel group, vs the previous month.
3. SEO: `gsc_performance` clicks and impressions by page, top 10 queries.
4. Email, if connected: `klaviyo_performance` (campaigns and flows) or `mailchimp_campaign_report`.
5. CRM, if connected: `hubspot_pipeline_report` (or the connected CRM's report).
6. Write a client-friendly report: highlights, KPIs vs last month and target, what we did, what we learned, next month's plan. Plain language, no internal jargon.
7. Ask before saving or sending (`monitor_report` with save/HTML, Slack, or Sheets).
