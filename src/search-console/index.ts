#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv } from "../shared/env.js";
import { googleClient, googleRequest, PROFILES } from "../shared/google-auth.js";
import { pct, PRESETS, previousWindow, round, window } from "../shared/hub.js";
import { run, startStdio } from "../shared/server.js";

const getClient = googleClient(PROFILES["search-console"]);
type Method = "GET" | "POST" | "PUT" | "DELETE";
const gsc = (method: Method, url: string, data?: unknown, params?: Record<string, unknown>) => googleRequest(getClient, { method, url, data, params });
const WM = "https://www.googleapis.com/webmasters/v3";

/** Accepts sc-domain:example.com, https://example.com/ or a bare domain (→ sc-domain:). */
const site = (s?: string) => {
  const v = s ?? optionalEnv("SEARCH_CONSOLE_SITE");
  if (!v) throw new Error("site is required (or set SEARCH_CONSOLE_SITE, e.g. sc-domain:example.com)");
  return v.startsWith("http") || v.startsWith("sc-domain:") ? v : `sc-domain:${v.replace(/^www\./, "")}`;
};
const enc = (s: string) => encodeURIComponent(s);

type Row = { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number };
const DIMS = ["query", "page", "country", "device", "date", "searchAppearance"] as const;

async function query(siteUrl: string, body: Record<string, unknown>, max: number): Promise<Row[]> {
  const rows: Row[] = [];
  for (let start = 0; rows.length < max; start += 25000) {
    const res = (await gsc("POST", `${WM}/sites/${enc(siteUrl)}/searchAnalytics/query`, { ...body, rowLimit: Math.min(25000, max - rows.length), startRow: start })) as { rows?: Row[] };
    rows.push(...(res.rows ?? []));
    if ((res.rows?.length ?? 0) < 25000) break;
  }
  return rows;
}

const filterSchema = z
  .array(z.object({ dimension: z.enum(["query", "page", "country", "device", "searchAppearance"]), operator: z.enum(["contains", "equals", "notContains", "notEquals", "includingRegex", "excludingRegex"]).default("contains"), expression: z.string() }))
  .optional();

const server = new McpServer(
  { name: "search-console", version: "0.1.0" },
  { instructions: "Google Search Console: search performance (clicks, impressions, CTR, position) by query/page/country/device/date with comparisons, keyword opportunities, URL inspection, sitemaps and sites. Search data lags ~2 days; windows default to complete days." },
);

server.registerTool(
  "gsc_sites",
  { title: "Sites", description: "Search Console properties you can access, with your permission level.", inputSchema: {} },
  () => run(async () => ((await gsc("GET", `${WM}/sites`)) as { siteEntry?: unknown[] }).siteEntry ?? []),
);

