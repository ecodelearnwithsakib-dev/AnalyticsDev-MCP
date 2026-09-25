import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { matomo, pct, periodParams, previous, range, schema, siteId } from "../client.js";

/** Friendly report name → Reporting API method (+ fixed params). */
const REPORTS: Record<string, { method: string; params?: Record<string, unknown>; note?: string }> = {
  pages: { method: "Actions.getPageUrls", params: { flat: 1 } },
  page_titles: { method: "Actions.getPageTitles", params: { flat: 1 } },
  entry_pages: { method: "Actions.getEntryPageUrls", params: { flat: 1 } },
  exit_pages: { method: "Actions.getExitPageUrls", params: { flat: 1 } },
  downloads: { method: "Actions.getDownloads", params: { flat: 1 } },
  outlinks: { method: "Actions.getOutlinks", params: { flat: 1 } },
  site_search: { method: "Actions.getSiteSearchKeywords" },
  site_search_no_results: { method: "Actions.getSiteSearchNoResultKeywords" },
  channels: { method: "Referrers.getReferrerType" },
  all_referrers: { method: "Referrers.getAll" },
  websites: { method: "Referrers.getWebsites" },
  search_engines: { method: "Referrers.getSearchEngines" },
  keywords: { method: "Referrers.getKeywords" },
  social: { method: "Referrers.getSocials" },
  campaigns: { method: "Referrers.getCampaigns" },
  campaign_details: { method: "MarketingCampaignsReporting.getName", note: "needs the MarketingCampaignsReporting plugin" },
  countries: { method: "UserCountry.getCountry" },
  regions: { method: "UserCountry.getRegion" },
  cities: { method: "UserCountry.getCity" },
  languages: { method: "UserLanguage.getLanguageCode" },
  device_types: { method: "DevicesDetection.getType" },
  device_brands: { method: "DevicesDetection.getBrand" },
  device_models: { method: "DevicesDetection.getModel" },
  os: { method: "DevicesDetection.getOsVersions" },
  browsers: { method: "DevicesDetection.getBrowsers" },
  resolutions: { method: "Resolution.getResolution" },
  hours: { method: "VisitTime.getVisitInformationPerLocalTime" },
  weekdays: { method: "VisitTime.getByDayOfWeek" },
  visit_length: { method: "VisitorInterest.getNumberOfVisitsPerVisitDuration" },
  pages_per_visit: { method: "VisitorInterest.getNumberOfVisitsPerPage" },
  new_vs_returning: { method: "VisitFrequency.get" },
  event_categories: { method: "Events.getCategory", params: { secondaryDimension: "eventAction", flat: 1 } },
  event_actions: { method: "Events.getAction", params: { flat: 1 } },
  event_names: { method: "Events.getName", params: { flat: 1 } },
  goals: { method: "Goals.get" },
  ecommerce_overview: { method: "Goals.get", params: { idGoal: "ecommerceOrder" } },
  products: { method: "Goals.getItemsName", params: { abandonedCarts: 0 } },
  product_skus: { method: "Goals.getItemsSku", params: { abandonedCarts: 0 } },
  product_categories: { method: "Goals.getItemsCategory", params: { abandonedCarts: 0 } },
  abandoned_carts: { method: "Goals.getItemsName", params: { abandonedCarts: 1 } },
  page_performance: { method: "PagePerformance.get" },
  content: { method: "Contents.getContentNames", params: { flat: 1 } },
};

const OVERVIEW_METRICS = ["nb_visits", "nb_uniq_visitors", "nb_users", "nb_actions", "nb_actions_per_visit", "avg_time_on_site", "bounce_rate", "nb_pageviews", "nb_downloads", "nb_outlinks", "nb_searches", "nb_conversions", "revenue", "conversion_rate"];

const num = (v: unknown) => (typeof v === "string" ? Number(v.replace("%", "")) : Number(v ?? 0));

