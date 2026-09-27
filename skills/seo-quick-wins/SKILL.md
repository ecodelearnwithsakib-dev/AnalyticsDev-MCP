---
name: seo-quick-wins
description: Search Console striking-distance queries, low-CTR pages, cannibalisation and indexing problems with fixes. Uses the Analytics Dev MCP servers (search-console, ga4, clarity).
---

# SEO quick wins

## Inputs

- **site** — Search Console property
- **section** — Optional path filter, e.g. /blog/

Ask for required inputs that the user has not given.

## Servers

Needs these Analytics Dev MCP servers connected (skip steps whose server is missing and say so): `search-console`, `ga4`, `clarity`.

## Steps

Find SEO quick wins for the default Search Console property.

1. `gsc_opportunities` for the last 28 days (exclude brand terms if the user gives them).
2. `gsc_performance` by page vs the previous period — pages losing clicks.
3. `gsc_inspect_url` for the top 10 opportunity pages — indexing or canonical problems.
4. If Clarity is connected: `clarity_friction` — do those pages also have UX problems?
5. Output: a table of the 15 best opportunities with the page, query, position, impressions, CTR, the recommended change (title/meta rewrite, content section, internal links, fix indexing, merge cannibalising pages) and expected effect. Draft new titles/meta descriptions for the top 5.