server.registerTool(
  "gsc_performance",
  {
    title: "Search performance",
    description:
      "Clicks, impressions, CTR and average position for a site, grouped by up to 3 dimensions (query, page, country, device, date, searchAppearance), with filters (e.g. page contains /blog/, query excludingRegex brand), search type (web, image, video, news, discover), and comparison with the previous period per row.",
    inputSchema: {
      site: z.string().optional(),
      dimensions: z.array(z.enum(DIMS)).max(3).default(["query"]),
      preset: z.enum(PRESETS).optional().describe("Default last_30_days"),
      from: z.string().optional(),
      to: z.string().optional(),
      filters: filterSchema,
      type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).default("web"),
      compare: z.boolean().default(true),
      limit: z.number().int().min(1).max(100000).default(100),
      order_by: z.enum(["clicks", "impressions", "ctr", "position"]).default("clicks"),
    },
  },
  (a) =>
    run(async () => {
      const s = site(a.site);
      const w = window(a.preset ?? "last_30_days", a.from, a.to);
      const body = (win: { from: string; to: string }) => ({ startDate: win.from, endDate: win.to, dimensions: a.dimensions, type: a.type, dimensionFilterGroups: a.filters?.length ? [{ filters: a.filters }] : undefined, dataState: "final" });
      const [now, before] = await Promise.all([query(s, body(w), Math.max(a.limit, 1000)), a.compare ? query(s, body(previousWindow(w)), 25000) : Promise.resolve([] as Row[])]);
      const prev = new Map(before.map((r) => [(r.keys ?? []).join("|"), r]));
      const total = now.reduce((t, r) => ({ clicks: t.clicks + r.clicks, impressions: t.impressions + r.impressions }), { clicks: 0, impressions: 0 });
      const totalPrev = before.reduce((t, r) => ({ clicks: t.clicks + r.clicks, impressions: t.impressions + r.impressions }), { clicks: 0, impressions: 0 });
      const rows = now
        .map((r) => {
          const p = prev.get((r.keys ?? []).join("|"));
          return { ...Object.fromEntries(a.dimensions.map((d, i) => [d, r.keys?.[i]])), clicks: r.clicks, impressions: r.impressions, ctr_pct: round(r.ctr * 100), position: round(r.position, 1), ...(a.compare ? { clicks_change: p ? r.clicks - p.clicks : r.clicks, position_change: p ? round(p.position - r.position, 1) : null } : {}) };
        })
        .sort((x, y) => (a.order_by === "position" ? x.position - y.position : Number(y[a.order_by === "ctr" ? "ctr_pct" : a.order_by]) - Number(x[a.order_by === "ctr" ? "ctr_pct" : a.order_by])))
        .slice(0, a.limit);
      return {
        site: s,
        window: w,
        totals: { clicks: total.clicks, impressions: total.impressions, ctr_pct: total.impressions ? round((total.clicks / total.impressions) * 100) : 0, ...(a.compare ? { clicks_change_pct: pct(total.clicks, totalPrev.clicks), impressions_change_pct: pct(total.impressions, totalPrev.impressions) } : {}) },
        rows,
        note: "Totals are the sum of returned rows (anonymised queries are excluded by Google).",
      };
    }),
);

server.registerTool(
  "gsc_opportunities",
  {
    title: "Keyword opportunities",
    description:
      "Where to act: 'striking distance' queries ranking 4–20 with real impressions, high-impression queries with low CTR (title/meta rewrite candidates), pages losing clicks vs the previous period, and queries where several of your pages compete (cannibalisation).",
    inputSchema: { site: z.string().optional(), preset: z.enum(PRESETS).optional().describe("Default last_30_days"), min_impressions: z.number().int().default(100), limit: z.number().int().min(5).max(500).default(25), exclude_regex: z.string().optional().describe("e.g. brand terms: acme|acmecorp") },
  },
  (a) =>
    run(async () => {
      const s = site(a.site);
      const w = window(a.preset ?? "last_30_days");
      const filters = a.exclude_regex ? [{ filters: [{ dimension: "query", operator: "excludingRegex", expression: a.exclude_regex }] }] : undefined;
      const [qp, pages, pagesPrev] = await Promise.all([
        query(s, { startDate: w.from, endDate: w.to, dimensions: ["query", "page"], dimensionFilterGroups: filters }, 25000),
        query(s, { startDate: w.from, endDate: w.to, dimensions: ["page"] }, 25000),
        query(s, { startDate: previousWindow(w).from, endDate: previousWindow(w).to, dimensions: ["page"] }, 25000),
      ]);
      const byQuery = new Map<string, Row[]>();
      for (const r of qp) byQuery.set(r.keys![0], [...(byQuery.get(r.keys![0]) ?? []), r]);
      const queries = [...byQuery].map(([q, rs]) => {
        const imp = rs.reduce((t, r) => t + r.impressions, 0);
        const clicks = rs.reduce((t, r) => t + r.clicks, 0);
        const pos = rs.reduce((t, r) => t + r.position * r.impressions, 0) / (imp || 1);
        return { query: q, clicks, impressions: imp, ctr_pct: imp ? round((clicks / imp) * 100) : 0, position: round(pos, 1), pages: rs.sort((x, y) => y.clicks - x.clicks).map((r) => r.keys![1]) };
      });
      const expectedCtr = (p: number) => (p <= 1 ? 28 : p <= 2 ? 15 : p <= 3 ? 10 : p <= 5 ? 6 : p <= 10 ? 2.5 : 1);
      const prevPages = new Map(pagesPrev.map((r) => [r.keys![0], r]));
      return {
        site: s,
        window: w,
        striking_distance: queries.filter((q) => q.position >= 4 && q.position <= 20 && q.impressions >= a.min_impressions).sort((x, y) => y.impressions - x.impressions).slice(0, a.limit),
        low_ctr: queries.filter((q) => q.impressions >= a.min_impressions && q.position <= 10 && q.ctr_pct < expectedCtr(q.position) / 2).sort((x, y) => y.impressions - x.impressions).slice(0, a.limit),
        losing_pages: pages
          .map((r) => ({ page: r.keys![0], clicks: r.clicks, previous: prevPages.get(r.keys![0])?.clicks ?? 0 }))
          .filter((p) => p.previous >= 10 && p.clicks < p.previous * 0.7)
          .map((p) => ({ ...p, change_pct: pct(p.clicks, p.previous) }))
          .sort((x, y) => x.clicks - x.previous - (y.clicks - y.previous))
          .slice(0, a.limit),
        cannibalisation: queries.filter((q) => q.pages.length > 1 && q.impressions >= a.min_impressions).sort((x, y) => y.impressions - x.impressions).slice(0, a.limit),
      };
    }),
);