export function registerReportTools(server: McpServer): void {
  server.registerTool(
    "matomo_api",
    {
      title: "Matomo API call",
      description:
        "Call ANY Matomo Reporting API method (e.g. API.getReportMetadata, CustomDimensions.getCustomDimension, HeatmapSessionRecording.getHeatmaps, TagManager.getContainers, CustomReports.getCustomReport). Params are merged in; arrays become key[0]=…",
      inputSchema: { method: z.string().describe("Module.method"), params: z.record(z.unknown()).optional() },
    },
    ({ method, params }) => run(() => matomo(method, params)),
  );

  server.registerTool(
    "matomo_overview",
    {
      title: "Overview with comparison",
      description:
        "Headline KPIs for a site and date range — visits, unique visitors, pageviews, actions/visit, avg time, bounce rate, conversions, revenue, conversion rate — with % change vs the previous period of the same length. Optional daily/weekly/monthly trend and a segment.",
      inputSchema: {
        site_id: schema.site_id,
        preset: schema.preset,
        from: schema.from,
        to: schema.to,
        segment: schema.segment,
        compare: z.boolean().default(true),
        trend: z.enum(["none", "day", "week", "month"]).default("none"),
      },
    },
    (a) =>
      run(async () => {
        const r = range(a.preset, a.from, a.to);
        const get = async (win: { from: string; to: string }) => {
          const [visits, actions, goals] = await Promise.all([
            matomo("VisitsSummary.get", { idSite: siteId(a.site_id), ...periodParams(win), segment: a.segment }),
            matomo("Actions.get", { idSite: siteId(a.site_id), ...periodParams(win), segment: a.segment }).catch(() => ({})),
            matomo("Goals.get", { idSite: siteId(a.site_id), ...periodParams(win), segment: a.segment }).catch(() => ({})),
          ]);
          return { ...(actions as object), ...(goals as object), ...(visits as object) } as Record<string, unknown>;
        };
        const now = await get(r);
        const kpis: Record<string, unknown> = {};
        for (const k of OVERVIEW_METRICS) if (now[k] !== undefined) kpis[k] = now[k];
        let change: Record<string, number | null> | undefined;
        if (a.compare) {
          const before = await get(previous(r));
          change = Object.fromEntries(Object.keys(kpis).map((k) => [k, pct(num(now[k]), num(before[k]))]));
        }
        const trend =
          a.trend === "none"
            ? undefined
            : Object.entries((await matomo("VisitsSummary.get", { idSite: siteId(a.site_id), ...periodParams(r, a.trend), segment: a.segment })) as Record<string, Record<string, unknown>>).map(([date, v]) => ({
                date,
                visits: v?.nb_visits ?? 0,
                users: v?.nb_uniq_visitors,
                bounce_rate: v?.bounce_rate,
              }));
        return { site: siteId(a.site_id), range: r, previous: a.compare ? previous(r) : undefined, kpis, change_pct: change, trend };
      }),
  );

  server.registerTool(
    "matomo_report",
    {
      title: "Any report",
      description: `Standard Matomo reports by friendly name: ${Object.keys(REPORTS).join(", ")}. Supports date presets or from/to, day/week/month breakdown, segments, row limit, sorting, a text filter on the label, and only the columns you need. Or pass any Module.method as \`method\`.`,
      inputSchema: {
        report: z.enum(Object.keys(REPORTS) as [string, ...string[]]).optional(),
        method: z.string().optional().describe("Any Reporting API method instead of a friendly report"),
        site_id: schema.site_id,
        preset: schema.preset,
        from: schema.from,
        to: schema.to,
        granularity: z.enum(["total", "day", "week", "month"]).default("total"),
        segment: schema.segment,
        limit: z.number().int().min(1).max(10000).default(50),
        sort_by: z.string().optional().describe("Column, e.g. nb_visits, nb_hits, revenue"),
        contains: z.string().optional().describe("Only rows whose label matches this (regex)"),
        columns: z.array(z.string()).optional().describe("Keep only these columns (label always kept)"),
        goal_id: z.union([z.string(), z.number()]).optional().describe("goals: a specific goal"),
        dimension_id: z.number().int().optional().describe("For CustomDimensions.getCustomDimension"),
        extra: z.record(z.unknown()).optional(),
      },
    },
    (a) =>
      run(async () => {
        const def = a.method ? { method: a.method } : REPORTS[a.report ?? "pages"];
        const r = range(a.preset, a.from, a.to);
        const data = await matomo(def.method, {
          idSite: siteId(a.site_id),
          ...periodParams(r, a.granularity),
          ...def.params,
          segment: a.segment,
          filter_limit: a.limit,
          filter_sort_column: a.sort_by,
          filter_sort_order: a.sort_by ? "desc" : undefined,
          filter_pattern: a.contains,
          showColumns: a.columns?.length ? a.columns.join(",") : undefined,
          idGoal: a.goal_id,
          idDimension: a.dimension_id,
          ...a.extra,
        });
        return { report: a.report ?? a.method, method: def.method, note: def.note, range: r, granularity: a.granularity, data };
      }),
  );

  server.registerTool(
    "matomo_realtime",
    {
      title: "Real-time",
      description: "Who is on the site right now: visits, actions, visitors and conversions in the last N minutes, plus the latest visits with pages, source, country, device and goals.",
      inputSchema: {
        site_id: schema.site_id,
        minutes: z.number().int().min(1).max(2880).default(30),
        last_visits: z.number().int().min(0).max(100).default(10),
        segment: schema.segment,
      },
    },
    (a) =>
      run(async () => {
        const [counters, visits] = await Promise.all([
          matomo("Live.getCounters", { idSite: siteId(a.site_id), lastMinutes: a.minutes, segment: a.segment }),
          a.last_visits
            ? (matomo("Live.getLastVisitsDetails", { idSite: siteId(a.site_id), period: "day", date: "today", filter_limit: a.last_visits, segment: a.segment, doNotFetchActions: 0 }) as Promise<Record<string, unknown>[]>)
            : Promise.resolve([]),
        ]);
        return {
          last_minutes: a.minutes,
          counters: Array.isArray(counters) ? counters[0] : counters,
          visits: (visits as Record<string, unknown>[]).map((v) => ({
            visitor: v.visitorId,
            at: v.serverDatePrettyFirstAction ?? v.serverDate,
            time: v.serverTimePrettyFirstAction,
            country: v.country,
            city: v.city,
            device: `${v.deviceType ?? ""} ${v.operatingSystemName ?? ""} ${v.browserName ?? ""}`.trim(),
            source: v.referrerTypeName,
            referrer: v.referrerName || undefined,
            campaign: v.campaignName || undefined,
            actions: v.actions,
            duration_s: v.visitDuration,
            goals: v.goalConversions || undefined,
            pages: ((v.actionDetails as { type?: string; url?: string; title?: string }[]) ?? []).filter((x) => x.type === "action").slice(0, 10).map((x) => x.title || x.url),
          })),
        };
      }),
  );

  server.registerTool(
    "matomo_visitor",
    {
      title: "Visitor profile",
      description: "Full profile of one visitor (by visitor ID or user ID): total visits, first/last visit, devices, locations, goals and ecommerce, and their recent visits with every page.",
      inputSchema: { site_id: schema.site_id, visitor_id: z.string().optional(), user_id: z.string().optional().describe("Your own User ID (segment userId==…)") },
    },
    (a) =>
      run(async () => {
        if (!a.visitor_id && !a.user_id) throw new Error("visitor_id or user_id is required");
        return matomo("Live.getVisitorProfile", {
          idSite: siteId(a.site_id),
          visitorId: a.visitor_id,
          segment: a.user_id ? `userId==${encodeURIComponent(a.user_id)}` : undefined,
        });
      }),
  );

  server.registerTool(
    "matomo_compare",
    {
      title: "Compare segments / sites",
      description:
        "Side-by-side KPIs for several segments (e.g. mobile vs desktop, each campaign, each country) or several sites in one bulk request — visits, users, bounce rate, actions/visit, conversions, revenue, conversion rate.",
      inputSchema: {
        site_ids: z.array(z.union([z.string(), z.number()])).optional().describe("Compare these sites (default: MATOMO_SITE_ID)"),
        segments: z.record(z.string()).optional().describe("{label: segment}, e.g. {\"Mobile\":\"deviceType==smartphone\",\"Desktop\":\"deviceType==desktop\"}"),
        preset: schema.preset,
        from: schema.from,
        to: schema.to,
      },
    },
    (a) =>
      run(async () => {
        const r = range(a.preset, a.from, a.to);
        const sites = (a.site_ids?.length ? a.site_ids : [siteId()]).map(String);
        const segs = Object.entries(a.segments ?? { All: "" });
        const combos = sites.flatMap((s) => segs.map(([label, seg]) => ({ site: s, label, seg })));
        const period = periodParams(r);
        const query = (m: string, c: (typeof combos)[number]) =>
          new URLSearchParams({ method: m, idSite: c.site, period: period.period, date: period.date, ...(c.seg ? { segment: c.seg } : {}) }).toString();
        const urls = combos.flatMap((c) => [query("VisitsSummary.get", c), query("Goals.get", c)]);
        const results = (await matomo("API.getBulkRequest", { urls })) as Record<string, unknown>[];
        return {
          range: r,
          rows: combos.map((c, i) => {
            const v = (results[i * 2] ?? {}) as Record<string, unknown>;
            const g = (results[i * 2 + 1] ?? {}) as Record<string, unknown>;
            return {
              site: c.site,
              segment: c.label,
              visits: v.nb_visits,
              users: v.nb_uniq_visitors,
              bounce_rate: v.bounce_rate,
              actions_per_visit: v.nb_actions_per_visit,
              avg_time_s: v.avg_time_on_site,
              conversions: g.nb_conversions,
              revenue: g.revenue,
              conversion_rate: g.conversion_rate,
              error: (v as { result?: string; message?: string }).result === "error" ? (v as { message?: string }).message : undefined,
            };
          }),
        };
      }),
  );
}
