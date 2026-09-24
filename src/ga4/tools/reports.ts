import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { data, google, property, schema } from "../client.js";

type Header = { name: string };
type Row = { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] };
type ReportResponse = {
  dimensionHeaders?: Header[];
  metricHeaders?: Header[];
  rows?: Row[];
  totals?: Row[];
  rowCount?: number;
  metadata?: unknown;
  propertyQuota?: unknown;
};

/** Turn GA4's parallel header/value arrays into plain objects the model can read. */
function tabulate(res: ReportResponse) {
  const dims = (res.dimensionHeaders ?? []).map((h) => h.name);
  const mets = (res.metricHeaders ?? []).map((h) => h.name);
  const toObject = (row: Row) =>
    Object.fromEntries([
      ...dims.map((d, i) => [d, row.dimensionValues?.[i]?.value]),
      ...mets.map((m, i) => [m, row.metricValues?.[i]?.value]),
    ]);
  return {
    row_count: res.rowCount ?? 0,
    rows: (res.rows ?? []).map(toObject),
    totals: res.totals?.map(toObject),
    metadata: res.metadata,
    quota: res.propertyQuota,
  };
}

const simpleFilter = z.object({
  field: z.string().describe("Dimension name, e.g. eventName, pagePath, sessionSource"),
  match: z.enum(["EXACT", "BEGINS_WITH", "ENDS_WITH", "CONTAINS", "FULL_REGEXP", "PARTIAL_REGEXP"]).default("EXACT"),
  value: z.string(),
  not: z.boolean().default(false),
});

function buildDimensionFilter(filters?: z.infer<typeof simpleFilter>[], raw?: Record<string, unknown>) {
  if (raw) return raw;
  if (!filters?.length) return undefined;
  const expressions = filters.map((f) => {
    const expression = { filter: { fieldName: f.field, stringFilter: { matchType: f.match, value: f.value } } };
    return f.not ? { notExpression: expression } : expression;
  });
  return expressions.length === 1 ? expressions[0] : { andGroup: { expressions } };
}

const reportInput = {
  property: schema.property,
  dimensions: z.array(z.string()).default([]).describe("e.g. [\"date\",\"sessionSourceMedium\",\"pagePath\",\"eventName\",\"country\",\"deviceCategory\"]"),
  metrics: z.array(z.string()).min(1).describe("e.g. [\"sessions\",\"activeUsers\",\"conversions\",\"keyEvents\",\"purchaseRevenue\",\"eventCount\"]"),
  start_date: z.string().default("28daysAgo").describe("YYYY-MM-DD, today, yesterday or NdaysAgo"),
  end_date: z.string().default("yesterday"),
  compare_start_date: z.string().optional().describe("Optional second date range for comparisons"),
  compare_end_date: z.string().optional(),
  filters: z.array(simpleFilter).optional().describe("Simple AND-ed string filters on dimensions"),
  dimension_filter: z.record(z.unknown()).optional().describe("Raw FilterExpression; overrides filters"),
  metric_filter: z.record(z.unknown()).optional().describe("Raw FilterExpression on metrics"),
  order_by: z.string().optional().describe("Metric or dimension to sort by"),
  order_desc: z.boolean().default(true),
  limit: z.number().int().min(1).max(250000).default(100),
  offset: z.number().int().min(0).optional(),
  keep_empty_rows: z.boolean().optional(),
  currency_code: z.string().optional(),
  extra: z.record(z.unknown()).optional().describe("Any other runReport body fields (cohortSpec, comparisons, metricAggregations, ...)"),
};

