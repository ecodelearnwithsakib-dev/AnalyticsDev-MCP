---
name: offline-conversion-setup
description: Connect CRM closed-won deals to Google, Meta, Microsoft, LinkedIn, Reddit and OpenAI Ads as offline conversions, test first. Uses the AnalyticsDev MCP servers (conversion-sync, google-ads, meta, hubspot, pipedrive, salesforce, zoho-crm, odoo, ghl).
---

# Offline conversion setup

## Inputs

- **crm** — hubspot, pipedrive, salesforce, zoho, odoo or ghl

Ask for required inputs that the user has not given.

## Servers

Needs these AnalyticsDev MCP servers connected (skip steps whose server is missing and say so): `conversion-sync`, `google-ads`, `meta`, `hubspot`, `pipedrive`, `salesforce`, `zoho-crm`, `odoo`, `ghl`.

## Steps

Set up offline conversion sync from the user's CRM (ask which).

1. `sync_setup` — which CRMs and ad platforms are connected, and what is missing (conversion action IDs, pixel, rules).
2. Google Ads: `gads_list_conversion_actions` — pick or create an "Offline purchase / Qualified lead" action (type UPLOAD_CLICKS); put its ID in CONVSYNC_GOOGLE_ACTION_ID in .env (the user edits .env, never paste secrets in chat).
3. Make sure click IDs are captured on the CRM record (gclid, fbclid/fbc, msclkid, li_fat_id, rdt_cid, ttclid) — explain the hidden-field / GTM approach if they are missing.
4. `sync_preview` for the last 30 days — deals found, match keys per deal, which platforms each deal can go to.
5. `sync_run` in test mode — validate-only / test codes.
6. Only after the user confirms: `sync_run` with test false and confirm true, then `sync_history`.
7. Offer a daily schedule (monitor_schedule / cron) once it works.
