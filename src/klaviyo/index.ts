#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { PRESETS, window } from "../shared/hub.js";
import { restClient } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/** Klaviyo JSON:API with a private API key. */
const api = restClient({
  name: "Klaviyo",
  base: () => optionalEnv("KLAVIYO_API_BASE", "https://a.klaviyo.com/api"),
  headers: () => ({ Authorization: `Klaviyo-API-Key ${requireEnv("KLAVIYO_API_KEY")}`, revision: optionalEnv("KLAVIYO_REVISION", "2026-07-15"), Accept: "application/vnd.api+json", "Content-Type": "application/vnd.api+json" }),
  hints: { 401: "check KLAVIYO_API_KEY (private key, starts with pk_)", 403: "the private key is missing a scope (campaigns:read, flows:read, metrics:read, profiles:write…)" },
});

type Rec = Record<string, unknown>;
type Doc = { id: string; type: string; attributes: Rec };
const attrs = (d: Doc) => ({ id: d.id, ...d.attributes });
async function list(path: string, query: Record<string, string | number | undefined>, max: number): Promise<Doc[]> {
  const out: Doc[] = [];
  let url: string | undefined = path;
  let first = true;
  while (url && out.length < max) {
    const r = (await api(url, first ? { query } : {})) as { data: Doc[]; links?: { next?: string } };
    out.push(...r.data);
    url = r.links?.next?.replace(/^https:\/\/a\.klaviyo\.com\/api\//, "");
    first = false;
  }
  return out.slice(0, max);
}
let conversionMetric: string | undefined;
async function placedOrderMetric() {
  if (conversionMetric) return conversionMetric;
  const env = optionalEnv("KLAVIYO_CONVERSION_METRIC_ID", "");
  if (env) return (conversionMetric = env);
  const m = (await list("metrics", {}, 500)).find((x) => /placed order/i.test(String(x.attributes.name)));
  if (!m) throw new Error("No 'Placed Order' metric found — set KLAVIYO_CONVERSION_METRIC_ID");
  return (conversionMetric = m.id);
}
const STATS = ["recipients", "delivered", "opens_unique", "open_rate", "clicks_unique", "click_rate", "conversions", "conversion_value", "conversion_rate", "revenue_per_recipient", "unsubscribes", "unsubscribe_rate", "bounced", "spam_complaints"];

const server = new McpServer(
  { name: "klaviyo", version: "0.1.0" },
  { instructions: "Klaviyo email/SMS: campaign and flow performance with attributed revenue, metrics (events) over time, lists and segments, profiles (create/update, subscribe needs confirm), server-side events (confirm) and raw API. Klaviyo's official remote MCP can be used alongside." },
);

server.registerTool(
  "klaviyo_account",
  { title: "Account", description: "Account name, currency, timezone and public key.", inputSchema: {} },
  () => run(async () => ((await api("accounts")) as { data: Doc[] }).data.map((d) => ({ id: d.id, ...(d.attributes.contact_information as Rec), currency: d.attributes.preferred_currency, timezone: d.attributes.timezone, public_api_key: d.attributes.public_api_key }))),
);

server.registerTool(
  "klaviyo_performance",
  {
    title: "Campaign & flow performance",
    description: "Recipients, opens, clicks, conversions, attributed revenue, revenue per recipient and unsubscribes for campaigns or flows in a period (grouped per campaign / flow), using the Placed Order metric by default.",
    inputSchema: { type: z.enum(["campaign", "flow"]).default("campaign"), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), channel: z.enum(["email", "sms", "all"]).default("email"), conversion_metric_id: z.string().optional() },
  },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const r = (await api(`${a.type}-values-reports`, {
        body: { data: { type: `${a.type}-values-report`, attributes: { statistics: STATS, timeframe: { start: `${w.from}T00:00:00Z`, end: `${w.to}T23:59:59Z` }, conversion_metric_id: a.conversion_metric_id ?? (await placedOrderMetric()), filter: a.channel === "all" ? undefined : `equals(send_channel,"${a.channel}")` } } },
      })) as { data: { attributes: { results: { groupings: Rec; statistics: Rec }[] } } };
      const idKey = a.type === "campaign" ? "campaign_id" : "flow_id";
      const ids = [...new Set(r.data.attributes.results.map((x) => String(x.groupings[idKey])))];
      const names: Record<string, string> = {};
      await Promise.all(ids.slice(0, 100).map(async (id) => (names[id] = String((((await api(`${a.type}s/${id}`).catch(() => ({ data: { attributes: {} } }))) as { data: Doc }).data.attributes.name) ?? id))));
      const agg: Record<string, Rec> = {};
      for (const row of r.data.attributes.results) {
        const id = String(row.groupings[idKey]);
        const cur = (agg[id] ??= { id, name: names[id], channel: row.groupings.send_channel });
        for (const [k, v] of Object.entries(row.statistics)) if (!k.endsWith("_rate") && k !== "revenue_per_recipient") cur[k] = Number(cur[k] ?? 0) + Number(v ?? 0);
      }
      const rows: Rec[] = Object.values(agg).map((x) => {
        const rec = Number(x.recipients ?? 0) || Number(x.delivered ?? 0);
        return { ...x, open_rate: rec ? Math.round((Number(x.opens_unique ?? 0) / rec) * 1000) / 10 : null, click_rate: rec ? Math.round((Number(x.clicks_unique ?? 0) / rec) * 1000) / 10 : null, revenue_per_recipient: rec ? Math.round((Number(x.conversion_value ?? 0) / rec) * 100) / 100 : null };
      });
      return { window: w, rows: rows.sort((p, q) => Number(q.conversion_value ?? 0) - Number(p.conversion_value ?? 0)), total_revenue: Math.round(rows.reduce((s, x) => s + Number(x.conversion_value ?? 0), 0) * 100) / 100 };
    }),
);