export function registerReportTools(server: McpServer): void {
  server.registerTool(
    "ga4_run_report",
    {
      title: "Run GA4 report",
      description:
        "Run a GA4 Data API report. Use ga4_get_metadata to discover dimension/metric names (including customEvent:* and customUser:*).",
      inputSchema: reportInput,
    },
    (args) =>
      run(async () => {
        const dateRanges = [{ startDate: args.start_date, endDate: args.end_date }];
        if (args.compare_start_date) {
          dateRanges.push({ startDate: args.compare_start_date, endDate: args.compare_end_date ?? args.compare_start_date });
        }
        const orderBy = args.order_by
          ? [
              args.metrics.includes(args.order_by)
                ? { metric: { metricName: args.order_by }, desc: args.order_desc }
                : { dimension: { dimensionName: args.order_by }, desc: args.order_desc },
            ]
          : undefined;
        const body = {
          dimensions: args.dimensions.map((name) => ({ name })),
          metrics: args.metrics.map((name) => ({ name })),
          dateRanges,
          dimensionFilter: buildDimensionFilter(args.filters, args.dimension_filter),
          metricFilter: args.metric_filter,
          orderBys: orderBy,
          limit: args.limit,
          offset: args.offset,
          keepEmptyRows: args.keep_empty_rows,
          currencyCode: args.currency_code,
          metricAggregations: ["TOTAL"],
          returnPropertyQuota: true,
          ...args.extra,
        };
        return tabulate((await data(`${property(args.property)}:runReport`, body)) as ReportResponse);
      }),
  );

  server.registerTool(
    "ga4_run_realtime_report",
    {
      title: "Run GA4 realtime report",
      description:
        "Realtime data for the last 30 minutes (60 for GA4 360). Dimensions e.g. unifiedScreenName, eventName, country, deviceCategory, minutesAgo; metrics e.g. activeUsers, eventCount, keyEvents.",
      inputSchema: {
        property: schema.property,
        dimensions: z.array(z.string()).default([]),
        metrics: z.array(z.string()).default(["activeUsers"]),
        filters: z.array(simpleFilter).optional(),
        dimension_filter: z.record(z.unknown()).optional(),
        minutes_ago_start: z.number().int().min(0).max(59).optional(),
        minutes_ago_end: z.number().int().min(0).max(59).optional(),
        limit: z.number().int().min(1).max(10000).default(100),
      },
    },
    (args) =>
      run(async () => {
        const body = {
          dimensions: args.dimensions.map((name) => ({ name })),
          metrics: args.metrics.map((name) => ({ name })),
          dimensionFilter: buildDimensionFilter(args.filters, args.dimension_filter),
          minuteRanges:
            args.minutes_ago_start !== undefined
              ? [{ startMinutesAgo: args.minutes_ago_start, endMinutesAgo: args.minutes_ago_end ?? 0 }]
              : undefined,
          limit: args.limit,
          metricAggregations: ["TOTAL"],
          returnPropertyQuota: true,
        };
        return tabulate((await data(`${property(args.property)}:runRealtimeReport`, body)) as ReportResponse);
      }),
  );

  server.registerTool(
    "ga4_run_pivot_report",
    {
      title: "Run GA4 pivot report",
      description: "Run a pivot report; pass the raw runPivotReport body (dimensions, metrics, dateRanges, pivots, ...).",
      inputSchema: { property: schema.property, body: z.record(z.unknown()) },
    },
    ({ property: id, body }) => run(() => data(`${property(id)}:runPivotReport`, body)),
  );

  server.registerTool(
    "ga4_batch_run_reports",
    {
      title: "Batch GA4 reports",
      description: "Run up to 5 raw runReport request bodies in one call.",
      inputSchema: { property: schema.property, requests: z.array(z.record(z.unknown())).min(1).max(5) },
    },
    ({ property: id, requests }) =>
      run(async () => {
        const res = (await data(`${property(id)}:batchRunReports`, { requests })) as { reports?: ReportResponse[] };
        return (res.reports ?? []).map(tabulate);
      }),
  );

  server.registerTool(
    "ga4_run_funnel_report",
    {
      title: "Run GA4 funnel report",
      description:
        "Run a funnel report (Data API v1alpha). body example: {\"dateRanges\":[{\"startDate\":\"30daysAgo\",\"endDate\":\"yesterday\"}],\"funnel\":{\"steps\":[{\"name\":\"View item\",\"filterExpression\":{\"funnelEventFilter\":{\"eventName\":\"view_item\"}}},{\"name\":\"Purchase\",\"filterExpression\":{\"funnelEventFilter\":{\"eventName\":\"purchase\"}}}]}}",
      inputSchema: { property: schema.property, body: z.record(z.unknown()) },
    },
    ({ property: id, body }) => run(() => data(`${property(id)}:runFunnelReport`, body, "v1alpha")),
  );

  server.registerTool(
    "ga4_get_metadata",
    {
      title: "GA4 dimensions & metrics",
      description: "List available dimensions and metrics for a property, including custom ones. Use search to narrow results.",
      inputSchema: {
        property: schema.property,
        search: z.string().optional().describe("Case-insensitive text to match against apiName/uiName/category"),
      },
    },
    ({ property: id, search }) =>
      run(async () => {
        const res = (await google("data", "v1beta", "GET", `${property(id)}/metadata`)) as {
          dimensions?: { apiName: string; uiName: string; category: string; customDefinition?: boolean }[];
          metrics?: { apiName: string; uiName: string; category: string; type?: string; customDefinition?: boolean }[];
        };
        const q = search?.toLowerCase();
        const matches = (item: { apiName: string; uiName: string; category: string }) =>
          !q || [item.apiName, item.uiName, item.category].some((v) => v?.toLowerCase().includes(q));
        const slim = <T extends { apiName: string; uiName: string; category: string }>(items: T[] = []) =>
          items.filter(matches).map(({ apiName, uiName, category, ...rest }) => ({ apiName, uiName, category, ...rest }));
        return { dimensions: slim(res.dimensions), metrics: slim(res.metrics) };
      }),
  );

  server.registerTool(
    "ga4_check_compatibility",
    {
      title: "Check dimension/metric compatibility",
      description: "Check which dimensions and metrics can be combined in one report.",
      inputSchema: {
        property: schema.property,
        dimensions: z.array(z.string()).default([]),
        metrics: z.array(z.string()).default([]),
      },
    },
    ({ property: id, dimensions, metrics }) =>
      run(() =>
        data(`${property(id)}:checkCompatibility`, {
          dimensions: dimensions.map((name) => ({ name })),
          metrics: metrics.map((name) => ({ name })),
          compatibilityFilter: "COMPATIBLE",
        }),
      ),
  );
}
