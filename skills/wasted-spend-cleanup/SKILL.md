---
name: wasted-spend-cleanup
description: Find campaigns, ad groups and search terms that spend without converting, then propose (not apply) pauses and negatives. Uses the AnalyticsDev MCP servers (ads-hub, google-ads, microsoft-ads, meta).
---

# Wasted spend cleanup

## Inputs

- **period** — default last_30_days
- **max_cpa** — CPA ceiling in report currency

Ask for required inputs that the user has not given.

## Servers

Needs these AnalyticsDev MCP servers connected (skip steps whose server is missing and say so): `ads-hub`, `google-ads`, `microsoft-ads`, `meta`.

## Steps

Find wasted ad spend over the last 30 days.

1. `ads_rules` (dry run) with rules: "spend > 0 and conversions == 0 → flag", "ROAS < 1 and spend ≥ 5% of total → flag".
2. Google Ads: `gads_search` for search terms with cost and zero conversions; Microsoft Ads: `msads_report` search-query report — list candidate negatives.
3. Meta: `meta_get_insights` at ad-set level — ad sets with frequency > 4 and rising CPA.
4. Present one table: item, platform, spend, conversions, CPA, why it looks wasteful, suggested action (pause / negative keyword / budget cut / creative refresh), confidence.
5. Only after the user picks items: apply them one platform at a time (`ads_rules` with apply + confirm, `gads_set_status`, `meta_set_status`…), then confirm what changed.
