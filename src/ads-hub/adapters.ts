import { optionalEnv } from "../shared/env.js";
import { callTool, configured } from "../shared/hub.js";

/** One campaign (or account) row in a common shape. Money is in `currency` (the platform's account currency). */
export type NRow = {
  platform: string;
  date?: string;
  id: string;
  name: string;
  status?: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  value: number;
  currency: string;
  ref?: string;
};

export type FetchOpts = { from: string; to: string; level: "account" | "campaign"; daily: boolean; conversion: "purchase" | "lead" | "primary" };

export type Adapter = {
  key: string;
  title: string;
  dir: string;
  isConfigured: () => boolean;
  fetch: (o: FetchOpts) => Promise<NRow[]>;
  pause?: (rows: NRow[]) => Promise<unknown>;
};

type Rec = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0) || 0;
const rowsOf = (res: unknown): Rec[] => (Array.isArray(res) ? (res as Rec[]) : (((res as Rec)?.rows ?? (res as Rec)?.data ?? []) as Rec[]));

// ---------- Meta ----------
const META_TYPES = {
  purchase: ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"],
  lead: ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"],
};
function metaAction(list: unknown, types: string[]): number {
  const arr = (list as { action_type: string; value: string }[] | undefined) ?? [];
  for (const t of types) {
    const hit = arr.find((a) => a.action_type === t);
    if (hit) return n(hit.value);
  }
  return 0;
}

const meta: Adapter = {
  key: "meta",
  title: "Meta Ads",
  dir: "meta",
  isConfigured: () => configured("META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"),
  async fetch(o) {
    const types = META_TYPES[o.conversion === "lead" ? "lead" : "purchase"];
    const res = await callTool("meta", "meta_get_insights", {
      level: o.level === "account" ? "account" : "campaign",
      since: o.from,
      until: o.to,
      time_increment: o.daily ? "1" : undefined,
      fields: "account_currency,campaign_id,campaign_name,spend,impressions,clicks,actions,action_values",
      limit: 5000,
    });
    return rowsOf(res).map((r) => ({
      platform: "meta",
      date: o.daily ? String(r.date_start) : undefined,
      id: String(r.campaign_id ?? r.account_id ?? "account"),
      name: String(r.campaign_name ?? "Meta account"),
      spend: n(r.spend),
      impressions: n(r.impressions),
      clicks: n(r.clicks),
      conversions: metaAction(r.actions, types),
      value: metaAction(r.action_values, types),
      currency: String(r.account_currency ?? optionalEnv("META_CURRENCY", "USD")),
    }));
  },
  pause: (rows) => callTool("meta", "meta_set_status", { ids: rows.map((r) => r.id), status: "PAUSED" }),
};

// ---------- Google Ads ----------
let gCurrency: Promise<string> | undefined;
const google: Adapter = {
  key: "google",
  title: "Google Ads",
  dir: "google-ads",
  isConfigured: () => configured("GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID"),
  async fetch(o) {
    gCurrency ??= callTool("google-ads", "gads_search", { query: "SELECT customer.currency_code FROM customer", limit: 1 }).then((r) => String(rowsOf(r)[0]?.["customer.currencyCode"] ?? "USD"));
    const [currency, res] = await Promise.all([
      gCurrency,
      callTool("google-ads", "gads_performance_report", { level: o.level === "account" ? "account" : "campaign", start_date: o.from, end_date: o.to, daily: o.daily, limit: 10000 }),
    ]);
    const cid = optionalEnv("GOOGLE_ADS_CUSTOMER_ID").replace(/-/g, "");
    return rowsOf(res).map((r) => ({
      platform: "google",
      date: o.daily ? String(r["segments.date"]) : undefined,
      id: String(r["campaign.id"] ?? r["customer.id"] ?? cid),
      name: String(r["campaign.name"] ?? r["customer.descriptiveName"] ?? "Google Ads account"),
      status: r["campaign.status"] as string | undefined,
      spend: n(r["metrics.cost"]),
      impressions: n(r["metrics.impressions"]),
      clicks: n(r["metrics.clicks"]),
      conversions: n(r["metrics.conversions"]),
      value: n(r["metrics.conversionsValue"]),
      currency,
      ref: (r["campaign.resourceName"] as string) ?? (r["campaign.id"] ? `customers/${cid}/campaigns/${r["campaign.id"]}` : undefined),
    }));
  },
  pause: (rows) => callTool("google-ads", "gads_set_status", { resource_names: rows.map((r) => r.ref).filter(Boolean), status: "PAUSED" }),
};

