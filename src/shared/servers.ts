import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (the folder with package.json and .env). */
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export type ServerInfo = { name: string; dir: string; title: string };

/** Product name shown to people (server titles, extensions, docs). Technical ids stay "analyticsdev". */
export const BRAND = "Analytics Dev";

/** Every local server in this repo. `name` is what clients show; `dir` is src/<dir> and dist/<dir>. */
export const SERVERS: ServerInfo[] = [
  { name: "meta", dir: "meta", title: "Meta Ads, Pages, Instagram, CAPI, Catalog" },
  { name: "google-ads", dir: "google-ads", title: "Google Ads" },
  { name: "microsoft-ads", dir: "microsoft-ads", title: "Microsoft Advertising (Bing)" },
  { name: "openai-ads", dir: "openai-ads", title: "OpenAI Ads (ChatGPT ads)" },
  { name: "reddit", dir: "reddit", title: "Reddit Ads + community" },
  { name: "ga4", dir: "ga4", title: "Google Analytics 4" },
  { name: "matomo", dir: "matomo", title: "Matomo" },
  { name: "looker-studio", dir: "looker-studio", title: "Looker Studio" },
  { name: "bigquery", dir: "bigquery", title: "BigQuery" },
  { name: "stape", dir: "stape", title: "Stape / server-side GTM" },
  { name: "gtm", dir: "gtm", title: "Google Tag Manager" },
  { name: "n8n", dir: "n8n", title: "n8n" },
  { name: "clickup", dir: "clickup", title: "ClickUp" },
  { name: "slack", dir: "slack", title: "Slack" },
  { name: "zoho-crm", dir: "zoho-crm", title: "Zoho CRM" },
  { name: "odoo", dir: "odoo", title: "Odoo" },
  { name: "ghl", dir: "ghl", title: "HighLevel (GoHighLevel)" },
  { name: "pipedrive", dir: "pipedrive", title: "Pipedrive" },
  { name: "salesforce", dir: "salesforce", title: "Salesforce" },
  { name: "search-console", dir: "search-console", title: "Google Search Console" },
  { name: "merchant-center", dir: "merchant-center", title: "Google Merchant Center" },
  { name: "youtube-analytics", dir: "youtube-analytics", title: "YouTube Analytics" },
  { name: "google-sheets", dir: "google-sheets", title: "Google Sheets" },
  { name: "linkedin-ads", dir: "linkedin-ads", title: "LinkedIn Ads" },
  { name: "pinterest-ads", dir: "pinterest-ads", title: "Pinterest Ads" },
  { name: "snapchat-ads", dir: "snapchat-ads", title: "Snapchat Ads" },
  { name: "x-ads", dir: "x-ads", title: "X (Twitter) Ads" },
  { name: "amazon-ads", dir: "amazon-ads", title: "Amazon Ads" },
  { name: "tiktok-business", dir: "tiktok-business", title: "TikTok Business API (events, reports)" },
  { name: "shopify", dir: "shopify", title: "Shopify" },
  { name: "woocommerce", dir: "woocommerce", title: "WooCommerce" },
  { name: "hubspot", dir: "hubspot", title: "HubSpot CRM" },
  { name: "posthog", dir: "posthog", title: "PostHog" },
  { name: "mixpanel", dir: "mixpanel", title: "Mixpanel" },
  { name: "amplitude", dir: "amplitude", title: "Amplitude" },
  { name: "clarity", dir: "clarity", title: "Microsoft Clarity" },
  { name: "klaviyo", dir: "klaviyo", title: "Klaviyo" },
  { name: "mailchimp", dir: "mailchimp", title: "Mailchimp" },
  { name: "whatsapp", dir: "whatsapp", title: "WhatsApp Business (Cloud API)" },
  { name: "airtable", dir: "airtable", title: "Airtable" },
  { name: "notion", dir: "notion", title: "Notion" },
  { name: "ads-hub", dir: "ads-hub", title: "Cross-platform ads: blended report, rules, pacing" },
  { name: "tracking-audit", dir: "tracking-audit", title: "Tracking audit: tags, consent, sGTM, conversion gap, CAPI" },
  { name: "conversion-sync", dir: "conversion-sync", title: "CRM won deals → offline conversions in ad platforms" },
  { name: "monitor", dir: "monitor", title: "Anomaly alerts and scheduled reports" },
];

