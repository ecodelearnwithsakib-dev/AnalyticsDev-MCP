#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { PRESETS, window } from "../shared/hub.js";
import { restClient } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/** PostHog (Cloud US/EU or self-hosted) with a personal API key. */
const host = () => optionalEnv("POSTHOG_HOST", "https://us.posthog.com").replace(/\/+$/, "");
const api = restClient({ name: "PostHog", base: host, headers: () => ({ Authorization: `Bearer ${requireEnv("POSTHOG_API_KEY")}` }), hints: { 401: "check POSTHOG_API_KEY (personal API key) and POSTHOG_HOST (us/eu)", 403: "the personal API key is missing a scope (query:read, feature_flag:write, …)" } });
const project = (id?: string) => id ?? requireEnv("POSTHOG_PROJECT_ID");

type Rec = Record<string, unknown>;
async function hogql(q: string, projectId?: string) {
  const r = (await api(`api/projects/${project(projectId)}/query/`, { body: { query: { kind: "HogQLQuery", query: q }, name: "analyticsdev-mcp" } })) as { columns?: string[]; results?: unknown[][]; error?: string };
  if (r.error) throw new Error(`HogQL: ${r.error}`);
  return (r.results ?? []).map((row) => Object.fromEntries((r.columns ?? []).map((c, i) => [c, row[i]])));
}
const PROJECT = z.string().optional().describe("Project ID (default POSTHOG_PROJECT_ID)");
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const server = new McpServer(
  { name: "posthog", version: "0.1.0" },
  { instructions: "PostHog product analytics: HogQL SQL over events/persons/sessions, trends, funnels, web analytics overview, persons, feature flags (changes need confirm), experiments, insights/dashboards and raw API. Use posthog_query for anything custom. PostHog's official MCP can be used alongside." },
);

server.registerTool(
  "posthog_projects",
  { title: "Projects", description: "Organizations and projects the key can access, with IDs and time zones.", inputSchema: {} },
  () => run(async () => (((await api("api/projects/")) as { results: Rec[] }).results).map((p) => ({ id: p.id, name: p.name, organization: p.organization, timezone: p.timezone, api_token: undefined }))),
);

server.registerTool(
  "posthog_query",
  { title: "HogQL query", description: "Run a HogQL (SQL) query against events, persons, sessions, groups and data warehouse tables, e.g. SELECT event, count() FROM events WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY event ORDER BY 2 DESC LIMIT 20.", inputSchema: { query: z.string(), project_id: PROJECT } },
  (a) => run(() => hogql(a.query, a.project_id)),
);

server.registerTool(
  "posthog_trends",
  { title: "Event trends", description: "Daily/weekly counts, unique users and (optional) sum of a numeric property for one or more events, with optional breakdown by a property.", inputSchema: { events: z.array(z.string()).min(1).default(["$pageview"]), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), interval: z.enum(["day", "week", "month"]).default("day"), breakdown: z.string().optional().describe("Event property, e.g. $browser, utm_source, $current_url"), sum_property: z.string().optional(), project_id: PROJECT } },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const bucket = a.interval === "day" ? "toDate(timestamp)" : a.interval === "week" ? "toStartOfWeek(timestamp)" : "toStartOfMonth(timestamp)";
      const bd = a.breakdown ? `, properties.${a.breakdown.replace(/[^\w$]/g, "")} AS breakdown` : "";
      const sum = a.sum_property ? `, sum(toFloat(properties.${a.sum_property.replace(/[^\w$]/g, "")})) AS total` : "";
      return hogql(`SELECT ${bucket} AS period, event${bd}, count() AS events, count(DISTINCT person_id) AS users${sum} FROM events WHERE event IN (${a.events.map((e) => `'${esc(e)}'`).join(",")}) AND timestamp >= toDateTime('${w.from} 00:00:00') AND timestamp <= toDateTime('${w.to} 23:59:59') GROUP BY period, event${a.breakdown ? ", breakdown" : ""} ORDER BY period${a.breakdown ? ", events DESC" : ""} LIMIT 5000`, a.project_id);
    }),
);

server.registerTool(
  "posthog_funnel",
  { title: "Funnel", description: "Ordered conversion funnel across events within a conversion window (days): users at each step, step and overall conversion, with optional breakdown.", inputSchema: { steps: z.array(z.string()).min(2).max(10), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), window_days: z.number().int().min(1).max(90).default(14), breakdown: z.string().optional(), project_id: PROJECT } },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const r = (await api(`api/projects/${project(a.project_id)}/query/`, {
        body: { query: { kind: "FunnelsQuery", series: a.steps.map((e) => ({ kind: "EventsNode", event: e, name: e })), dateRange: { date_from: w.from, date_to: w.to }, funnelsFilter: { funnelWindowInterval: a.window_days, funnelWindowIntervalUnit: "day" }, breakdownFilter: a.breakdown ? { breakdown: a.breakdown, breakdown_type: "event" } : undefined } },
      })) as { results?: unknown };
      const flatten = (steps: Rec[]) => steps.map((s, i) => ({ step: i + 1, event: s.name, users: s.count, conversion_from_prev: i ? Math.round((Number(s.count) / Math.max(1, Number(steps[i - 1].count))) * 1000) / 10 : 100, conversion_overall: Math.round((Number(s.count) / Math.max(1, Number(steps[0].count))) * 1000) / 10, median_time_s: s.median_conversion_time }));
      const res = r.results as Rec[] | Rec[][];
      return Array.isArray(res?.[0]) ? (res as Rec[][]).map((b) => ({ breakdown: b[0]?.breakdown_value, steps: flatten(b) })) : flatten((res ?? []) as Rec[]);
    }),
);

