---
name: weekly-performance-report
description: Blended ads + analytics + store report for a period with wins, problems and next actions. Uses the Analytics Dev MCP servers (ads-hub, ga4, shopify, woocommerce, monitor, slack, google-sheets).
---

# Weekly performance report

## Inputs

- **period** — e.g. last_7_days, last_month (default last_7_days)
- **currency** — Report currency, e.g. BDT, USD
- **revenue_source** — ga4, shopify or woocommerce

Ask for required inputs that the user has not given.

## Servers

Needs these Analytics Dev MCP servers connected (skip steps whose server is missing and say so): `ads-hub`, `ga4`, `shopify`, `woocommerce`, `monitor`, `slack`, `google-sheets`.

## Steps

Build a weekly performance report for the last 7 days.

1. `ads_platforms` — list the connected ad platforms.
2. `ads_report` with preset last_7_days and revenue_source ga4 (or shopify / woocommerce if connected) — blended spend, conversions, CPA, ROAS, MER and the change vs the previous period.
3. `ads_daily` for the same period — spot days with spikes or drops.
4. If a store is connected, `shopify_sales_report` or `woo_sales_report` — real revenue, orders, AOV and top UTM sources; compare with platform-reported conversions.
5. `monitor_check` — anomalies worth flagging.
6. Write the report: a 3-line executive summary, a table per platform (spend, conversions, CPA, ROAS, Δ%), top 5 campaigns, bottom 5 campaigns by CPA, tracking gaps, and 3–5 concrete next actions with the expected impact.
7. Ask before sending anywhere. If asked: `monitor_report` to Slack, or `sheets_append` a KPI row.

Never change budgets or pause anything in this playbook — only recommend.