// ---------- Microsoft Advertising ----------
const microsoft: Adapter = {
  key: "microsoft",
  title: "Microsoft Ads",
  dir: "microsoft-ads",
  isConfigured: () => configured("MSADS_DEVELOPER_TOKEN", "MSADS_ACCOUNT_ID"),
  async fetch(o) {
    const account = o.level === "account";
    const res = await callTool("microsoft-ads", "msads_report", {
      report: account ? "account" : "campaign",
      aggregation: o.daily ? "Daily" : "Summary",
      date_from: o.from,
      date_to: o.to,
      columns: [...(o.daily ? ["TimePeriod"] : []), ...(account ? ["AccountName", "AccountId"] : ["CampaignName", "CampaignId", "CampaignStatus"]), "CurrencyCode", "Impressions", "Clicks", "Spend", "Conversions", "Revenue"],
      limit: 10000,
    });
    return rowsOf(res).map((r) => ({
      platform: "microsoft",
      date: o.daily ? String(r.TimePeriod).slice(0, 10) : undefined,
      id: String(r.CampaignId ?? r.AccountId),
      name: String(r.CampaignName ?? r.AccountName),
      status: r.CampaignStatus as string | undefined,
      spend: n(r.Spend),
      impressions: n(r.Impressions),
      clicks: n(r.Clicks),
      conversions: n(r.Conversions),
      value: n(r.Revenue),
      currency: String(r.CurrencyCode ?? "USD"),
    }));
  },
  pause: (rows) => callTool("microsoft-ads", "msads_set_status", { kind: "campaign", ids: rows.map((r) => r.id), action: "Paused" }),
};

// ---------- OpenAI Ads ----------
const openai: Adapter = {
  key: "openai",
  title: "OpenAI Ads",
  dir: "openai-ads",
  isConfigured: () => configured("OPENAI_ADS_API_KEY"),
  async fetch(o) {
    const { currency } = await import("../openai-ads/client.js");
    const [cur, res] = await Promise.all([
      currency().catch(() => "USD"),
      callTool("openai-ads", "oai_ads_insights", { scope: "ad_account", level: "campaign", granularity: o.daily ? "daily" : "none", date_from: o.from, date_to: o.to, include_conversions: !o.daily, limit: 10000 }),
    ]);
    const rows = rowsOf(res).map((r) => ({
      platform: "openai",
      date: o.daily ? String(r.readable_time ?? (r.metadata as Rec)?.readable_time ?? r.date ?? "").slice(0, 10) : undefined,
      id: String(r.campaign_id ?? r.id ?? "account"),
      name: String(r.campaign_name ?? r.name ?? "OpenAI Ads account"),
      spend: n(r.spend),
      impressions: n(r.impressions),
      clicks: n(r.clicks),
      conversions: n(r.conversions),
      value: n(r.conversion_value ?? r.value),
      currency: cur,
    }));
    return o.level === "account" && !o.daily ? [rows.reduce((t, r) => ({ ...t, spend: t.spend + r.spend, impressions: t.impressions + r.impressions, clicks: t.clicks + r.clicks, conversions: t.conversions + r.conversions, value: t.value + r.value }), { platform: "openai", id: "account", name: "OpenAI Ads account", spend: 0, impressions: 0, clicks: 0, conversions: 0, value: 0, currency: cur } as NRow)] : rows;
  },
  pause: (rows) => callTool("openai-ads", "oai_ads_set_status", { kind: "campaign", ids: rows.map((r) => r.id), action: "pause" }),
};

// ---------- Reddit Ads ----------
let rCurrency: Promise<string> | undefined;
const reddit: Adapter = {
  key: "reddit",
  title: "Reddit Ads",
  dir: "reddit",
  isConfigured: () => configured("REDDIT_REFRESH_TOKEN", "REDDIT_AD_ACCOUNT_ID"),
  async fetch(o) {
    rCurrency ??= callTool<{ currency?: string }>("reddit", "reddit_ads_accounts", { what: "account" }).then((a) => String(a?.currency ?? "USD")).catch(() => "USD");
    const [cur, res] = await Promise.all([
      rCurrency,
      callTool("reddit", "reddit_ads_report", { level: o.level === "account" ? "account" : "campaign", breakdowns: o.daily ? ["DATE"] : undefined, from: o.from, to: o.to, limit: 5000 }),
    ]);
    return rowsOf(res).map((r) => ({
      platform: "reddit",
      date: o.daily ? String(r.date ?? "").slice(0, 10) : undefined,
      id: String(r.campaign_id ?? r.ad_account_id ?? "account"),
      name: String(r.name ?? "Reddit account"),
      spend: n(r.spend),
      impressions: n(r.impressions),
      clicks: n(r.clicks),
      conversions: n(r.key_conversion_total_count),
      value: n(r.conversion_purchase_total_value),
      currency: cur,
    }));
  },
  pause: (rows) => Promise.all(rows.map((r) => callTool("reddit", "reddit_ads_manage", { action: "set_status", entity: "campaign", id: r.id, status: "PAUSED" }))),
};

export const ADAPTERS: Adapter[] = [meta, google, microsoft, openai, reddit];

/** Other servers register their adapters here (LinkedIn, TikTok, Pinterest, Snapchat, X, Amazon…). */
export function registerAdapter(a: Adapter) {
  if (!ADAPTERS.some((x) => x.key === a.key)) ADAPTERS.push(a);
}
