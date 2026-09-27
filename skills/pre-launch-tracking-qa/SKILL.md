---
name: pre-launch-tracking-qa
description: Checklist before launching a campaign or new site: events fire once, values and IDs are right, consent works. Uses the Analytics Dev MCP servers (tracking-audit, gtm, ga4, meta, stape).
---

# Pre-launch tracking QA

## Inputs

- **site_url** (required) — Site or landing page
- **conversion** — Key conversion, e.g. purchase, generate_lead

Ask for required inputs that the user has not given.

## Servers

Needs these Analytics Dev MCP servers connected (skip steps whose server is missing and say so): `tracking-audit`, `gtm`, `ga4`, `meta`, `stape`.

## Steps

QA tracking on the landing page (ask for the URL) before launch; key conversion: purchase / lead (ask which).

1. `audit_site` on the URL and the checkout / thank-you page — every tag present exactly once.
2. `gtm_quick_preview` or the GTM workspace status — unpublished changes that the launch depends on.
3. `ga4_run_realtime_report` while the user places a test conversion — the event arrives once with value and currency.
4. `meta_pixel_stats` / `audit_meta_capi` — browser and server events deduplicate (same event_id), match keys present.
5. If sGTM is used: `sgtm_send_ga4_event` test event and `sgtm_healthcheck`.
6. Output a pass/fail checklist with what to fix before launch.
