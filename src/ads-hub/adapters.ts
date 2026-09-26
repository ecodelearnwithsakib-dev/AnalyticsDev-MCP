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

// ---------- Newer ads servers (same row shape from their *_report tools) ----------

type Fetched = { rows?: Rec[] };
const toRows = (platform: string, res: Fetched, currency: string, daily: boolean): NRow[] =>
  (res.rows ?? []).map((r) => ({
    platform,
    date: daily ? String(r.date ?? "").slice(0, 10) : undefined,
    id: String(r.id),
    name: String(r.name ?? r.id),
    status: r.status as string | undefined,
    spend: n(r.spend),
    impressions: n(r.impressions),
    clicks: n(r.clicks),
    conversions: n(r.conversions ?? r.orders),
    value: n(r.value ?? r.sales),
    currency: String(r.currency ?? currency),
  }));

/** Account level for platforms without an account pivot: sum campaign rows (per day when daily). */
function rollup(rows: NRow[], o: FetchOpts, name: string): NRow[] {
  if (o.level !== "account") return rows;
  const m = new Map<string, NRow>();
  for (const r of rows) {
    const k = r.date ?? "";
    const t = m.get(k) ?? { ...r, id: "account", name, status: undefined, spend: 0, impressions: 0, clicks: 0, conversions: 0, value: 0 };
    t.spend += r.spend;
    t.impressions += r.impressions;
    t.clicks += r.clicks;
    t.conversions += r.conversions;
    t.value += r.value;
    m.set(k, t);
  }
  return [...m.values()];
}

const memoCurrency = new Map<string, Promise<string>>();
const cur = (key: string, load: () => Promise<string>) => {
  if (!memoCurrency.has(key)) memoCurrency.set(key, load().catch(() => "USD"));
  return memoCurrency.get(key)!;
};

const linkedin: Adapter = {
  key: "linkedin",
  title: "LinkedIn Ads",
  dir: "linkedin-ads",
  isConfigured: () => configured("LINKEDIN_AD_ACCOUNT_ID") && (configured("LINKEDIN_REFRESH_TOKEN") || configured("LINKEDIN_ACCESS_TOKEN")),
  async fetch(o) {
    const [c, res] = await Promise.all([
      cur("linkedin", async () => String(((await callTool<Rec>("linkedin-ads", "linkedin_api", { path: `adAccounts/${optionalEnv("LINKEDIN_AD_ACCOUNT_ID")}` })) as Rec).currency ?? "USD")),
      callTool<Fetched>("linkedin-ads", "linkedin_report", { pivot: o.level === "account" ? "ACCOUNT" : "CAMPAIGN", from: o.from, to: o.to, daily: o.daily }),
    ]);
    return toRows("linkedin", res, c, o.daily);
  },
  pause: (rows) => callTool("linkedin-ads", "linkedin_campaigns", { action: "set_status", ids: rows.map((r) => r.id), status: "PAUSED" }),
};

const pinterest: Adapter = {
  key: "pinterest",
  title: "Pinterest Ads",
  dir: "pinterest-ads",
  isConfigured: () => configured("PINTEREST_AD_ACCOUNT_ID") && (configured("PINTEREST_REFRESH_TOKEN") || configured("PINTEREST_ACCESS_TOKEN")),
  async fetch(o) {
    const [c, res] = await Promise.all([
      cur("pinterest", async () => String(((await callTool<Rec>("pinterest-ads", "pinterest_api", { path: `ad_accounts/${optionalEnv("PINTEREST_AD_ACCOUNT_ID")}` })) as Rec).currency ?? "USD")),
      callTool<Fetched>("pinterest-ads", "pinterest_report", { level: "campaigns", from: o.from, to: o.to, daily: o.daily }),
    ]);
    return rollup(toRows("pinterest", res, c, o.daily), o, "Pinterest account");
  },
  pause: (rows) => callTool("pinterest-ads", "pinterest_campaigns", { action: "set_status", ids: rows.map((r) => r.id), status: "PAUSED" }),
};

