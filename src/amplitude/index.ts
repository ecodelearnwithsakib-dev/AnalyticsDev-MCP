#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { PRESETS, window } from "../shared/hub.js";
import { restClient } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/** Amplitude Dashboard REST, Export and HTTP V2 APIs with a project API key + secret key (US or EU). */
const eu = () => optionalEnv("AMPLITUDE_REGION", "us").toLowerCase() === "eu";
const base = () => (eu() ? "https://analytics.eu.amplitude.com" : "https://amplitude.com");
const api = restClient({
  name: "Amplitude",
  base,
  headers: () => ({ Authorization: `Basic ${Buffer.from(`${requireEnv("AMPLITUDE_API_KEY")}:${requireEnv("AMPLITUDE_SECRET_KEY")}`).toString("base64")}` }),
  arrayFormat: "repeat",
  hints: { 401: "check AMPLITUDE_API_KEY / AMPLITUDE_SECRET_KEY and AMPLITUDE_REGION" },
});
const ymd = (d: string) => d.replace(/-/g, "");

type Rec = Record<string, unknown>;
const ev = (e: string, filters?: Rec[], groupBy?: string) => JSON.stringify({ event_type: e, filters, group_by: groupBy ? [{ type: groupBy.startsWith("gp:") || groupBy.startsWith("user.") ? "user" : "event", value: groupBy.replace(/^user\./, "") }] : undefined });

const server = new McpServer(
  { name: "amplitude", version: "0.1.0" },
  { instructions: "Amplitude: event segmentation (totals/uniques/sums by day with group-by), funnels, retention, active/new users, revenue (LTV), saved charts, user search and activity, raw export and server-side event upload (confirm). Amplitude's official MCP can be used alongside." },
);

server.registerTool(
  "amp_events",
  { title: "Event types", description: "All event types with this week's totals.", inputSchema: {} },
  () => run(async () => ((await api("api/2/events/list")) as { data: Rec[] }).data.map((e) => ({ name: e.name, totals: e.totals, hidden: e.hidden || undefined })).sort((x, y) => Number(y.totals) - Number(x.totals))),
);

server.registerTool(
  "amp_segmentation",
  { title: "Event segmentation", description: "Event totals, uniques, average, property sum (e.g. revenue) per day/week/month, optionally grouped by a property (event property name, or user.country / gp:plan for user properties).", inputSchema: { event: z.string(), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), metric: z.enum(["totals", "uniques", "avg", "pct_dau", "sums"]).default("totals"), sum_property: z.string().optional(), group_by: z.string().optional(), interval: z.enum(["1", "7", "30"]).default("1"), limit: z.number().int().min(1).max(1000).default(50) } },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const e = JSON.parse(ev(a.event, undefined, a.group_by));
      if (a.sum_property) e.group_by = e.group_by ?? undefined;
      const r = (await api("api/2/events/segmentation", { query: { e: JSON.stringify(a.metric === "sums" ? { ...e, sum_property: a.sum_property } : e), start: ymd(w.from), end: ymd(w.to), m: a.metric, i: a.interval, limit: a.limit } })) as { data: { series: number[][]; seriesLabels: unknown[]; xValues: string[]; seriesCollapsed?: { value: number }[][] } };
      const d = r.data;
      return { window: w, dates: d.xValues, series: d.seriesLabels.map((l, i) => ({ label: Array.isArray(l) ? l[1] ?? l[0] : l, total: d.seriesCollapsed?.[i]?.[0]?.value ?? d.series[i].reduce((s, n) => s + n, 0), values: d.series[i] })) };
    }),
);

server.registerTool(
  "amp_funnel",
  { title: "Funnel", description: "Ordered funnel conversion across events (conversion window in days) with users at each step.", inputSchema: { steps: z.array(z.string()).min(2).max(10), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), window_days: z.number().int().min(1).max(365).default(30), group_by: z.string().optional() } },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const r = (await api("api/2/funnels", { query: { e: a.steps.map((s) => ev(s)), start: ymd(w.from), end: ymd(w.to), cs: a.window_days * 86400, mode: "ordered", ...(a.group_by ? { g: a.group_by } : {}) } })) as { data: { groupValue?: unknown; events: string[]; cumulativeRaw: number[]; medianTransTimes?: number[] }[] };
      return r.data.map((g) => ({ group: g.groupValue, steps: g.events.map((e, i) => ({ step: i + 1, event: e, users: g.cumulativeRaw[i], conversion_from_prev: i ? Math.round((g.cumulativeRaw[i] / Math.max(1, g.cumulativeRaw[i - 1])) * 1000) / 10 : 100, overall: Math.round((g.cumulativeRaw[i] / Math.max(1, g.cumulativeRaw[0])) * 1000) / 10, median_time_ms: g.medianTransTimes?.[i] })) }));
    }),
);

