#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { restClient } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/**
 * Microsoft Clarity Data Export API with a project API token (Settings → Data Export). Clarity allows
 * 10 requests per project per day and returns the last 1–3 days, so results are cached on disk.
 */
const api = restClient({ name: "Clarity", base: () => optionalEnv("CLARITY_API_BASE", "https://www.clarity.ms/export-data/api/v1"), headers: () => ({ Authorization: `Bearer ${requireEnv("CLARITY_API_TOKEN")}` }), hints: { 401: "check CLARITY_API_TOKEN (Settings → Data Export → Generate new API token)", 429: "Clarity allows 10 export requests per project per day — try again tomorrow or use cached results" } });

type Rec = Record<string, unknown>;
const DIMS = ["Browser", "Device", "Country/Region", "OS", "Source", "Medium", "Campaign", "Channel", "URL"] as const;
const cache = new Map<string, { at: number; data: unknown }>();

async function insights(days: number, dims: string[]) {
  const key = `${days}|${dims.join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.data as { metricName: string; information: Rec[] }[];
  const q: Record<string, string | number> = { numOfDays: days };
  dims.slice(0, 3).forEach((d, i) => (q[`dimension${i + 1}`] = d));
  const data = await api("project-live-insights", { query: q });
  cache.set(key, { at: Date.now(), data });
  return data as unknown as { metricName: string; information: Rec[] }[];
}

const server = new McpServer(
  { name: "clarity", version: "0.1.0" },
  { instructions: "Microsoft Clarity behaviour analytics for the last 1–3 days: sessions, bot traffic, pages per session, scroll depth, engagement time, and UX friction signals (dead clicks, rage clicks, quick backs, excessive scrolling, script errors) by up to three dimensions (URL, device, source, campaign…). The API allows only 10 calls per project per day — results are cached for an hour; ask for everything you need in one call. Clarity's official MCP can be used alongside." },
);

server.registerTool(
  "clarity_insights",
  {
    title: "Live insights",
    description: "All Clarity metrics for the last 1–3 days, broken down by up to 3 dimensions (Browser, Device, Country/Region, OS, Source, Medium, Campaign, Channel, URL). Uses 1 of the 10 daily API calls.",
    inputSchema: { days: z.number().int().min(1).max(3).default(3), dimensions: z.array(z.enum(DIMS)).max(3).default([]) },
  },
  (a) => run(async () => ({ days: a.days, dimensions: a.dimensions, metrics: Object.fromEntries((await insights(a.days, a.dimensions)).map((m) => [m.metricName, m.information])) })),
);

server.registerTool(
  "clarity_friction",
  {
    title: "UX friction report",
    description: "Ranks pages (or another dimension) by UX friction — rage clicks, dead clicks, quick backs, excessive scrolling and script errors as % of sessions — to find broken or confusing pages. Uses 1 of the 10 daily API calls.",
    inputSchema: { days: z.number().int().min(1).max(3).default(3), by: z.enum(DIMS).default("URL"), min_sessions: z.number().int().min(1).default(20), top: z.number().int().min(1).max(100).default(15) },
  },
  (a) =>
    run(async () => {
      const data = await insights(a.days, [a.by]);
      const signals = ["RageClickCount", "DeadClickCount", "QuickbackClick", "ExcessiveScroll", "ScriptErrorCount", "ErrorClickCount"];
      const rows: Record<string, Rec> = {};
      for (const m of data) {
        for (const info of m.information ?? []) {
          const k = String(info[a.by] ?? "(all)");
          const r = (rows[k] ??= { [a.by]: k });
          if (m.metricName === "Traffic") {
            r.sessions = Number(info.totalSessionCount ?? 0);
            r.bots = Number(info.totalBotSessionCount ?? 0);
          } else if (signals.includes(m.metricName)) r[m.metricName] = Number(info.sessionsWithMetricPercentage ?? info.subTotal ?? 0);
          else if (m.metricName === "ScrollDepth") r.scroll_depth = Number(info.averageScrollDepth ?? 0);
          else if (m.metricName === "EngagementTime") r.active_time_s = Number(info.activeTime ?? 0);
        }
      }
      return Object.values(rows)
        .filter((r) => Number(r.sessions ?? 0) >= a.min_sessions)
        .map((r) => ({ ...r, friction_score: Math.round(signals.reduce((s, k) => s + Number(r[k] ?? 0) * (k === "RageClickCount" || k === "ScriptErrorCount" ? 2 : 1), 0) * 10) / 10 }))
        .sort((x, y) => y.friction_score - x.friction_score)
        .slice(0, a.top);
    }),
);

await startStdio(server, "clarity");
