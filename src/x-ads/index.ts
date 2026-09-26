#!/usr/bin/env node
import { createHmac, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { addDays, PRESETS, round, window } from "../shared/hub.js";
import { errorMessage, sha256 } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/** X Ads API v12 with OAuth 1.0a user-context signing (consumer key/secret + access token/secret). */
const base = () => optionalEnv("X_ADS_API_BASE", "https://ads-api.x.com/12");
const pctEnc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function oauthHeader(method: string, url: URL, bodyParams: Record<string, string> = {}): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: requireEnv("X_CONSUMER_KEY"),
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: requireEnv("X_ACCESS_TOKEN"),
    oauth_version: "1.0",
  };
  const params = [...url.searchParams.entries(), ...Object.entries(bodyParams), ...Object.entries(oauth)].map(([k, v]) => [pctEnc(k), pctEnc(v)]).sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1));
  const baseString = [method.toUpperCase(), pctEnc(`${url.origin}${url.pathname}`), pctEnc(params.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  const key = `${pctEnc(requireEnv("X_CONSUMER_SECRET"))}&${pctEnc(requireEnv("X_ACCESS_TOKEN_SECRET"))}`;
  oauth.oauth_signature = createHmac("sha1", key).update(baseString).digest("base64");
  return `OAuth ${Object.entries(oauth).map(([k, v]) => `${pctEnc(k)}="${pctEnc(v)}"`).join(", ")}`;
}

type Rec = Record<string, unknown>;
async function x<T = Rec>(method: string, path: string, query: Record<string, string | number | undefined> = {}, json?: unknown): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${base()}/${path.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers: { Authorization: oauthHeader(method, url), Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
    if (res.status === 429 && attempt < 3) {
      const reset = Number(res.headers.get("x-rate-limit-reset") ?? 0) * 1000 - Date.now();
      await new Promise((r) => setTimeout(r, Math.min(Math.max(reset, 2000), 60_000)));
      continue;
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`X Ads ${res.status}: ${errorMessage(data, text)}${res.status === 403 ? " — the app needs approved Ads API access and the user access to this account" : ""}`);
    return data as T;
  }
}

const account = (id?: string) => id ?? requireEnv("X_ADS_ACCOUNT_ID");
const micro = (v: unknown) => round((Array.isArray(v) ? v.reduce((s: number, n) => s + (Number(n) || 0), 0) : Number(v ?? 0)) / 1_000_000);
const sum = (v: unknown) => (Array.isArray(v) ? v.reduce((s: number, n) => s + (Number(n) || 0), 0) : Number(v ?? 0));

const server = new McpServer(
  { name: "x-ads", version: "0.1.0" },
  { instructions: "X (Twitter) Ads API v12: ad accounts, campaigns and line items (status, budgets), performance stats (impressions, engagements, clicks, spend, conversions) and the Conversions API. Stats windows are up to 7 days per request and are split automatically. Spend is converted from micro-currency." },
);

const ACC = z.string().optional().describe("Ads account ID (default X_ADS_ACCOUNT_ID)");

server.registerTool(
  "x_accounts",
  { title: "Ads accounts", description: "Ads accounts the signed-in user can access (id, name, timezone, currency via funding instruments).", inputSchema: {} },
  () => run(async () => ((await x<{ data?: Rec[] }>("GET", "accounts", { count: 200 })).data ?? []).map((a) => ({ id: a.id, name: a.name, timezone: a.timezone, approval: a.approval_status, deleted: a.deleted }))),
);

server.registerTool(
  "x_report",
  {
    title: "Performance report",
    description: "Impressions, engagements, clicks, spend, website conversions (purchases, sign-ups) and conversion value by campaign or line item for a period, CPA and ROAS included. Longer periods are fetched in 7-day chunks.",
    inputSchema: { account_id: ACC, entity: z.enum(["CAMPAIGN", "LINE_ITEM", "PROMOTED_TWEET"]).default("CAMPAIGN"), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional() },
  },
  (a) =>
    run(async () => {
      const acc = account(a.account_id);
      const w = window(a.preset, a.from, a.to);
      const list = a.entity === "CAMPAIGN" ? "campaigns" : a.entity === "LINE_ITEM" ? "line_items" : "promoted_tweets";
      const ents = (await x<{ data?: Rec[] }>("GET", `accounts/${acc}/${list}`, { count: 1000, with_deleted: "false" })).data ?? [];
      const totals = new Map<string, { spend: number; impressions: number; clicks: number; engagements: number; conversions: number; value: number }>();
      for (let start = w.from; start <= w.to; start = addDays(start, 7)) {
        const end = addDays(start, 7) > addDays(w.to, 1) ? addDays(w.to, 1) : addDays(start, 7);
        for (let i = 0; i < ents.length; i += 20) {
          const ids = ents.slice(i, i + 20).map((e) => String(e.id));
          if (!ids.length) break;
          const r = await x<{ data?: { id: string; id_data?: { metrics: Rec }[] }[] }>("GET", `stats/accounts/${acc}`, { entity: a.entity, entity_ids: ids.join(","), start_time: `${start}T00:00:00Z`, end_time: `${end}T00:00:00Z`, granularity: "TOTAL", placement: "ALL_ON_TWITTER", metric_groups: "ENGAGEMENT,BILLING,WEB_CONVERSION" });
          for (const d of r.data ?? []) {
            const m = d.id_data?.[0]?.metrics ?? {};
            const conv = (m.conversion_purchases as Rec) ?? {};
            const t = totals.get(d.id) ?? { spend: 0, impressions: 0, clicks: 0, engagements: 0, conversions: 0, value: 0 };
            t.spend += micro(m.billed_charge_local_micro);
            t.impressions += sum(m.impressions);
            t.clicks += sum(m.clicks ?? m.url_clicks);
            t.engagements += sum(m.engagements);
            t.conversions += sum(conv.metric);
            t.value += micro(conv.sale_amount);
            totals.set(d.id, t);
          }
        }
      }
      const byId = new Map(ents.map((e) => [String(e.id), e]));
      return {
        window: w,
        rows: [...totals]
          .map(([id, t]) => ({ id, name: byId.get(id)?.name, status: byId.get(id)?.entity_status, ...t, spend: round(t.spend), value: round(t.value), cpa: t.conversions ? round(t.spend / t.conversions) : null, roas: t.spend ? round(t.value / t.spend) : null }))
          .sort((p, q) => q.spend - p.spend),
      };
    }),
);

server.registerTool(
  "x_campaigns",
  { title: "Campaigns", description: "List campaigns (status, daily/total budget, dates) and pause/activate them or change the daily budget (account currency).", inputSchema: { account_id: ACC, action: z.enum(["list", "set_status", "update_budget"]).default("list"), ids: z.array(z.string()).optional(), status: z.enum(["ACTIVE", "PAUSED"]).optional(), daily_budget: z.number().optional() } },
  (a) =>
    run(async () => {
      const acc = account(a.account_id);
      if (a.action === "list") return ((await x<{ data?: Rec[] }>("GET", `accounts/${acc}/campaigns`, { count: 1000 })).data ?? []).map((c) => ({ id: c.id, name: c.name, status: c.entity_status, daily_budget: c.daily_budget_amount_local_micro ? micro(c.daily_budget_amount_local_micro) : undefined, total_budget: c.total_budget_amount_local_micro ? micro(c.total_budget_amount_local_micro) : undefined, start: c.start_time, end: c.end_time }));
      if (!a.ids?.length) throw new Error("ids is required");
      const out = [];
      for (const id of a.ids) out.push((await x("PUT", `accounts/${acc}/campaigns/${id}`, { ...(a.action === "set_status" ? { entity_status: a.status ?? "PAUSED" } : {}), ...(a.daily_budget !== undefined ? { daily_budget_amount_local_micro: Math.round(a.daily_budget * 1e6) } : {}) })).data);
      return out;
    }),
);

server.registerTool(
  "x_conversions",
  {
    title: "Conversions API",
    description: "Send web/offline conversions to an X Pixel event (event ID from Events Manager) with hashed email/phone or twclid, value and conversion_id for dedup. Needs confirm.",
    inputSchema: { pixel_event_id: z.string().describe("The tw-xxxxx-yyyyy event ID"), events: z.array(z.object({ time: z.string(), conversion_id: z.string(), email: z.string().optional(), phone: z.string().optional(), twclid: z.string().optional(), value: z.number().optional(), currency: z.string().optional(), number_items: z.number().optional() })).min(1).max(500), confirm: z.boolean().default(false) },
  },
  (a) =>
    run(async () => {
      if (!a.confirm) return { preview: true, would_send: a.events.length };
      const conversions = await Promise.all(a.events.map(async (e) => ({ conversion_time: new Date(e.time).toISOString(), event_id: a.pixel_event_id, conversion_id: e.conversion_id, identifiers: [...(e.twclid ? [{ twclid: e.twclid }] : []), ...(e.email ? [{ hashed_email: await sha256(e.email, "email") }] : []), ...(e.phone ? [{ hashed_phone_number: await sha256(e.phone, "phone") }] : [])], value: e.value !== undefined ? String(e.value) : undefined, price_currency: e.currency, number_items: e.number_items })));
      return x("POST", `measurement/conversions/${a.pixel_event_id.split("-")[1] ?? a.pixel_event_id}`, {}, { conversions });
    }),
);

server.registerTool(
  "x_api",
  { title: "X Ads API call", description: "Call any X Ads API v12 endpoint (e.g. accounts/{account}/line_items, accounts/{account}/tailored_audiences, targeting_criteria/locations). Query params are signed automatically.", inputSchema: { method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.union([z.string(), z.number()])).optional(), body: z.unknown().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method === "DELETE" && !a.confirm) throw new Error("DELETE calls need confirm: true");
      return x(a.method, a.path.replace("{account}", account()), a.query, a.body);
    }),
);

await startStdio(server, "x-ads");