/** Official remote MCP servers that pair with the local ones (OAuth in the client). */
export const REMOTE_SERVERS: { name: string; url: string; title: string }[] = [
  { name: "tiktok-ads", url: "https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat", title: "TikTok Ads (official)" },
  { name: "clickup-official", url: "https://mcp.clickup.com/mcp", title: "ClickUp (official)" },
  { name: "ghl-official", url: "https://services.leadconnectorhq.com/mcp/anthropic/v2", title: "HighLevel (official)" },
  { name: "pipedrive-official", url: "https://mcp.pipedrive.ai/mcp", title: "Pipedrive (official)" },
  { name: "zoho-crm-insights", url: "https://zoho-crm-data-insights-60065097786.zohomcp.in/mcp/d17dfe13292e0414a929516bb8f8e797/message", title: "Zoho CRM Data Insights (official)" },
  { name: "zoho-crm-operations", url: "https://zoho-crm-data-operations-60065097786.zohomcp.in/mcp/fe46ddbc48fec3713c8754cea8ec9ac5/message", title: "Zoho CRM Data Operations (official)" },
];

/** "Analytics Dev · Google Analytics 4" for a server name or dir. */
export const brandTitle = (name: string) => `${BRAND} · ${SERVERS.find((s) => s.name === name || s.dir === name)?.title ?? name}`;

const LABELS: Record<string, string> = {
  meta: "Meta", "google-ads": "Google Ads", "microsoft-ads": "Microsoft Ads", "openai-ads": "OpenAI Ads", reddit: "Reddit", ga4: "GA4", matomo: "Matomo",
  "looker-studio": "Looker Studio", bigquery: "BigQuery", stape: "Stape", gtm: "GTM", n8n: "n8n", clickup: "ClickUp", slack: "Slack", "zoho-crm": "Zoho CRM",
  odoo: "Odoo", ghl: "HighLevel", pipedrive: "Pipedrive", salesforce: "Salesforce", "search-console": "Search Console", "merchant-center": "Merchant Center",
  "youtube-analytics": "YouTube Analytics", "google-sheets": "Google Sheets", "linkedin-ads": "LinkedIn Ads", "pinterest-ads": "Pinterest Ads", "snapchat-ads": "Snapchat Ads",
  "x-ads": "X Ads", "amazon-ads": "Amazon Ads", "tiktok-business": "TikTok Business", shopify: "Shopify", woocommerce: "WooCommerce", hubspot: "HubSpot", posthog: "PostHog",
  mixpanel: "Mixpanel", amplitude: "Amplitude", clarity: "Clarity", klaviyo: "Klaviyo", mailchimp: "Mailchimp", whatsapp: "WhatsApp", airtable: "Airtable", notion: "Notion",
  "ads-hub": "Ads Hub", "tracking-audit": "Tracking Audit", "conversion-sync": "Conversion Sync", monitor: "Monitor",
};
/** Short display name for app lists, e.g. "Analytics Dev GTM". */
export const displayName = (s: ServerInfo) => `${BRAND} ${LABELS[s.name] ?? s.name}`;

export const entry = (s: ServerInfo) => resolve(projectRoot, "dist", s.dir, "index.js");
export const built = (s: ServerInfo) => existsSync(entry(s));

/** Pick servers by name ("meta,ga4" / ["meta","ga4"]); empty = every built server. */
export function pick(names?: string[]): ServerInfo[] {
  const wanted = (names ?? []).flatMap((n) => n.split(",")).map((n) => n.trim()).filter(Boolean);
  if (!wanted.length) return SERVERS.filter(built);
  return wanted.map((n) => {
    const s = SERVERS.find((x) => x.name === n || x.dir === n);
    if (!s) throw new Error(`Unknown server "${n}". Known: ${SERVERS.map((x) => x.name).join(", ")}`);
    return s;
  });
}

const GOOGLE_FAMILY = new Set(["ga4", "gtm", "bigquery", "looker-studio", "google-ads", "microsoft-ads", "search-console", "merchant-center", "youtube-analytics", "google-sheets"]);

/** Env variable names a server reads, from its section in .env.example (for cloud agents' secret stores). */
export function envKeys(s: ServerInfo): string[] {
  const file = resolve(projectRoot, ".env.example");
  if (!existsSync(file)) return [];
  const keys: string[] = [];
  let inside = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("# ----------")) inside = line.includes(`(src/${s.dir})`);
    else if (inside) {
      const m = line.match(/^([A-Z0-9_]+)=/);
      if (m) keys.push(m[1]);
    }
  }
  if (GOOGLE_FAMILY.has(s.dir)) keys.push("GA4_OAUTH_CLIENT_ID", "GA4_OAUTH_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS");
  return [...new Set(keys)];
}
