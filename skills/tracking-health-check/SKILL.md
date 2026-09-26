---
name: tracking-health-check
description: Full audit of a site's tags, consent, server-side setup and conversion gap, with a prioritised fix list. Uses the AnalyticsDev MCP servers (tracking-audit, gtm, stape, ga4, meta).
---

# Tracking health check

## Inputs

- **site_url** (required) — Site to audit, e.g. https://example.com

Ask for required inputs that the user has not given.

## Servers

Needs these AnalyticsDev MCP servers connected (skip steps whose server is missing and say so): `tracking-audit`, `gtm`, `stape`, `ga4`, `meta`.

## Steps

Run a tracking health check for the user's site (ask for the URL).

1. `audit_full` for the site — tags, duplicates, Consent Mode v2, CMP, sGTM, GTM workspace, conversion gap and Meta CAPI in one pass.
2. If a server-side container is found: `sgtm_healthcheck` on its URL.
3. If the GTM account is connected: `audit_gtm_workspace` for paused tags, missing triggers, tags without consent checks.
4. `audit_conversion_gap` for the last 7 days — purchases per ad platform vs GA4 vs the store.
5. Report: overall score, then Critical / High / Medium / Low findings, each with evidence (where it was seen) and the exact fix (which tag, trigger or setting). Finish with a 30-minute, 1-day and 1-week fix plan.

Do not create or publish GTM changes in this playbook.
