#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { PRESETS, round, window } from "../shared/hub.js";
import { oauthRefresher, restClient, sha256 } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

const token = oauthRefresher({ tokenUrl: "https://api.pinterest.com/v5/oauth/token", clientIdEnv: "PINTEREST_APP_ID", clientSecretEnv: "PINTEREST_APP_SECRET", refreshTokenEnv: "PINTEREST_REFRESH_TOKEN", basicAuth: true, signinHint: "run `npm run auth:pinterest`" });
const pin = restClient({
  name: "Pinterest",
  base: () => optionalEnv("PINTEREST_API_BASE", "https://api.pinterest.com/v5"),
  headers: async () => ({ Authorization: `Bearer ${optionalEnv("PINTEREST_ACCESS_TOKEN") || (await token.get())}` }),
  arrayFormat: "comma",
  hints: { 401: "run `npm run auth:pinterest` again" },
  onUnauthorized: () => token.reset(),
});

type Rec = Record<string, unknown>;
const account = (id?: string) => id ?? requireEnv("PINTEREST_AD_ACCOUNT_ID");
const micro = (v: unknown) => round(Number(v ?? 0) / 1_000_000);

async function listAll(path: string, query: Rec = {}): Promise<Rec[]> {
  const out: Rec[] = [];
  let bookmark: string | undefined;
  do {
    const r = (await pin(path, { query: { ...(query as Record<string, string>), page_size: 250, bookmark } })) as { items?: Rec[]; bookmark?: string };
    out.push(...(r.items ?? []));
    bookmark = r.bookmark ?? undefined;
  } while (bookmark && out.length < 10000);
  return out;
}

const server = new McpServer(
  { name: "pinterest-ads", version: "0.1.0" },
  { instructions: "Pinterest Ads API v5: ad accounts, campaigns (status, budgets), performance by campaign/ad group/ad with checkout value and ROAS, Conversions API, catalogs and boards. Spend is converted from micro-currency. New campaigns should start paused." },
);

const ACC = z.string().optional().describe("Ad account ID (default PINTEREST_AD_ACCOUNT_ID)");

server.registerTool(
  "pinterest_accounts",
  { title: "Ad accounts", description: "Ad accounts you can access with currency, country and your role.", inputSchema: {} },
  () => run(async () => (await listAll("ad_accounts")).map((a) => ({ id: a.id, name: a.name, currency: a.currency, country: a.country, permissions: a.permissions }))),
);

server.registerTool(
  "pinterest_report",
  {
    title: "Performance report",
    description: "Spend, impressions, clicks, CTR, CPC, conversions (checkouts, leads, sign-ups…), checkout value and ROAS by campaign, ad group or ad — total or daily, names attached.",
    inputSchema: { account_id: ACC, level: z.enum(["campaigns", "ad_groups", "ads"]).default("campaigns"), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), daily: z.boolean().default(false), attribution: z.enum(["1", "7", "30", "60"]).default("30").describe("Click attribution window (days)") },
  },
  (a) =>
    run(async () => {
      const acc = account(a.account_id);
      const w = window(a.preset, a.from, a.to);
      const entities = await listAll(`ad_accounts/${acc}/${a.level}`);
      const idKey = a.level === "campaigns" ? "campaign_ids" : a.level === "ad_groups" ? "ad_group_ids" : "ad_ids";
      const rows: Rec[] = [];
      for (let i = 0; i < entities.length; i += 250) {
        const ids = entities.slice(i, i + 250).map((e) => String(e.id));
        if (!ids.length) break;
        const r = (await pin(`ad_accounts/${acc}/${a.level}/analytics`, {
          query: { start_date: w.from, end_date: w.to, [idKey]: ids, columns: ["SPEND_IN_MICRO_DOLLAR", "IMPRESSION_1", "CLICKTHROUGH_1", "TOTAL_CONVERSIONS", "TOTAL_CHECKOUT", "TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR", "TOTAL_LEAD", "CAMPAIGN_ID", "AD_GROUP_ID", "AD_ID"], granularity: a.daily ? "DAY" : "TOTAL", click_window_days: a.attribution, view_window_days: "1", conversion_report_time: "TIME_OF_AD_ACTION" },
        })) as Rec[];
        rows.push(...(Array.isArray(r) ? r : []));
      }
      const byId = new Map(entities.map((e) => [String(e.id), e]));
      return {
        window: w,
        rows: rows
          .map((r) => {
            const id = String(r.CAMPAIGN_ID ?? r.AD_GROUP_ID ?? r.AD_ID ?? "");
            const spend = micro(r.SPEND_IN_MICRO_DOLLAR);
            const value = micro(r.TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR);
            const conv = Number(r.TOTAL_CONVERSIONS ?? r.TOTAL_CHECKOUT ?? 0);
            return { date: a.daily ? r.DATE : undefined, id, name: byId.get(id)?.name, status: byId.get(id)?.status, spend, impressions: Number(r.IMPRESSION_1 ?? 0), clicks: Number(r.CLICKTHROUGH_1 ?? 0), conversions: conv, checkouts: Number(r.TOTAL_CHECKOUT ?? 0), leads: Number(r.TOTAL_LEAD ?? 0), value, cpa: conv ? round(spend / conv) : null, roas: spend ? round(value / spend) : null };
          })
          .sort((x, y) => y.spend - x.spend),
      };
    }),
);