const snapchat: Adapter = {
  key: "snapchat",
  title: "Snapchat Ads",
  dir: "snapchat-ads",
  isConfigured: () => configured("SNAPCHAT_AD_ACCOUNT_ID", "SNAPCHAT_REFRESH_TOKEN"),
  async fetch(o) {
    const [c, res] = await Promise.all([
      cur("snapchat", async () => {
        const r = (await callTool<Rec>("snapchat-ads", "snapchat_api", { path: `adaccounts/${optionalEnv("SNAPCHAT_AD_ACCOUNT_ID")}` })) as { adaccounts?: { adaccount?: Rec }[] };
        return String(r.adaccounts?.[0]?.adaccount?.currency ?? "USD");
      }),
      callTool<Fetched>("snapchat-ads", "snapchat_report", { breakdown: "campaign", from: o.from, to: o.to, daily: o.daily }),
    ]);
    return rollup(toRows("snapchat", res, c, o.daily), o, "Snapchat account");
  },
  pause: (rows) => callTool("snapchat-ads", "snapchat_campaigns", { action: "set_status", ids: rows.map((r) => r.id), status: "PAUSED" }),
};

const x: Adapter = {
  key: "x",
  title: "X Ads",
  dir: "x-ads",
  isConfigured: () => configured("X_ADS_ACCOUNT_ID", "X_CONSUMER_KEY", "X_ACCESS_TOKEN"),
  async fetch(o) {
    const c = await cur("x", async () => optionalEnv("X_ADS_CURRENCY") || String((((await callTool<Rec>("x-ads", "x_api", { path: `accounts/${optionalEnv("X_ADS_ACCOUNT_ID")}/funding_instruments` })) as { data?: Rec[] }).data?.[0]?.currency) ?? "USD"));
    if (!o.daily) return rollup(toRows("x", await callTool<Fetched>("x-ads", "x_report", { entity: "CAMPAIGN", from: o.from, to: o.to }), c, false), o, "X Ads account");
    // X stats have no daily split in the report tool — fetch day by day (short windows only).
    const out: NRow[] = [];
    for (let d = o.from; d <= o.to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
      const res = await callTool<Fetched>("x-ads", "x_report", { entity: "CAMPAIGN", from: d, to: d });
      out.push(...toRows("x", { rows: (res.rows ?? []).map((r) => ({ ...r, date: d })) }, c, true));
    }
    return rollup(out, o, "X Ads account");
  },
  pause: (rows) => callTool("x-ads", "x_campaigns", { action: "set_status", ids: rows.map((r) => r.id), status: "PAUSED" }),
};

const amazon: Adapter = {
  key: "amazon",
  title: "Amazon Ads (Sponsored Products)",
  dir: "amazon-ads",
  isConfigured: () => configured("AMAZON_ADS_REFRESH_TOKEN", "AMAZON_ADS_PROFILE_ID"),
  async fetch(o) {
    const [c, res] = await Promise.all([
      cur("amazon", async () => String(((await callTool<Rec[]>("amazon-ads", "amazon_profiles", {})).find((p) => String(p.profile_id) === optionalEnv("AMAZON_ADS_PROFILE_ID"))?.currency) ?? "USD")),
      callTool<Fetched>("amazon-ads", "amazon_report", { product: "sp", from: o.from, to: o.to, daily: o.daily, wait_seconds: 300 }, 360_000),
    ]);
    return rollup(toRows("amazon", res, c, o.daily), o, "Amazon Ads profile");
  },
  pause: (rows) => callTool("amazon-ads", "amazon_campaigns", { action: "set_state", ids: rows.map((r) => r.id), state: "PAUSED" }),
};

const tiktok: Adapter = {
  key: "tiktok",
  title: "TikTok Ads",
  dir: "tiktok-business",
  isConfigured: () => configured("TIKTOK_ACCESS_TOKEN", "TIKTOK_ADVERTISER_ID"),
  async fetch(o) {
    const res = await callTool<Fetched>("tiktok-business", "tiktok_report", { level: "campaign", from: o.from, to: o.to, daily: o.daily });
    return rollup(toRows("tiktok", res, optionalEnv("TIKTOK_CURRENCY", "USD"), o.daily), o, "TikTok account");
  },
  pause: (rows) => callTool("tiktok-business", "tiktok_campaigns", { action: "set_status", ids: rows.map((r) => r.id), status: "DISABLE" }),
};

export const ADAPTERS: Adapter[] = [meta, google, microsoft, openai, reddit, linkedin, pinterest, snapchat, x, amazon, tiktok];

/** Other servers register their adapters here (LinkedIn, TikTok, Pinterest, Snapchat, X, Amazon…). */
export function registerAdapter(a: Adapter) {
  if (!ADAPTERS.some((x) => x.key === a.key)) ADAPTERS.push(a);
}
