#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { PRESETS, round, window } from "../shared/hub.js";
import { oauthRefresher, restClient, sha256 } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

const token = oauthRefresher({ tokenUrl: "https://accounts.snapchat.com/login/oauth2/access_token", clientIdEnv: "SNAPCHAT_CLIENT_ID", clientSecretEnv: "SNAPCHAT_CLIENT_SECRET", refreshTokenEnv: "SNAPCHAT_REFRESH_TOKEN", signinHint: "run `npm run auth:snapchat`" });
const snap = restClient({
  name: "Snapchat",
  base: () => optionalEnv("SNAPCHAT_API_BASE", "https://adsapi.snapchat.com/v1"),
  headers: async () => ({ Authorization: `Bearer ${await token.get()}` }),
  hints: { 401: "run `npm run auth:snapchat` again" },
  onUnauthorized: () => token.reset(),
});

type Rec = Record<string, unknown>;
const account = (id?: string) => id ?? requireEnv("SNAPCHAT_AD_ACCOUNT_ID");
const micro = (v: unknown) => round(Number(v ?? 0) / 1_000_000);
const unwrap = (r: Rec, key: string, sub: string) => ((r[key] as Rec[]) ?? []).map((x) => x[sub] as Rec);

/** Snapchat wants ISO times with the ad account's timezone offset, on hour boundaries. */
async function tzOffset(acc: string): Promise<string> {
  const a = unwrap((await snap(`adaccounts/${acc}`)) as Rec, "adaccounts", "adaccount")[0];
  const tz = String(a?.timezone ?? "UTC");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date());
  return (parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT").replace("GMT", "") || "+00:00";
}

const server = new McpServer(
  { name: "snapchat-ads", version: "0.1.0" },
  { instructions: "Snapchat Marketing API: organizations and ad accounts, campaigns (status, budgets), performance stats with swipes, purchases and ROAS, and the Conversions API v3. Spend is converted from micro-currency." },
);

const ACC = z.string().optional().describe("Ad account ID (default SNAPCHAT_AD_ACCOUNT_ID)");

server.registerTool(
  "snapchat_accounts",
  { title: "Organizations & ad accounts", description: "Your organizations with their ad accounts (id, name, currency, timezone, status).", inputSchema: {} },
  () =>
    run(async () => {
      const orgs = unwrap((await snap("me/organizations", { query: { with_ad_accounts: true } })) as Rec, "organizations", "organization");
      return orgs.map((o) => ({ id: o.id, name: o.name, ad_accounts: ((o.ad_accounts as Rec[]) ?? []).map((a) => ({ id: a.id, name: a.name, currency: a.currency, timezone: a.timezone, status: a.status })) }));
    }),
);

