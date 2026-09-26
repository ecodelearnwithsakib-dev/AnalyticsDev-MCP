import { optionalEnv } from "../shared/env.js";
import { callTool, convert, round } from "../shared/hub.js";
import { ADAPTERS, type Adapter, type FetchOpts, type NRow } from "./adapters.js";

export type Collected = { rows: NRow[]; errors: Record<string, string>; platforms: string[] };

/** Chosen (or all configured) adapters. */
export function pickAdapters(keys?: string[]): Adapter[] {
  const all = ADAPTERS.filter((a) => a.isConfigured());
  if (!keys?.length) return all;
  return keys.map((k) => {
    const a = ADAPTERS.find((x) => x.key === k);
    if (!a) throw new Error(`Unknown platform ${k}. Known: ${ADAPTERS.map((x) => x.key).join(", ")}`);
    if (!a.isConfigured()) throw new Error(`${a.title} isn't configured — add its keys to .env`);
    return a;
  });
}

/** Fetches every platform in parallel; one platform failing doesn't fail the report. */
export async function collect(adapters: Adapter[], o: FetchOpts): Promise<Collected> {
  const errors: Record<string, string> = {};
  const parts = await Promise.all(
    adapters.map((a) =>
      a.fetch(o).catch((e: Error) => {
        errors[a.key] = e.message;
        return [] as NRow[];
      }),
    ),
  );
  return { rows: parts.flat(), errors, platforms: adapters.map((a) => a.key) };
}

export const targetCurrency = (wanted?: string, rows: NRow[] = []) => (wanted ?? optionalEnv("ADS_HUB_CURRENCY") ?? "").toUpperCase() || rows[0]?.currency || "USD";

/** Converts spend/value of every row into `currency` (keeps the native amounts). */
export async function normalize(rows: NRow[], currency: string) {
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      spend_native: r.spend,
      value_native: r.value,
      spend: round(await convert(r.spend, r.currency, currency)),
      value: round(await convert(r.value, r.currency, currency)),
      currency,
      native_currency: r.currency,
    })),
  );
}

export type Totals = { spend: number; impressions: number; clicks: number; conversions: number; value: number };
export const emptyTotals = (): Totals => ({ spend: 0, impressions: 0, clicks: 0, conversions: 0, value: 0 });
export function add(t: Totals, r: Totals) {
  t.spend += r.spend;
  t.impressions += r.impressions;
  t.clicks += r.clicks;
  t.conversions += r.conversions;
  t.value += r.value;
  return t;
}

/** Totals with ratios: CTR %, CPC, CPM, CPA, ROAS, conversion rate %. */
export function ratios(t: Totals) {
  return {
    spend: round(t.spend),
    impressions: Math.round(t.impressions),
    clicks: Math.round(t.clicks),
    conversions: round(t.conversions),
    value: round(t.value),
    ctr: t.impressions ? round((t.clicks / t.impressions) * 100) : null,
    cpc: t.clicks ? round(t.spend / t.clicks) : null,
    cpm: t.impressions ? round((t.spend / t.impressions) * 1000) : null,
    cpa: t.conversions ? round(t.spend / t.conversions) : null,
    roas: t.spend ? round(t.value / t.spend) : null,
    cvr: t.clicks ? round((t.conversions / t.clicks) * 100) : null,
  };
}

export function byPlatform(rows: NRow[]) {
  const m = new Map<string, Totals>();
  for (const r of rows) add(m.get(r.platform) ?? m.set(r.platform, emptyTotals()).get(r.platform)!, r);
  return m;
}

/** Store revenue for MER: GA4 purchaseRevenue (or totalRevenue) for the window, converted. */
export async function revenue(source: string, from: string, to: string, currency: string): Promise<{ source: string; revenue: number; orders?: number; note?: string }> {
  if (source === "ga4") {
    const res = await callTool<{ totals?: Record<string, string>[]; rows?: Record<string, string>[] }>("ga4", "ga4_run_report", { dimensions: [], metrics: ["purchaseRevenue", "transactions"], start_date: from, end_date: to, currency_code: currency, limit: 1 });
    const t = res.totals?.[0] ?? res.rows?.[0] ?? {};
    return { source: "GA4 purchaseRevenue", revenue: round(Number(t.purchaseRevenue ?? 0)), orders: Number(t.transactions ?? 0) };
  }
  if (source === "shopify" || source === "woocommerce") {
    const res = await callTool<{ revenue?: number; orders?: number; currency?: string }>(source, source === "shopify" ? "shopify_sales_report" : "woo_sales_report", { from, to });
    return { source, revenue: round(await convert(Number(res.revenue ?? 0), String(res.currency ?? currency), currency)), orders: res.orders };
  }
  return { source: "none", revenue: 0 };
}

// ---------- rules ----------

export const METRICS = ["spend", "impressions", "clicks", "conversions", "value", "ctr", "cpc", "cpm", "cpa", "roas", "cvr"] as const;
export type Condition = { metric: (typeof METRICS)[number]; op: ">" | ">=" | "<" | "<=" | "==" | "!="; value: number };
export type Rule = { name: string; when: Condition[]; min_spend?: number; platforms?: string[]; action: "pause" | "flag" };

export function matches(metrics: ReturnType<typeof ratios>, c: Condition): boolean {
  const v = metrics[c.metric];
  if (v === null || v === undefined) return c.metric === "cpa" && c.op.startsWith(">") && metrics.spend > 0 && metrics.conversions === 0; // spend with zero conversions counts as infinite CPA
  switch (c.op) {
    case ">":
      return v > c.value;
    case ">=":
      return v >= c.value;
    case "<":
      return v < c.value;
    case "<=":
      return v <= c.value;
    case "==":
      return v === c.value;
    default:
      return v !== c.value;
  }
}
