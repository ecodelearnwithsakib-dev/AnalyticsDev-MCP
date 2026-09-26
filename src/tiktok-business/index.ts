#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { PRESETS, round, window } from "../shared/hub.js";
import { restClient, sha256 } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/**
 * TikTok Business API v1.3 with a long-lived access token (TikTok for Business developer app, or the
 * Events Manager token for events only). Complements TikTok's official remote MCP with server-side
 * events, reporting for the ads hub and campaign status.
 */
const api = restClient({
  name: "TikTok",
  base: () => optionalEnv("TIKTOK_API_BASE", "https://business-api.tiktok.com/open_api/v1.3"),
  headers: () => ({ "Access-Token": requireEnv("TIKTOK_ACCESS_TOKEN") }),
  arrayFormat: "comma",
});

type Rec = Record<string, unknown>;
/** TikTok returns HTTP 200 with { code, message, data }; code 0 = OK. */
async function tt<T = Rec>(path: string, o: Parameters<typeof api>[1] = {}): Promise<T> {
  const r = (await api(path, o)) as { code?: number; message?: string; data?: T; request_id?: string };
  if (r.code !== undefined && r.code !== 0) throw new Error(`TikTok ${r.code}: ${r.message}${r.code === 40001 || r.code === 40105 ? " — check TIKTOK_ACCESS_TOKEN" : ""}`);
  return (r.data ?? r) as T;
}
const advertiser = (id?: string) => id ?? requireEnv("TIKTOK_ADVERTISER_ID");

const server = new McpServer(
  { name: "tiktok-business", version: "0.1.0" },
  { instructions: "TikTok Business API: Events API (server-side conversions with hashed identifiers and ttclid, test codes), campaign performance reports, campaign status and budgets. For everything else TikTok offers, use TikTok's official remote MCP alongside this server." },
);

const ADV = z.string().optional().describe("Advertiser ID (default TIKTOK_ADVERTISER_ID)");

server.registerTool(
  "tiktok_events",
  {
    title: "Events API",
    description: "Send server-side events (CompletePayment, PlaceAnOrder, SubmitForm, CompleteRegistration, AddToCart, Contact, custom…) for web (pixel code), offline (offline event set) or CRM with hashed email/phone, ttclid, external_id, value and event_id for dedup with the pixel. Use test_event_code first; real sends need confirm.",
    inputSchema: {
      source: z.enum(["web", "offline", "crm"]).default("web"),
      source_id: z.string().optional().describe("Pixel code / offline event set / CRM event set ID (default TIKTOK_PIXEL_CODE)"),
      test_event_code: z.string().optional(),
      events: z.array(z.object({ event: z.string(), time: z.string().optional(), event_id: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), external_id: z.string().optional(), ttclid: z.string().optional(), ip: z.string().optional(), user_agent: z.string().optional(), url: z.string().optional(), value: z.number().optional(), currency: z.string().optional(), order_id: z.string().optional(), content_ids: z.array(z.string()).optional() })).min(1).max(1000),
      confirm: z.boolean().default(false),
    },
  },
  (a) =>
    run(async () => {
      if (!a.test_event_code && !a.confirm) throw new Error("Real events affect reporting and optimisation — pass test_event_code to validate, or confirm: true to send");
      const data = await Promise.all(
        a.events.map(async (e) => ({
          event: e.event,
          event_time: Math.floor(Date.parse(e.time ?? new Date().toISOString()) / 1000),
          event_id: e.event_id,
          user: { email: e.email ? await sha256(e.email, "email") : undefined, phone: e.phone ? await sha256(e.phone, "phone") : undefined, external_id: e.external_id ? await sha256(e.external_id) : undefined, ttclid: e.ttclid, ip: e.ip, user_agent: e.user_agent },
          properties: { value: e.value, currency: e.currency, order_id: e.order_id, contents: e.content_ids?.map((id) => ({ content_id: id })) },
          page: e.url ? { url: e.url } : undefined,
        })),
      );
      return tt("event/track/", { body: { event_source: a.source, event_source_id: a.source_id ?? requireEnv("TIKTOK_PIXEL_CODE"), test_event_code: a.test_event_code, data } });
    }),
);