server.registerTool(
  "klaviyo_campaigns",
  { title: "Campaigns & flows", description: "List campaigns (email/SMS, with status and send time) or flows (with status and trigger).", inputSchema: { type: z.enum(["campaigns", "flows"]).default("campaigns"), channel: z.enum(["email", "sms"]).default("email"), limit: z.number().int().min(1).max(500).default(50) } },
  (a) => run(async () => (await list(a.type, a.type === "campaigns" ? { filter: `equals(messages.channel,'${a.channel}')`, sort: "-created_at" } : { sort: "-updated" }, a.limit)).map((d) => ({ id: d.id, name: d.attributes.name, status: d.attributes.status, send_time: d.attributes.send_time ?? undefined, trigger: d.attributes.trigger_type ?? undefined, updated: d.attributes.updated_at ?? d.attributes.updated }))),
);

server.registerTool(
  "klaviyo_metrics",
  { title: "Metrics over time", description: "List metrics (events such as Placed Order, Viewed Product, Opened Email), or aggregate one metric over time (count, unique, sum_value) with optional grouping by a dimension ($attributed_flow, $attributed_message, $message_send_cohort, Campaign Name…).", inputSchema: { metric_id: z.string().optional(), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), measurements: z.array(z.enum(["count", "unique", "sum_value"])).default(["count", "sum_value"]), interval: z.enum(["day", "week", "month"]).default("day"), by: z.array(z.string()).optional() } },
  (a) =>
    run(async () => {
      if (!a.metric_id) return (await list("metrics", {}, 500)).map((m) => ({ id: m.id, name: m.attributes.name, integration: (m.attributes.integration as Rec)?.name }));
      const w = window(a.preset, a.from, a.to);
      const r = (await api("metric-aggregates", { body: { data: { type: "metric-aggregate", attributes: { metric_id: a.metric_id, measurements: a.measurements, interval: a.interval, by: a.by, filter: [`greater-or-equal(datetime,${w.from}T00:00:00)`, `less-than(datetime,${w.to}T23:59:59)`], timezone: optionalEnv("KLAVIYO_TIMEZONE", "UTC") } } } })) as { data: { attributes: { dates: string[]; data: { dimensions: string[]; measurements: Record<string, number[]> }[] } } };
      const at = r.data.attributes;
      return { window: w, dates: at.dates.map((d) => d.slice(0, 10)), series: at.data.map((s) => ({ dimensions: s.dimensions, totals: Object.fromEntries(Object.entries(s.measurements).map(([k, v]) => [k, Math.round(v.reduce((x, y) => x + y, 0) * 100) / 100])), values: s.measurements })) };
    }),
);