server.registerTool(
  "amp_retention",
  { title: "Retention", description: "N-day retention for users who did a starting event and returned with a returning event (any active event by default).", inputSchema: { start_event: z.string().default("_new"), return_event: z.string().default("_active"), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), mode: z.enum(["n-day", "rolling", "bracket"]).default("n-day") } },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      return api("api/2/retention", { query: { se: ev(a.start_event), re: ev(a.return_event), start: ymd(w.from), end: ymd(w.to), rm: a.mode === "n-day" ? undefined : a.mode } });
    }),
);

server.registerTool(
  "amp_users",
  { title: "Active & new users", description: "Daily/weekly/monthly active or new users over a period, plus revenue LTV if you track revenue.", inputSchema: { metric: z.enum(["active", "new", "revenue_ltv"]).default("active"), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), interval: z.enum(["1", "7", "30"]).default("1") } },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      if (a.metric === "revenue_ltv") return api("api/2/revenue/ltv", { query: { start: ymd(w.from), end: ymd(w.to), m: 0, i: a.interval } });
      return api("api/2/users", { query: { start: ymd(w.from), end: ymd(w.to), m: a.metric, i: a.interval } });
    }),
);

server.registerTool(
  "amp_chart",
  { title: "Saved chart", description: "Get the results of a saved chart by its ID (from the chart URL).", inputSchema: { chart_id: z.string() } },
  (a) => run(() => api(`api/3/chart/${encodeURIComponent(a.chart_id)}/query`)),
);

server.registerTool(
  "amp_user",
  { title: "User lookup & activity", description: "Find a user by user ID, device ID or Amplitude ID and show their properties and recent event stream.", inputSchema: { user: z.string(), events: z.number().int().min(1).max(1000).default(50) } },
  (a) =>
    run(async () => {
      const s = (await api("api/2/usersearch", { query: { user: a.user } })) as { matches?: { amplitude_id: number; user_id?: string }[] };
      const m = s.matches?.[0];
      if (!m) return { found: false };
      const act = (await api("api/2/useractivity", { query: { user: m.amplitude_id, limit: a.events } })) as { userData?: Rec; events?: Rec[] };
      return { amplitude_id: m.amplitude_id, user: act.userData, events: act.events?.map((e) => ({ time: e.event_time, event: e.event_type, properties: e.event_properties })) };
    }),
);

server.registerTool(
  "amp_upload",
  { title: "Send events", description: "Send server-side events (e.g. purchases from your backend or CRM) via the HTTP V2 API with insert_id for dedup. Needs confirm.", inputSchema: { events: z.array(z.object({ event_type: z.string(), user_id: z.string().optional(), device_id: z.string().optional(), time: z.string().optional(), insert_id: z.string().optional(), revenue: z.number().optional(), event_properties: z.record(z.unknown()).optional(), user_properties: z.record(z.unknown()).optional() })).min(1).max(2000), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (!a.confirm) throw new Error("Uploaded events are permanent; set confirm: true");
      const res = await fetch(eu() ? "https://api.eu.amplitude.com/2/httpapi" : "https://api2.amplitude.com/2/httpapi", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: requireEnv("AMPLITUDE_API_KEY"), events: a.events.map((e) => ({ ...e, time: e.time ? Date.parse(e.time) : Date.now() })) }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Amplitude ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
      return body;
    }),
);

server.registerTool(
  "amp_api",
  { title: "Amplitude API call", description: "Call any Amplitude Dashboard REST endpoint (e.g. api/2/composition, api/2/sessions/length, api/3/cohorts). Writes need confirm.", inputSchema: { method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method !== "GET" && !a.confirm) throw new Error("Write calls change Amplitude; set confirm: true");
      return api(a.path.replace(/^\//, ""), { method: a.method, query: a.query, body: a.body });
    }),
);

await startStdio(server, "amplitude");