server.registerTool(
  "tiktok_report",
  {
    title: "Campaign report",
    description: "Spend, impressions, clicks, CTR, CPC, conversions, cost per conversion, complete-payment value and ROAS by campaign (or ad group / ad), total or daily.",
    inputSchema: { advertiser_id: ADV, level: z.enum(["campaign", "adgroup", "ad"]).default("campaign"), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), daily: z.boolean().default(false) },
  },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const idDim = `${a.level}_id`;
      const rows: Rec[] = [];
      for (let page = 1; ; page++) {
        const r = await tt<{ list?: Rec[]; page_info?: { total_page?: number } }>("report/integrated/get/", {
          query: {
            advertiser_id: advertiser(a.advertiser_id),
            report_type: "BASIC",
            data_level: `AUCTION_${a.level.toUpperCase()}`,
            dimensions: JSON.stringify(a.daily ? [idDim, "stat_time_day"] : [idDim]),
            metrics: JSON.stringify([`${a.level}_name`, "spend", "impressions", "clicks", "ctr", "cpc", "conversion", "cost_per_conversion", "complete_payment", "total_complete_payment_rate", "complete_payment_roas", "currency"]),
            start_date: w.from,
            end_date: w.to,
            page,
            page_size: 1000,
          },
        });
        rows.push(...(r.list ?? []));
        if (page >= (r.page_info?.total_page ?? 1)) break;
      }
      return {
        window: w,
        rows: rows
          .map((x) => {
            const d = (x.dimensions ?? {}) as Rec;
            const m = (x.metrics ?? {}) as Rec;
            const spend = Number(m.spend ?? 0);
            const roas = Number(m.complete_payment_roas ?? 0);
            return { date: d.stat_time_day ? String(d.stat_time_day).slice(0, 10) : undefined, id: String(d[idDim]), name: m[`${a.level}_name`], spend: round(spend), impressions: Number(m.impressions ?? 0), clicks: Number(m.clicks ?? 0), conversions: Number(m.conversion ?? 0), purchases: Number(m.complete_payment ?? 0), value: round(spend * roas), roas: roas || null, cpa: Number(m.cost_per_conversion) || null, currency: m.currency };
          })
          .sort((p, q) => q.spend - p.spend),
      };
    }),
);

server.registerTool(
  "tiktok_campaigns",
  { title: "Campaigns", description: "List campaigns (status, objective, budget mode and amount); enable/disable (pause) them; change budgets.", inputSchema: { advertiser_id: ADV, action: z.enum(["list", "set_status", "update_budget"]).default("list"), ids: z.array(z.string()).optional(), status: z.enum(["ENABLE", "DISABLE"]).optional(), budget: z.number().optional() } },
  (a) =>
    run(async () => {
      const adv = advertiser(a.advertiser_id);
      if (a.action === "list") {
        const r = await tt<{ list?: Rec[] }>("campaign/get/", { query: { advertiser_id: adv, page_size: 1000 } });
        return (r.list ?? []).map((c) => ({ id: c.campaign_id, name: c.campaign_name, status: c.operation_status ?? c.secondary_status, objective: c.objective_type, budget_mode: c.budget_mode, budget: c.budget }));
      }
      if (!a.ids?.length) throw new Error("ids is required");
      if (a.action === "set_status") return tt("campaign/status/update/", { body: { advertiser_id: adv, campaign_ids: a.ids, operation_status: a.status ?? "DISABLE" } });
      const out = [];
      for (const id of a.ids) out.push(await tt("campaign/update/", { body: { advertiser_id: adv, campaign_id: id, budget: a.budget } }));
      return out;
    }),
);

server.registerTool(
  "tiktok_api",
  { title: "TikTok Business API call", description: "Call any TikTok Business API v1.3 endpoint (e.g. adgroup/get/, ad/get/, pixel/list/, dmp/custom_audience/list/). GET params go in query (arrays JSON-encoded), POST params in body.", inputSchema: { method: z.enum(["GET", "POST"]).default("GET"), path: z.string(), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional() } },
  (a) => run(() => tt(a.path, { method: a.method, query: a.query, body: a.body })),
);

await startStdio(server, "tiktok-business");