server.registerTool(
  "posthog_web_overview",
  { title: "Web analytics overview", description: "Visitors, pageviews, sessions, bounce rate and session duration, plus top pages, referrers, UTM sources, countries and devices for a period.", inputSchema: { preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), top: z.number().int().min(1).max(100).default(10), project_id: PROJECT } },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const range = `timestamp >= toDateTime('${w.from} 00:00:00') AND timestamp <= toDateTime('${w.to} 23:59:59')`;
      const top = (col: string) => hogql(`SELECT ${col} AS key, count(DISTINCT person_id) AS visitors, count() AS pageviews FROM events WHERE event = '$pageview' AND ${range} GROUP BY key ORDER BY visitors DESC LIMIT ${a.top}`, a.project_id);
      const [kpi, sessions, pages, referrers, utm, countries, devices] = await Promise.all([
        hogql(`SELECT count(DISTINCT person_id) AS visitors, count() AS pageviews FROM events WHERE event = '$pageview' AND ${range}`, a.project_id),
        hogql(`SELECT count() AS sessions, round(avg($session_duration)) AS avg_duration_s, round(countIf($is_bounce) / count() * 100, 1) AS bounce_rate FROM sessions WHERE $start_timestamp >= toDateTime('${w.from} 00:00:00') AND $start_timestamp <= toDateTime('${w.to} 23:59:59')`, a.project_id).catch(() => [{}]),
        top("properties.$pathname"),
        top("properties.$referring_domain"),
        top("concat(coalesce(properties.utm_source, '(none)'), ' / ', coalesce(properties.utm_medium, '(none)'))"),
        top("properties.$geoip_country_name"),
        top("properties.$device_type"),
      ]);
      return { window: w, ...kpi[0], ...sessions[0], top_pages: pages, referrers, utm, countries, devices };
    }),
);

server.registerTool(
  "posthog_persons",
  { title: "Persons", description: "Find persons by email/distinct ID/property and show their properties and recent events.", inputSchema: { search: z.string(), events: z.number().int().min(0).max(200).default(20), project_id: PROJECT } },
  (a) =>
    run(async () => {
      const r = (await api(`api/projects/${project(a.project_id)}/persons/`, { query: { search: a.search, limit: 10 } })) as { results: Rec[] };
      return Promise.all(
        r.results.map(async (p) => ({
          id: p.id,
          distinct_ids: (p.distinct_ids as string[])?.slice(0, 5),
          properties: p.properties,
          created: p.created_at,
          recent_events: a.events ? await hogql(`SELECT timestamp, event, properties.$current_url AS url FROM events WHERE person_id = '${esc(String(p.id))}' ORDER BY timestamp DESC LIMIT ${a.events}`, a.project_id) : undefined,
        })),
      );
    }),
);

server.registerTool(
  "posthog_flags",
  { title: "Feature flags", description: "List feature flags with rollout, or turn a flag on/off and change its rollout percentage (confirm).", inputSchema: { action: z.enum(["list", "update"]).default("list"), key: z.string().optional(), active: z.boolean().optional(), rollout_percentage: z.number().min(0).max(100).optional(), confirm: z.boolean().default(false), project_id: PROJECT } },
  (a) =>
    run(async () => {
      const base = `api/projects/${project(a.project_id)}/feature_flags/`;
      const list = ((await api(base, { query: { limit: 200 } })) as { results: Rec[] }).results;
      if (a.action === "list") return list.map((f) => ({ id: f.id, key: f.key, name: f.name, active: f.active, rollout: (((f.filters as Rec)?.groups as Rec[]) ?? []).map((g) => g.rollout_percentage) }));
      const flag = list.find((f) => f.key === a.key);
      if (!flag) throw new Error(`No flag with key "${a.key}"`);
      if (!a.confirm) throw new Error("Changing a live feature flag affects users now; set confirm: true");
      const filters = flag.filters as Rec;
      if (a.rollout_percentage !== undefined) for (const g of (filters.groups as Rec[]) ?? []) g.rollout_percentage = a.rollout_percentage;
      return api(`${base}${flag.id}/`, { method: "PATCH", body: { active: a.active ?? flag.active, filters } });
    }),
);

server.registerTool(
  "posthog_api",
  { title: "PostHog API call", description: "Call any PostHog API endpoint (insights, dashboards, experiments, cohorts, surveys, annotations, session_recordings…). Writes need confirm.", inputSchema: { method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"), path: z.string().describe("e.g. api/projects/{project}/experiments/ ({project} is filled in)"), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional(), confirm: z.boolean().default(false), project_id: PROJECT } },
  (a) =>
    run(async () => {
      if (a.method !== "GET" && !/\/query\/?$/.test(a.path) && !a.confirm) throw new Error("Write calls change PostHog; set confirm: true");
      return api(a.path.replace(/^\//, "").replace("{project}", project(a.project_id)), { method: a.method, query: a.query, body: a.body });
    }),
);

await startStdio(server, "posthog");