server.registerTool(
  "snapchat_report",
  {
    title: "Performance report",
    description: "Impressions, swipes (clicks), spend, video views, purchases, purchase value, sign-ups, CPA and ROAS by campaign, ad squad or ad — total or daily.",
    inputSchema: { account_id: ACC, breakdown: z.enum(["campaign", "adsquad", "ad"]).default("campaign"), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), daily: z.boolean().default(false) },
  },
  (a) =>
    run(async () => {
      const acc = account(a.account_id);
      const w = window(a.preset, a.from, a.to);
      const off = await tzOffset(acc);
      const end = new Date(Date.parse(`${w.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const r = (await snap(`adaccounts/${acc}/stats`, {
        query: { granularity: a.daily ? "DAY" : "TOTAL", breakdown: a.breakdown, fields: "impressions,swipes,spend,video_views,conversion_purchases,conversion_purchases_value,conversion_sign_ups,conversion_add_cart", start_time: `${w.from}T00:00:00${off}`, end_time: `${end}T00:00:00${off}`, swipe_up_attribution_window: "28_DAY", view_attribution_window: "1_DAY" },
      })) as Rec;
      const total = unwrap(r, a.daily ? "timeseries_stats" : "total_stats", a.daily ? "timeseries_stat" : "total_stat")[0] ?? {};
      const list = (((total.breakdown_stats as Rec)?.[a.breakdown] as Rec[]) ?? []);
      const names = new Map<string, string>();
      const ents = (await snap(`adaccounts/${acc}/${a.breakdown === "adsquad" ? "adsquads" : `${a.breakdown}s`}`).catch(() => ({}))) as Rec;
      for (const e of unwrap(ents, `${a.breakdown === "adsquad" ? "adsquads" : `${a.breakdown}s`}`, a.breakdown)) names.set(String(e.id), String(e.name));
      const shape = (id: string, s: Rec, date?: string) => {
        const spend = micro(s.spend);
        const value = micro(s.conversion_purchases_value);
        const conv = Number(s.conversion_purchases ?? 0);
        return { date, id, name: names.get(id), spend, impressions: Number(s.impressions ?? 0), clicks: Number(s.swipes ?? 0), conversions: conv, value, sign_ups: Number(s.conversion_sign_ups ?? 0), cpa: conv ? round(spend / conv) : null, roas: spend ? round(value / spend) : null };
      };
      const rows = a.daily ? list.flatMap((b) => ((b.timeseries as Rec[]) ?? []).map((t) => shape(String(b.id), (t.stats as Rec) ?? {}, String(t.start_time).slice(0, 10)))) : list.map((b) => shape(String(b.id), (b.stats as Rec) ?? {}));
      return { window: w, rows: rows.sort((x, y) => y.spend - x.spend) };
    }),
);

server.registerTool(
  "snapchat_campaigns",
  { title: "Campaigns", description: "List campaigns (status, objective, daily budget, dates); pause/activate; change the daily budget (account currency).", inputSchema: { account_id: ACC, action: z.enum(["list", "set_status", "update_budget"]).default("list"), ids: z.array(z.string()).optional(), status: z.enum(["ACTIVE", "PAUSED"]).optional(), daily_budget: z.number().optional() } },
  (a) =>
    run(async () => {
      const acc = account(a.account_id);
      const all = unwrap((await snap(`adaccounts/${acc}/campaigns`)) as Rec, "campaigns", "campaign");
      if (a.action === "list") return all.map((c) => ({ id: c.id, name: c.name, status: c.status, objective: c.objective, daily_budget: c.daily_budget_micro ? micro(c.daily_budget_micro) : undefined, start: c.start_time, end: c.end_time }));
      if (!a.ids?.length) throw new Error("ids is required");
      // Updates must send the full campaign object.
      const campaigns = all.filter((c) => a.ids!.includes(String(c.id))).map((c) => ({ ...c, ...(a.action === "set_status" ? { status: a.status ?? "PAUSED" } : {}), ...(a.daily_budget !== undefined ? { daily_budget_micro: Math.round(a.daily_budget * 1e6) } : {}) }));
      return snap(`adaccounts/${acc}/campaigns`, { method: "PUT", body: { campaigns } });
    }),
);

server.registerTool(
  "snapchat_conversions",
  {
    title: "Conversions API",
    description: "Send server/offline events (PURCHASE, SIGN_UP, ADD_CART, PAGE_VIEW, CUSTOM_EVENT_1…) to a Snap Pixel with hashed email/phone, click ID, value and event_id for dedup. Validate first with test: true; real sends need confirm.",
    inputSchema: {
      pixel_id: z.string().optional().describe("Default SNAPCHAT_PIXEL_ID"),
      events: z.array(z.object({ event_name: z.string(), time: z.string().optional(), event_id: z.string().optional(), action_source: z.enum(["WEB", "MOBILE_APP", "OFFLINE"]).default("WEB"), email: z.string().optional(), phone: z.string().optional(), click_id: z.string().optional().describe("ScCid"), value: z.number().optional(), currency: z.string().optional(), order_id: z.string().optional(), url: z.string().optional() })).min(1).max(2000),
      test: z.boolean().default(true),
      confirm: z.boolean().default(false),
    },
  },
  (a) =>
    run(async () => {
      if (!a.test && !a.confirm) throw new Error("Real conversions change reporting and bidding; pass test: false with confirm: true");
      const pixel = a.pixel_id ?? requireEnv("SNAPCHAT_PIXEL_ID");
      const data = await Promise.all(a.events.map(async (e) => ({ event_name: e.event_name, action_source: e.action_source, event_time: Math.floor(Date.parse(e.time ?? new Date().toISOString()) / 1000), event_id: e.event_id, event_source_url: e.url, user_data: { em: e.email ? [await sha256(e.email, "email")] : undefined, ph: e.phone ? [await sha256(e.phone, "phone")] : undefined, sc_click_id: e.click_id }, custom_data: { currency: e.currency, value: e.value, order_id: e.order_id } })));
      const tok = optionalEnv("SNAPCHAT_CAPI_TOKEN") || (await token.get());
      const url = `https://tr.snapchat.com/v3/${pixel}/events${a.test ? "/validate" : ""}?access_token=${encodeURIComponent(tok)}`;
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) });
      const text = await res.text();
      if (!res.ok) throw new Error(`Snapchat CAPI ${res.status}: ${text.slice(0, 300)}`);
      return { sent: data.length, test: a.test, response: text ? JSON.parse(text) : {} };
    }),
);

server.registerTool(
  "snapchat_api",
  { title: "Snapchat API call", description: "Call any Snapchat Marketing API v1 endpoint (e.g. adaccounts/{id}/segments, adsquads/{id}, creatives, targeting/geo/country).", inputSchema: { method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method === "DELETE" && !a.confirm) throw new Error("DELETE calls need confirm: true");
      return snap(a.path.replace("{account}", account()), { method: a.method, query: a.query, body: a.body });
    }),
);

await startStdio(server, "snapchat-ads");
