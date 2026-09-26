#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { PRESETS, window } from "../shared/hub.js";
import { restClient } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/** Mixpanel Query / Export / Ingestion APIs with a service account (username + secret) — US, EU or IN residency. */
const region = () => optionalEnv("MIXPANEL_REGION", "us").toLowerCase();
const host = (kind: "api" | "data") => (region() === "eu" ? `https://${kind}-eu.mixpanel.com` : region() === "in" ? `https://${kind}-in.mixpanel.com` : `https://${kind}.mixpanel.com`);
const auth = () => ({ Authorization: `Basic ${Buffer.from(`${requireEnv("MIXPANEL_SERVICE_ACCOUNT")}:${requireEnv("MIXPANEL_SERVICE_SECRET")}`).toString("base64")}` });
const hints = { 401: "check MIXPANEL_SERVICE_ACCOUNT / MIXPANEL_SERVICE_SECRET", 403: "the service account has no access to MIXPANEL_PROJECT_ID" };
const q = restClient({ name: "Mixpanel", base: () => `${host("api")}/api/query`, headers: auth, hints });
const app = restClient({ name: "Mixpanel", base: () => `${host("api")}/api/app`, headers: auth, hints });
const ingest = restClient({ name: "Mixpanel", base: () => host("api"), headers: auth, hints });
const pid = (id?: string) => id ?? requireEnv("MIXPANEL_PROJECT_ID");

type Rec = Record<string, unknown>;
const PROJECT = z.string().optional().describe("Project ID (default MIXPANEL_PROJECT_ID)");

const server = new McpServer(
  { name: "mixpanel", version: "0.1.0" },
  { instructions: "Mixpanel: event segmentation over time with breakdowns, funnels, retention, top events, saved reports (insights), user profiles, raw event export and server-side event import (confirm). Mixpanel's official MCP can be used alongside." },
);

server.registerTool(
  "mixpanel_events",
  { title: "Top events", description: "Most frequent events (today's top, or all event names) with counts.", inputSchema: { type: z.enum(["general", "unique"]).default("general"), limit: z.number().int().min(1).max(255).default(50), project_id: PROJECT } },
  (a) => run(() => q("events/top", { query: { project_id: pid(a.project_id), type: a.type, limit: a.limit } })),
);

server.registerTool(
  "mixpanel_segmentation",
  { title: "Segmentation", description: "Event counts (or uniques/averages) per day/week/month, optionally segmented by a property (e.g. properties[\"utm_source\"]) and filtered with a where expression.", inputSchema: { event: z.string(), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), unit: z.enum(["hour", "day", "week", "month"]).default("day"), on: z.string().optional().describe('e.g. properties["$browser"]'), where: z.string().optional(), type: z.enum(["general", "unique", "average"]).default("general"), project_id: PROJECT } },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const r = (await q("segmentation", { query: { project_id: pid(a.project_id), event: a.event, from_date: w.from, to_date: w.to, unit: a.unit, on: a.on, where: a.where, type: a.type } })) as { data?: { values?: Record<string, Record<string, number>> } };
      const values = r.data?.values ?? {};
      return { window: w, totals: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Object.values(v).reduce((s, n) => s + n, 0)])), series: values };
    }),
);

server.registerTool(
  "mixpanel_funnels",
  { title: "Funnels", description: "List saved funnels, or get a saved funnel's step counts and conversion for a period (optionally segmented by a property).", inputSchema: { funnel_id: z.number().int().optional(), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), on: z.string().optional(), project_id: PROJECT } },
  (a) =>
    run(async () => {
      if (!a.funnel_id) return q("funnels/list", { query: { project_id: pid(a.project_id) } });
      const w = window(a.preset, a.from, a.to);
      const r = (await q("funnels", { query: { project_id: pid(a.project_id), funnel_id: a.funnel_id, from_date: w.from, to_date: w.to, unit: "week", on: a.on } })) as { data?: Record<string, { steps?: Rec[] }> };
      const totals: Record<string, { count: number; event: unknown }> = {};
      for (const day of Object.values(r.data ?? {}))
        for (const [i, s] of (day.steps ?? []).entries()) {
          (totals[i] ??= { count: 0, event: s.event ?? s.goal }).count += Number(s.count ?? 0);
        }
      const steps = Object.values(totals);
      return { window: w, steps: steps.map((s, i) => ({ step: i + 1, event: s.event, users: s.count, conversion_from_prev: i ? Math.round((s.count / Math.max(1, steps[i - 1].count)) * 1000) / 10 : 100, overall: Math.round((s.count / Math.max(1, steps[0]?.count ?? 1)) * 1000) / 10 })), raw: a.on ? r.data : undefined };
    }),
);