server.registerTool(
  "gsc_inspect_url",
  {
    title: "URL inspection",
    description: "Google's index status for URLs: indexed or not and why, last crawl, canonical chosen by Google vs yours, mobile usability, rich results, and robots/indexing blocks. Up to 20 URLs per call (API quota 2,000/day per site).",
    inputSchema: { site: z.string().optional(), urls: z.array(z.string().url()).min(1).max(20), language: z.string().default("en-US") },
  },
  (a) =>
    run(async () => {
      const s = site(a.site);
      const out = [];
      for (const url of a.urls) {
        const res = (await gsc("POST", "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", { inspectionUrl: url, siteUrl: s, languageCode: a.language }).catch((e: Error) => ({ error: e.message }))) as Record<string, unknown>;
        const r = (res.inspectionResult ?? {}) as Record<string, Record<string, unknown>>;
        out.push(
          res.error
            ? { url, error: res.error }
            : {
                url,
                verdict: r.indexStatusResult?.verdict,
                coverage: r.indexStatusResult?.coverageState,
                indexing_state: r.indexStatusResult?.indexingState,
                robots: r.indexStatusResult?.robotsTxtState,
                page_fetch: r.indexStatusResult?.pageFetchState,
                last_crawl: r.indexStatusResult?.lastCrawlTime,
                google_canonical: r.indexStatusResult?.googleCanonical,
                user_canonical: r.indexStatusResult?.userCanonical,
                mobile: r.mobileUsabilityResult?.verdict,
                rich_results: (r.richResultsResult?.detectedItems as { richResultType?: string }[] | undefined)?.map((i) => i.richResultType),
                link: r.inspectionResultLink,
              },
        );
      }
      return out;
    }),
);

server.registerTool(
  "gsc_sitemaps",
  {
    title: "Sitemaps",
    description: "List submitted sitemaps (last read, warnings, errors, URLs submitted/indexed), submit a sitemap, or delete one (confirm).",
    inputSchema: { site: z.string().optional(), action: z.enum(["list", "submit", "delete"]).default("list"), sitemap_url: z.string().url().optional(), confirm: z.boolean().default(false) },
  },
  (a) =>
    run(async () => {
      const s = site(a.site);
      if (a.action === "list") return ((await gsc("GET", `${WM}/sites/${enc(s)}/sitemaps`)) as { sitemap?: unknown[] }).sitemap ?? [];
      if (!a.sitemap_url) throw new Error("sitemap_url is required");
      if (a.action === "delete" && !a.confirm) throw new Error("Removing a sitemap from Search Console; set confirm: true");
      await gsc(a.action === "submit" ? "PUT" : "DELETE", `${WM}/sites/${enc(s)}/sitemaps/${enc(a.sitemap_url)}`);
      return { [a.action === "submit" ? "submitted" : "deleted"]: a.sitemap_url };
    }),
);

server.registerTool(
  "gsc_api",
  { title: "Search Console API call", description: "Call any Search Console / Webmasters API URL (e.g. https://www.googleapis.com/webmasters/v3/sites/...).", inputSchema: { method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"), url: z.string().url(), body: z.unknown().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method === "DELETE" && !a.confirm) throw new Error("DELETE calls need confirm: true");
      return gsc(a.method, a.url, a.body);
    }),
);

await startStdio(server, "search-console");