server.registerTool(
  "pinterest_campaigns",
  { title: "Campaigns", description: "List campaigns (status, objective, daily/lifetime budget); pause, activate or archive; change budgets (account currency).", inputSchema: { account_id: ACC, action: z.enum(["list", "set_status", "update_budget"]).default("list"), ids: z.array(z.string()).optional(), status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]).optional(), daily_budget: z.number().optional(), lifetime_budget: z.number().optional() } },
  (a) =>
    run(async () => {
      const acc = account(a.account_id);
      if (a.action === "list") return (await listAll(`ad_accounts/${acc}/campaigns`)).map((c) => ({ id: c.id, name: c.name, status: c.status, objective: c.objective_type, daily_budget: c.daily_spend_cap ? micro(c.daily_spend_cap) : undefined, lifetime_budget: c.lifetime_spend_cap ? micro(c.lifetime_spend_cap) : undefined }));
      if (!a.ids?.length) throw new Error("ids is required");
      const body = a.ids.map((id) => ({ id, ...(a.action === "set_status" ? { status: a.status ?? "PAUSED" } : {}), ...(a.daily_budget !== undefined ? { daily_spend_cap: Math.round(a.daily_budget * 1e6) } : {}), ...(a.lifetime_budget !== undefined ? { lifetime_spend_cap: Math.round(a.lifetime_budget * 1e6) } : {}) }));
      return pin(`ad_accounts/${acc}/campaigns`, { method: "PATCH", body });
    }),
);

server.registerTool(
  "pinterest_conversions",
  {
    title: "Conversions API",
    description: "Send server/offline conversion events (checkout, lead, signup, add_to_cart, page_visit, custom) with hashed email/phone, value, order ID and event_id for deduplication with the tag. test: true validates without recording; real sends need confirm.",
    inputSchema: {
      account_id: ACC,
      events: z.array(z.object({ event_name: z.enum(["checkout", "add_to_cart", "page_visit", "signup", "lead", "search", "view_category", "watch_video", "custom"]), time: z.string().optional(), event_id: z.string(), action_source: z.enum(["web", "app_android", "app_ios", "offline"]).default("web"), email: z.string().optional(), phone: z.string().optional(), external_id: z.string().optional(), click_id: z.string().optional().describe("epik"), value: z.number().optional(), currency: z.string().optional(), order_id: z.string().optional(), url: z.string().optional() })).min(1).max(1000),
      test: z.boolean().default(true),
      confirm: z.boolean().default(false),
    },
  },
  (a) =>
    run(async () => {
      if (!a.test && !a.confirm) throw new Error("Real conversions change reporting and bidding; pass test: false with confirm: true");
      const data = await Promise.all(
        a.events.map(async (e) => ({
          event_name: e.event_name,
          action_source: e.action_source,
          event_time: Math.floor(Date.parse(e.time ?? new Date().toISOString()) / 1000),
          event_id: e.event_id,
          event_source_url: e.url,
          user_data: { em: e.email ? [await sha256(e.email, "email")] : undefined, ph: e.phone ? [await sha256(e.phone, "phone")] : undefined, external_id: e.external_id ? [await sha256(e.external_id)] : undefined, click_id: e.click_id },
          custom_data: { currency: e.currency, value: e.value !== undefined ? String(e.value) : undefined, order_id: e.order_id },
        })),
      );
      return pin(`ad_accounts/${account(a.account_id)}/events`, { query: { test: a.test }, body: { data } });
    }),
);

server.registerTool(
  "pinterest_api",
  { title: "Pinterest API call", description: "Call any Pinterest API v5 endpoint (e.g. catalogs, catalogs/product_groups, boards, pins, audiences, keywords/metrics).", inputSchema: { method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method === "DELETE" && !a.confirm) throw new Error("DELETE calls need confirm: true");
      return pin(a.path.replace("{account}", account()), { method: a.method, query: a.query, body: a.body });
    }),
);

await startStdio(server, "pinterest-ads");