server.registerTool(
  "mixpanel_retention",
  { title: "Retention", description: "Cohort retention: users who did born_event and came back to do event (any event if omitted) per day/week/month.", inputSchema: { born_event: z.string(), event: z.string().optional(), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), unit: z.enum(["day", "week", "month"]).default("week"), project_id: PROJECT } },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      return q("retention", { query: { project_id: pid(a.project_id), from_date: w.from, to_date: w.to, born_event: a.born_event, event: a.event, unit: a.unit, retention_type: "birth" } });
    }),
);

server.registerTool(
  "mixpanel_insights",
  { title: "Saved report", description: "Run a saved Insights report by bookmark ID (from the report URL).", inputSchema: { bookmark_id: z.number().int(), project_id: PROJECT } },
  (a) => run(() => q("insights", { query: { project_id: pid(a.project_id), bookmark_id: a.bookmark_id } })),
);

server.registerTool(
  "mixpanel_profiles",
  { title: "User profiles", description: "Query user profiles with a where expression (e.g. properties[\"$email\"] == \"a@b.com\") or by distinct_id, returning chosen properties.", inputSchema: { where: z.string().optional(), distinct_id: z.string().optional(), properties: z.array(z.string()).optional(), limit: z.number().int().min(1).max(1000).default(50), project_id: PROJECT } },
  (a) =>
    run(async () => {
      const r = (await q("engage", { method: "POST", form: { project_id: pid(a.project_id), where: a.where, distinct_id: a.distinct_id, output_properties: a.properties ? JSON.stringify(a.properties) : undefined, page_size: String(a.limit) } })) as { results?: Rec[] };
      return (r.results ?? []).slice(0, a.limit).map((p) => ({ distinct_id: p.$distinct_id, ...(p.$properties as Rec) }));
    }),
);

server.registerTool(
  "mixpanel_export",
  { title: "Raw event export", description: "Export raw events for a date range (optionally one event / where filter) — capped by limit.", inputSchema: { from: z.string(), to: z.string(), event: z.string().optional(), where: z.string().optional(), limit: z.number().int().min(1).max(10000).default(500), project_id: PROJECT } },
  (a) =>
    run(async () => {
      const res = await fetch(`${host("data")}/api/2.0/export?${new URLSearchParams({ project_id: pid(a.project_id), from_date: a.from, to_date: a.to, limit: String(a.limit), ...(a.event ? { event: JSON.stringify([a.event]) } : {}), ...(a.where ? { where: a.where } : {}) })}`, { headers: auth() });
      if (!res.ok) throw new Error(`Mixpanel export ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return (await res.text()).split("\n").filter(Boolean).slice(0, a.limit).map((l) => JSON.parse(l));
    }),
);

server.registerTool(
  "mixpanel_import",
  { title: "Import events", description: "Send server-side events (e.g. Purchase from your backend/CRM) via the Import API with $insert_id for dedup. Needs confirm.", inputSchema: { events: z.array(z.object({ event: z.string(), distinct_id: z.string(), time: z.string().optional(), insert_id: z.string().optional(), properties: z.record(z.unknown()).optional() })).min(1).max(2000), confirm: z.boolean().default(false), project_id: PROJECT } },
  (a) =>
    run(async () => {
      if (!a.confirm) throw new Error("Imported events are permanent; set confirm: true");
      return ingest("import", { query: { project_id: pid(a.project_id), strict: 1 }, body: a.events.map((e) => ({ event: e.event, properties: { ...e.properties, distinct_id: e.distinct_id, time: Date.parse(e.time ?? new Date().toISOString()), $insert_id: e.insert_id ?? `${e.event}-${e.distinct_id}-${e.time ?? Date.now()}`.slice(0, 36) } })) });
    }),
);

server.registerTool(
  "mixpanel_api",
  { title: "Mixpanel API call", description: "Call any Mixpanel Query API (base api/query, e.g. jql, segmentation/numeric) or App API endpoint (base app, e.g. projects/{id}/cohorts). Non-GET app calls need confirm.", inputSchema: { base: z.enum(["query", "app"]).default("query"), method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.base === "app" && a.method !== "GET" && !a.confirm) throw new Error("Write calls change Mixpanel; set confirm: true");
      return (a.base === "app" ? app : q)(a.path.replace(/^\//, ""), { method: a.method, query: { project_id: optionalEnv("MIXPANEL_PROJECT_ID", ""), ...a.query }, body: a.body });
    }),
);

await startStdio(server, "mixpanel");
