---
name: daily-morning-check
description: Two-minute morning scan: yesterday vs normal across ads, site and store, only the things that need attention. Uses the Analytics Dev MCP servers (monitor, ads-hub, ga4, shopify).
---

# Daily morning check

## Servers

Needs these Analytics Dev MCP servers connected (skip steps whose server is missing and say so): `monitor`, `ads-hub`, `ga4`, `shopify`.

## Steps

Morning check for yesterday.

1. `monitor_check` — anomalies vs the 14-day median (spend, CPA, conversions, sessions, revenue).
2. `ads_pacing` — anything over- or under-pacing this month.
3. If a store is connected: yesterday's `shopify_sales_report` / `woo_sales_report` vs the same weekday last week.
4. Reply in at most 8 bullet points: only what is unusual, why it may have happened, and what to check first. If nothing is unusual, say so in one line.
