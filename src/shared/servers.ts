import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (the folder with package.json and .env). */
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export type ServerInfo = { name: string; dir: string; title: string };

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