server.registerTool(
  "klaviyo_audiences",
  { title: "Lists & segments", description: "List lists or segments with profile counts.", inputSchema: { type: z.enum(["lists", "segments"]).default("lists"), limit: z.number().int().min(1).max(500).default(100) } },
  (a) => run(async () => (await list(a.type, { "additional-fields[list]": a.type === "lists" ? "profile_count" : undefined, "additional-fields[segment]": a.type === "segments" ? "profile_count" : undefined }, a.limit)).map((d) => ({ id: d.id, name: d.attributes.name, profiles: d.attributes.profile_count, created: d.attributes.created, updated: d.attributes.updated }))),
);

server.registerTool(
  "klaviyo_profiles",
  {
    title: "Profiles",
    description: "Find a profile by email/phone/ID; create or update a profile's properties; or subscribe profiles to email/SMS marketing on a list (confirm — only with the person's consent).",
    inputSchema: { action: z.enum(["find", "upsert", "subscribe"]).default("find"), email: z.string().optional(), phone: z.string().optional(), id: z.string().optional(), properties: z.record(z.unknown()).optional(), first_name: z.string().optional(), last_name: z.string().optional(), list_id: z.string().optional(), channels: z.array(z.enum(["email", "sms"])).default(["email"]), confirm: z.boolean().default(false) },
  },
  (a) =>
    run(async () => {
      if (a.action === "find") {
        if (a.id) return attrs(((await api(`profiles/${a.id}`)) as { data: Doc }).data);
        const f = a.email ? `equals(email,"${a.email}")` : a.phone ? `equals(phone_number,"${a.phone}")` : undefined;
        if (!f) throw new Error("email, phone or id is required");
        return (await list("profiles", { filter: f }, 5)).map(attrs);
      }
      if (a.action === "upsert") return attrs(((await api("profile-import", { body: { data: { type: "profile", attributes: { email: a.email, phone_number: a.phone, first_name: a.first_name, last_name: a.last_name, properties: a.properties } } } })) as { data: Doc }).data);
      if (!a.list_id) throw new Error("list_id is required");
      if (!a.confirm) throw new Error("Subscribing sends marketing to this person — only with their consent; set confirm: true");
      const subs: Rec = {};
      if (a.channels.includes("email")) subs.email = { marketing: { consent: "SUBSCRIBED" } };
      if (a.channels.includes("sms")) subs.sms = { marketing: { consent: "SUBSCRIBED" } };
      await api("profile-subscription-bulk-create-jobs", { body: { data: { type: "profile-subscription-bulk-create-job", attributes: { profiles: { data: [{ type: "profile", attributes: { email: a.email, phone_number: a.phone, subscriptions: subs } }] } }, relationships: { list: { data: { type: "list", id: a.list_id } } } } } });
      return { subscribed: a.email ?? a.phone, list: a.list_id };
    }),
);

server.registerTool(
  "klaviyo_events",
  { title: "Send events", description: "Send server-side events (e.g. Placed Order from a backend, Lead Qualified from a CRM) to trigger flows and attribute revenue. Needs confirm.", inputSchema: { events: z.array(z.object({ metric: z.string(), email: z.string().optional(), phone: z.string().optional(), value: z.number().optional(), unique_id: z.string().optional(), time: z.string().optional(), properties: z.record(z.unknown()).optional() })).min(1).max(100), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (!a.confirm) throw new Error("Events can trigger flows (emails/SMS) immediately; set confirm: true");
      const out = [];
      for (const e of a.events) {
        await api("events", { body: { data: { type: "event", attributes: { properties: e.properties ?? {}, value: e.value, unique_id: e.unique_id, time: e.time, metric: { data: { type: "metric", attributes: { name: e.metric } } }, profile: { data: { type: "profile", attributes: { email: e.email, phone_number: e.phone } } } } } } });
        out.push({ sent: e.metric, to: e.email ?? e.phone });
      }
      return out;
    }),
);

server.registerTool(
  "klaviyo_api",
  { title: "Klaviyo API call", description: "Call any Klaviyo API endpoint (templates, catalogs, coupons, reviews, tags…). Writes need confirm.", inputSchema: { method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method !== "GET" && !/-reports$|metric-aggregates$/.test(a.path) && !a.confirm) throw new Error("Write calls change Klaviyo; set confirm: true");
      return api(a.path.replace(/^\/?(api\/)?/, ""), { method: a.method, query: a.query, body: a.body });
    }),
);

await startStdio(server, "klaviyo");
