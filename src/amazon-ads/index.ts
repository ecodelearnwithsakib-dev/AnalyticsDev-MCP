#!/usr/bin/env node
import { gunzipSync } from "node:zlib";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { PRESETS, round, window } from "../shared/hub.js";
import { oauthRefresher, restClient } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

const REGION = () => optionalEnv("AMAZON_ADS_REGION", "NA").toUpperCase();
const API = { NA: "https://advertising-api.amazon.com", EU: "https://advertising-api-eu.amazon.com", FE: "https://advertising-api-fe.amazon.com" } as Record<string, string>;
const TOKEN = { NA: "https://api.amazon.com/auth/o2/token", EU: "https://api.amazon.co.uk/auth/o2/token", FE: "https://api.amazon.co.jp/auth/o2/token" } as Record<string, string>;

const token = oauthRefresher({ tokenUrl: () => TOKEN[REGION()] ?? TOKEN.NA, clientIdEnv: "AMAZON_ADS_CLIENT_ID", clientSecretEnv: "AMAZON_ADS_CLIENT_SECRET", refreshTokenEnv: "AMAZON_ADS_REFRESH_TOKEN", signinHint: "run `npm run auth:amazon-ads`" });
let profileOverride: string | undefined;
const amz = restClient({
  name: "Amazon Ads",
  base: () => optionalEnv("AMAZON_ADS_API_BASE", API[REGION()] ?? API.NA),
  headers: async () => ({ Authorization: `Bearer ${await token.get()}`, "Amazon-Advertising-API-ClientId": requireEnv("AMAZON_ADS_CLIENT_ID"), ...(profileOverride || optionalEnv("AMAZON_ADS_PROFILE_ID") ? { "Amazon-Advertising-API-Scope": profileOverride || optionalEnv("AMAZON_ADS_PROFILE_ID") } : {}) }),
  hints: { 401: "run `npm run auth:amazon-ads` again (and check AMAZON_ADS_REGION)", 403: "set AMAZON_ADS_PROFILE_ID to a profile you can access (see amazon_profiles)" },
  onUnauthorized: () => token.reset(),
});

type Rec = Record<string, unknown>;
const SP_TYPE = "application/vnd.spCampaign.v3+json";

const PRODUCTS = {
  sp: { adProduct: "SPONSORED_PRODUCTS", reportTypeId: "spCampaigns", columns: ["campaignId", "campaignName", "campaignStatus", "impressions", "clicks", "cost", "purchases7d", "sales7d", "unitsSoldClicks7d", "campaignBudgetAmount"], conv: "purchases7d", sales: "sales7d" },
  sb: { adProduct: "SPONSORED_BRANDS", reportTypeId: "sbCampaigns", columns: ["campaignId", "campaignName", "campaignStatus", "impressions", "clicks", "cost", "purchases", "sales", "newToBrandPurchases"], conv: "purchases", sales: "sales" },
  sd: { adProduct: "SPONSORED_DISPLAY", reportTypeId: "sdCampaigns", columns: ["campaignId", "campaignName", "campaignStatus", "impressions", "clicks", "cost", "purchases", "sales", "impressionsViews"], conv: "purchases", sales: "sales" },
} as const;

