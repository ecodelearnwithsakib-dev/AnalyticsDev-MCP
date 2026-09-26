import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Playbooks: step-by-step marketing workflows that use tools across servers. They are served as MCP
 * prompts by the cross-platform servers (pick them from the client's prompt / slash-command menu) and
 * exported as Agent Skills into skills/ by `npm run skills`.
 */
export type Playbook = {
  name: string;
  title: string;
  description: string;
  servers: string[];
  args: { name: string; description: string; required?: boolean }[];
  steps: (a: Record<string, string | undefined>) => string;
};

const or = (v: string | undefined, fallback: string) => (v && v.trim() ? v.trim() : fallback);

export const PLAYBOOKS: Playbook[] = [
  {
    name: "weekly_performance_report",
    title: "Weekly performance report",
    description: "Blended ads + analytics + store report for a period with wins, problems and next actions.",
    servers: ["ads-hub", "ga4", "shopify", "woocommerce", "monitor", "slack", "google-sheets"],
    args: [
      { name: "period", description: "e.g. last_7_days, last_month (default last_7_days)" },
      { name: "currency", description: "Report currency, e.g. BDT, USD" },
      { name: "revenue_source", description: "ga4, shopify or woocommerce" },
    ],
    steps: (a) => `Build a weekly performance report for ${or(a.period, "the last 7 days")}${a.currency ? ` in ${a.currency}` : ""}.

1. \`ads_platforms\` — list the connected ad platforms.
2. \`ads_report\` with preset ${or(a.period, "last_7_days")}${a.currency ? `, currency ${a.currency}` : ""} and revenue_source ${or(a.revenue_source, "ga4 (or shopify / woocommerce if connected)")} — blended spend, conversions, CPA, ROAS, MER and the change vs the previous period.
3. \`ads_daily\` for the same period — spot days with spikes or drops.
4. If a store is connected, \`shopify_sales_report\` or \`woo_sales_report\` — real revenue, orders, AOV and top UTM sources; compare with platform-reported conversions.
5. \`monitor_check\` — anomalies worth flagging.
6. Write the report: a 3-line executive summary, a table per platform (spend, conversions, CPA, ROAS, Δ%), top 5 campaigns, bottom 5 campaigns by CPA, tracking gaps, and 3–5 concrete next actions with the expected impact.
7. Ask before sending anywhere. If asked: \`monitor_report\` to Slack, or \`sheets_append\` a KPI row.

Never change budgets or pause anything in this playbook — only recommend.`,
  },
  {
    name: "wasted_spend_cleanup",
    title: "Wasted spend cleanup",
    description: "Find campaigns, ad groups and search terms that spend without converting, then propose (not apply) pauses and negatives.",
    servers: ["ads-hub", "google-ads", "microsoft-ads", "meta"],
    args: [
      { name: "period", description: "default last_30_days" },
      { name: "max_cpa", description: "CPA ceiling in report currency" },
    ],
    steps: (a) => `Find wasted ad spend over ${or(a.period, "the last 30 days")}.

1. \`ads_rules\` (dry run) with rules: "spend > 0 and conversions == 0 → flag"${a.max_cpa ? `, "CPA > ${a.max_cpa} → flag"` : ""}, "ROAS < 1 and spend ≥ 5% of total → flag".
2. Google Ads: \`gads_search\` for search terms with cost and zero conversions; Microsoft Ads: \`msads_report\` search-query report — list candidate negatives.
3. Meta: \`meta_get_insights\` at ad-set level — ad sets with frequency > 4 and rising CPA.
4. Present one table: item, platform, spend, conversions, CPA, why it looks wasteful, suggested action (pause / negative keyword / budget cut / creative refresh), confidence.
5. Only after the user picks items: apply them one platform at a time (\`ads_rules\` with apply + confirm, \`gads_set_status\`, \`meta_set_status\`…), then confirm what changed.`,
  },
  {
    name: "tracking_health_check",
    title: "Tracking health check",
    description: "Full audit of a site's tags, consent, server-side setup and conversion gap, with a prioritised fix list.",
    servers: ["tracking-audit", "gtm", "stape", "ga4", "meta"],
    args: [{ name: "site_url", description: "Site to audit, e.g. https://example.com", required: true }],
    steps: (a) => `Run a tracking health check for ${or(a.site_url, "the user's site (ask for the URL)")}.

1. \`audit_full\` for the site — tags, duplicates, Consent Mode v2, CMP, sGTM, GTM workspace, conversion gap and Meta CAPI in one pass.
2. If a server-side container is found: \`sgtm_healthcheck\` on its URL.
3. If the GTM account is connected: \`audit_gtm_workspace\` for paused tags, missing triggers, tags without consent checks.
4. \`audit_conversion_gap\` for the last 7 days — purchases per ad platform vs GA4 vs the store.
5. Report: overall score, then Critical / High / Medium / Low findings, each with evidence (where it was seen) and the exact fix (which tag, trigger or setting). Finish with a 30-minute, 1-day and 1-week fix plan.

Do not create or publish GTM changes in this playbook.`,
  },
  {
    name: "pre_launch_tracking_qa",
    title: "Pre-launch tracking QA",
    description: "Checklist before launching a campaign or new site: events fire once, values and IDs are right, consent works.",
    servers: ["tracking-audit", "gtm", "ga4", "meta", "stape"],
    args: [{ name: "site_url", description: "Site or landing page", required: true }, { name: "conversion", description: "Key conversion, e.g. purchase, generate_lead" }],
    steps: (a) => `QA tracking on ${or(a.site_url, "the landing page (ask for the URL)")} before launch; key conversion: ${or(a.conversion, "purchase / lead (ask which)")}.

1. \`audit_site\` on the URL and the checkout / thank-you page — every tag present exactly once.
2. \`gtm_quick_preview\` or the GTM workspace status — unpublished changes that the launch depends on.
3. \`ga4_run_realtime_report\` while the user places a test conversion — the event arrives once with value and currency.
4. \`meta_pixel_stats\` / \`audit_meta_capi\` — browser and server events deduplicate (same event_id), match keys present.
5. If sGTM is used: \`sgtm_send_ga4_event\` test event and \`sgtm_healthcheck\`.
6. Output a pass/fail checklist with what to fix before launch.`,
  },
  {
    name: "offline_conversion_setup",
    title: "Offline conversion setup",
    description: "Connect CRM closed-won deals to Google, Meta, Microsoft, LinkedIn, Reddit and OpenAI Ads as offline conversions, test first.",
    servers: ["conversion-sync", "google-ads", "meta", "hubspot", "pipedrive", "salesforce", "zoho-crm", "odoo", "ghl"],
    args: [{ name: "crm", description: "hubspot, pipedrive, salesforce, zoho, odoo or ghl" }],
    steps: (a) => `Set up offline conversion sync from ${or(a.crm, "the user's CRM (ask which)")}.

1. \`sync_setup\` — which CRMs and ad platforms are connected, and what is missing (conversion action IDs, pixel, rules).
2. Google Ads: \`gads_list_conversion_actions\` — pick or create an "Offline purchase / Qualified lead" action (type UPLOAD_CLICKS); put its ID in CONVSYNC_GOOGLE_ACTION_ID in .env (the user edits .env, never paste secrets in chat).
3. Make sure click IDs are captured on the CRM record (gclid, fbclid/fbc, msclkid, li_fat_id, rdt_cid, ttclid) — explain the hidden-field / GTM approach if they are missing.
4. \`sync_preview\` for the last 30 days — deals found, match keys per deal, which platforms each deal can go to.
5. \`sync_run\` in test mode — validate-only / test codes.
6. Only after the user confirms: \`sync_run\` with test false and confirm true, then \`sync_history\`.
7. Offer a daily schedule (monitor_schedule / cron) once it works.`,
  },
  {
    name: "seo_quick_wins",
    title: "SEO quick wins",
    description: "Search Console striking-distance queries, low-CTR pages, cannibalisation and indexing problems with fixes.",
    servers: ["search-console", "ga4", "clarity"],
    args: [{ name: "site", description: "Search Console property" }, { name: "section", description: "Optional path filter, e.g. /blog/" }],
    steps: (a) => `Find SEO quick wins for ${or(a.site, "the default Search Console property")}${a.section ? ` in ${a.section}` : ""}.

1. \`gsc_opportunities\` for the last 28 days (exclude brand terms if the user gives them).
2. \`gsc_performance\` by page${a.section ? ` filtered to ${a.section}` : ""} vs the previous period — pages losing clicks.
3. \`gsc_inspect_url\` for the top 10 opportunity pages — indexing or canonical problems.
4. If Clarity is connected: \`clarity_friction\` — do those pages also have UX problems?
5. Output: a table of the 15 best opportunities with the page, query, position, impressions, CTR, the recommended change (title/meta rewrite, content section, internal links, fix indexing, merge cannibalising pages) and expected effect. Draft new titles/meta descriptions for the top 5.`,
  },
  {
    name: "client_monthly_report",
    title: "Client monthly report",
    description: "Agency month-end report for one client profile: ads, analytics, SEO, email and CRM in one document.",
    servers: ["ads-hub", "ga4", "search-console", "klaviyo", "mailchimp", "hubspot", "monitor"],
    args: [{ name: "client", description: "Client name (agency profile)" }, { name: "currency", description: "Report currency" }],
    steps: (a) => `Prepare last month's report for ${or(a.client, "this client")}${a.currency ? ` in ${a.currency}` : ""}. (Agency mode: servers must run with MCP_PROFILE set to this client.)

1. \`ads_report\` preset last_month with MER — and \`ads_pacing\` for this month's budgets.
2. GA4: \`ga4_run_report\` sessions, users, conversions and revenue by default channel group, vs the previous month.
3. SEO: \`gsc_performance\` clicks and impressions by page, top 10 queries.
4. Email, if connected: \`klaviyo_performance\` (campaigns and flows) or \`mailchimp_campaign_report\`.
5. CRM, if connected: \`hubspot_pipeline_report\` (or the connected CRM's report).
6. Write a client-friendly report: highlights, KPIs vs last month and target, what we did, what we learned, next month's plan. Plain language, no internal jargon.
7. Ask before saving or sending (\`monitor_report\` with save/HTML, Slack, or Sheets).`,
  },
  {
    name: "daily_morning_check",
    title: "Daily morning check",
    description: "Two-minute morning scan: yesterday vs normal across ads, site and store, only the things that need attention.",
    servers: ["monitor", "ads-hub", "ga4", "shopify"],
    args: [],
    steps: () => `Morning check for yesterday.

1. \`monitor_check\` — anomalies vs the 14-day median (spend, CPA, conversions, sessions, revenue).
2. \`ads_pacing\` — anything over- or under-pacing this month.
3. If a store is connected: yesterday's \`shopify_sales_report\` / \`woo_sales_report\` vs the same weekday last week.
4. Reply in at most 8 bullet points: only what is unusual, why it may have happened, and what to check first. If nothing is unusual, say so in one line.`,
  },
];

/** Registers the playbooks as MCP prompts on a server (all of them, or the named ones). */
export function registerPlaybooks(server: McpServer, names?: string[]) {
  for (const p of PLAYBOOKS.filter((x) => !names || names.includes(x.name))) {
    const shape = Object.fromEntries(p.args.map((a) => [a.name, a.required ? z.string().describe(a.description) : z.string().optional().describe(a.description)]));
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: shape }, (args: Record<string, string | undefined>) => ({
      description: p.description,
      messages: [{ role: "user" as const, content: { type: "text" as const, text: p.steps(args) } }],
    }));
  }
}