async function report(product: keyof typeof PRODUCTS, from: string, to: string, daily: boolean, waitSeconds: number) {
  const def = PRODUCTS[product];
  const created = (await amz("reporting/reports", {
    headers: { "Content-Type": "application/vnd.createasyncreportrequest.v3+json" },
    body: { name: `mcp ${product} ${from} ${to}`, startDate: from, endDate: to, configuration: { adProduct: def.adProduct, groupBy: ["campaign"], columns: daily ? ["date", ...def.columns] : def.columns, reportTypeId: def.reportTypeId, timeUnit: daily ? "DAILY" : "SUMMARY", format: "GZIP_JSON" } },
  })) as { reportId: string };
  const deadline = Date.now() + waitSeconds * 1000;
  for (let wait = 2000; Date.now() < deadline; wait = Math.min(wait * 2, 15_000)) {
    const st = (await amz(`reporting/reports/${created.reportId}`)) as { status: string; url?: string; failureReason?: string };
    if (st.status === "COMPLETED" && st.url) {
      const res = await fetch(st.url);
      return { rows: JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8")) as Rec[], def };
    }
    if (st.status === "FAILED") throw new Error(`Report failed: ${st.failureReason}`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return { pending: created.reportId, def };
}

const server = new McpServer(
  { name: "amazon-ads", version: "0.1.0" },
  { instructions: "Amazon Ads API: profiles (marketplaces), Sponsored Products / Brands / Display campaign reports with sales, ACOS and ROAS, campaign status and budgets, and keyword bids. Reports are asynchronous (usually 1–3 minutes). Set AMAZON_ADS_PROFILE_ID (or pass profile_id) for the marketplace to use." },
);

const PROFILE = z.string().optional().describe("Advertising profile ID (default AMAZON_ADS_PROFILE_ID)");
const withProfile = async <T>(p: string | undefined, fn: () => Promise<T>): Promise<T> => {
  profileOverride = p;
  try {
    return await fn();
  } finally {
    profileOverride = undefined;
  }
};

server.registerTool(
  "amazon_profiles",
  { title: "Profiles (marketplaces)", description: "Advertising profiles you can access: profile ID, marketplace/country, currency, timezone and account type (seller, vendor, agency).", inputSchema: {} },
  () => run(async () => ((await amz("v2/profiles")) as Rec[]).map((p) => ({ profile_id: p.profileId, country: p.countryCode, currency: p.currencyCode, timezone: p.timezone, type: (p.accountInfo as Rec)?.type, name: (p.accountInfo as Rec)?.name, marketplace: (p.accountInfo as Rec)?.marketplaceStringId }))),
);

server.registerTool(
  "amazon_report",
  {
    title: "Campaign report",
    description: "Sponsored Products, Brands or Display campaign performance for a period: impressions, clicks, spend, orders, sales, CTR, CPC, ACOS (spend ÷ sales) and ROAS — total or daily. Waits for Amazon's async report (returns a report ID to re-check if it takes longer).",
    inputSchema: { profile_id: PROFILE, product: z.enum(["sp", "sb", "sd"]).default("sp"), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), daily: z.boolean().default(false), wait_seconds: z.number().int().min(10).max(600).default(180) },
  },
  (a) =>
    run(() =>
      withProfile(a.profile_id, async () => {
        const w = window(a.preset, a.from, a.to);
        const r = await report(a.product, w.from, w.to, a.daily, a.wait_seconds);
        if ("pending" in r) return { status: "pending", report_id: r.pending, note: "Call again later or with a longer wait_seconds" };
        const rows = r.rows.map((x) => {
          const spend = Number(x.cost ?? 0);
          const sales = Number(x[r.def.sales] ?? 0);
          const orders = Number(x[r.def.conv] ?? 0);
          return { date: x.date, id: String(x.campaignId), name: x.campaignName, status: x.campaignStatus, impressions: Number(x.impressions ?? 0), clicks: Number(x.clicks ?? 0), spend: round(spend), orders, sales: round(sales), acos_pct: sales ? round((spend / sales) * 100, 1) : null, roas: spend ? round(sales / spend) : null, cpc: Number(x.clicks) ? round(spend / Number(x.clicks)) : null, budget: x.campaignBudgetAmount };
        });
        const t = rows.reduce((s, x) => ({ spend: s.spend + x.spend, sales: s.sales + x.sales, orders: s.orders + x.orders, clicks: s.clicks + x.clicks }), { spend: 0, sales: 0, orders: 0, clicks: 0 });
        return { window: w, totals: { ...t, spend: round(t.spend), sales: round(t.sales), acos_pct: t.sales ? round((t.spend / t.sales) * 100, 1) : null, roas: t.spend ? round(t.sales / t.spend) : null }, rows: rows.sort((p, q) => q.spend - p.spend) };
      }),
    ),
);

server.registerTool(
  "amazon_campaigns",
  { title: "Sponsored Products campaigns", description: "List Sponsored Products campaigns (state, targeting, daily budget, bidding strategy); pause/enable/archive; change daily budgets.", inputSchema: { profile_id: PROFILE, action: z.enum(["list", "set_state", "update_budget"]).default("list"), ids: z.array(z.string()).optional(), state: z.enum(["ENABLED", "PAUSED", "ARCHIVED"]).optional(), daily_budget: z.number().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(() =>
      withProfile(a.profile_id, async () => {
        if (a.action === "list") {
          const r = (await amz("sp/campaigns/list", { headers: { "Content-Type": SP_TYPE, Accept: SP_TYPE }, body: { maxResults: 1000, stateFilter: { include: ["ENABLED", "PAUSED"] } } })) as { campaigns?: Rec[] };
          return (r.campaigns ?? []).map((c) => ({ id: c.campaignId, name: c.name, state: c.state, targeting: c.targetingType, daily_budget: (c.budget as Rec)?.budget, bidding: (c.dynamicBidding as Rec)?.strategy, start: c.startDate }));
        }
        if (!a.ids?.length) throw new Error("ids is required");
        if (a.state === "ARCHIVED" && !a.confirm) throw new Error("Archiving can't be undone; set confirm: true");
        const campaigns = a.ids.map((id) => ({ campaignId: id, ...(a.action === "set_state" ? { state: a.state ?? "PAUSED" } : {}), ...(a.daily_budget !== undefined ? { budget: { budget: a.daily_budget, budgetType: "DAILY" } } : {}) }));
        return amz("sp/campaigns", { method: "PUT", headers: { "Content-Type": SP_TYPE, Accept: SP_TYPE }, body: { campaigns } });
      }),
    ),
);

server.registerTool(
  "amazon_keywords",
  { title: "Sponsored Products keywords", description: "List keywords of a campaign/ad group (match type, bid, state) and update bids or pause keywords.", inputSchema: { profile_id: PROFILE, action: z.enum(["list", "update"]).default("list"), campaign_id: z.string().optional(), updates: z.array(z.object({ keyword_id: z.string(), bid: z.number().optional(), state: z.enum(["ENABLED", "PAUSED"]).optional() })).optional() } },
  (a) =>
    run(() =>
      withProfile(a.profile_id, async () => {
        const T = "application/vnd.spKeyword.v3+json";
        if (a.action === "list") {
          const r = (await amz("sp/keywords/list", { headers: { "Content-Type": T, Accept: T }, body: { maxResults: 1000, campaignIdFilter: a.campaign_id ? { include: [a.campaign_id] } : undefined } })) as { keywords?: Rec[] };
          return (r.keywords ?? []).map((k) => ({ id: k.keywordId, text: k.keywordText, match: k.matchType, bid: k.bid, state: k.state, ad_group: k.adGroupId }));
        }
        if (!a.updates?.length) throw new Error("updates is required");
        return amz("sp/keywords", { method: "PUT", headers: { "Content-Type": T, Accept: T }, body: { keywords: a.updates.map((u) => ({ keywordId: u.keyword_id, bid: u.bid, state: u.state })) } });
      }),
    ),
);

server.registerTool(
  "amazon_api",
  { title: "Amazon Ads API call", description: "Call any Amazon Ads API endpoint (e.g. sp/adGroups/list, sp/targets/list, sb/v4/campaigns/list, sd/campaigns, reporting/reports). Pass content_type for versioned media types.", inputSchema: { profile_id: PROFILE, method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("POST"), path: z.string(), body: z.unknown().optional(), content_type: z.string().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(() =>
      withProfile(a.profile_id, async () => {
        if (a.method === "DELETE" && !a.confirm) throw new Error("DELETE calls need confirm: true");
        return amz(a.path, { method: a.method, body: a.body, headers: a.content_type ? { "Content-Type": a.content_type, Accept: a.content_type } : undefined });
      }),
    ),
);

await startStdio(server, "amazon-ads");
