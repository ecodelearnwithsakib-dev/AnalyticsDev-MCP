import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { ads, cid, gaql, schema } from "../client.js";

const DATE_RANGES = ["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS", "LAST_BUSINESS_WEEK", "THIS_MONTH", "LAST_MONTH", "THIS_WEEK_SUN_TODAY", "LAST_WEEK_SUN_SAT"] as const;

const LEVELS = {
  account: { from: "customer", fields: ["customer.id", "customer.descriptive_name"] },
  campaign: { from: "campaign", fields: ["campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type", "campaign.bidding_strategy_type"] },
  ad_group: { from: "ad_group", fields: ["campaign.name", "ad_group.id", "ad_group.name", "ad_group.status"] },
  ad: { from: "ad_group_ad", fields: ["campaign.name", "ad_group.name", "ad_group_ad.ad.id", "ad_group_ad.ad.type", "ad_group_ad.status", "ad_group_ad.ad.final_urls"] },
  keyword: {
    from: "keyword_view",
    fields: ["campaign.name", "ad_group.name", "ad_group_criterion.criterion_id", "ad_group_criterion.keyword.text", "ad_group_criterion.keyword.match_type", "ad_group_criterion.status", "ad_group_criterion.quality_info.quality_score"],
  },
  search_term: { from: "search_term_view", fields: ["campaign.name", "ad_group.name", "search_term_view.search_term", "search_term_view.status"] },
  asset_group: { from: "asset_group", fields: ["campaign.name", "asset_group.id", "asset_group.name", "asset_group.status"] },
  device: { from: "campaign", fields: ["campaign.name", "segments.device"] },
  geo: { from: "geographic_view", fields: ["campaign.name", "geographic_view.country_criterion_id", "geographic_view.location_type"] },
} as const;

const DEFAULT_METRICS = [
  "metrics.impressions",
  "metrics.clicks",
  "metrics.ctr",
  "metrics.average_cpc",
  "metrics.cost_micros",
  "metrics.conversions",
  "metrics.conversions_value",
  "metrics.cost_per_conversion",
];

export function registerReportingTools(server: McpServer): void {
  server.registerTool(
    "gads_search",
    {
      title: "Run GAQL query",
      description:
        "Run any Google Ads Query Language query and get flat rows (micros converted to currency units). e.g. SELECT campaign.name, metrics.clicks, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS ORDER BY metrics.cost_micros DESC. A LIMIT is added if missing.",
      inputSchema: {
        query: z.string(),
        customer_id: schema.customer_id,
        login_customer_id: schema.login_customer_id,
        limit: z.number().int().min(1).max(100000).default(1000),
      },
    },
    ({ query, customer_id, login_customer_id, limit }) =>
      run(async () => {
        const rows = await gaql(cid(customer_id), query, limit, login_customer_id);
        return { count: rows.length, rows };
      }),
  );

  server.registerTool(
    "gads_performance_report",
    {
      title: "Performance report",
      description:
        "Ready-made report by account, campaign, ad group, ad, keyword, search term, Performance Max asset group, device or geo, with cost, conversions, CPA and ROAS. Use gads_search for anything custom.",
      inputSchema: {
        level: z.enum(Object.keys(LEVELS) as [keyof typeof LEVELS, ...(keyof typeof LEVELS)[]]).default("campaign"),
        date_range: z.enum(DATE_RANGES).default("LAST_30_DAYS"),
        start_date: z.string().optional().describe("YYYY-MM-DD; overrides date_range together with end_date"),
        end_date: z.string().optional(),
        daily: z.boolean().default(false).describe("Split rows by day (segments.date)"),
        campaign_id: z.string().optional().describe("Only this campaign"),
        only_active: z.boolean().default(false).describe("Only ENABLED campaigns"),
        min_impressions: z.number().int().min(0).default(0),
        extra_metrics: z.array(z.string()).default([]).describe("e.g. metrics.search_impression_share, metrics.all_conversions"),
        order_by: z.string().default("metrics.cost_micros"),
        customer_id: schema.customer_id,
        login_customer_id: schema.login_customer_id,
        limit: z.number().int().min(1).max(10000).default(200),
      },
    },
    (args) =>
      run(async () => {
        const level = LEVELS[args.level];
        const fields = [...level.fields, ...(args.daily ? ["segments.date"] : []), ...DEFAULT_METRICS, ...args.extra_metrics];
        const where = [
          args.start_date ? `segments.date BETWEEN '${args.start_date}' AND '${args.end_date ?? args.start_date}'` : `segments.date DURING ${args.date_range}`,
          ...(args.campaign_id ? [`campaign.id = ${args.campaign_id}`] : []),
          ...(args.only_active ? ["campaign.status = 'ENABLED'"] : []),
          ...(args.min_impressions ? [`metrics.impressions >= ${args.min_impressions}`] : []),
        ];
        const query = `SELECT ${[...new Set(fields)].join(", ")} FROM ${level.from} WHERE ${where.join(" AND ")} ORDER BY ${args.order_by} DESC`;
        const rows = await gaql(cid(args.customer_id), query, args.limit, args.login_customer_id);
        const withRatios: Record<string, unknown>[] = rows.map((r) => {
          const cost = Number(r["metrics.cost"] ?? 0);
          const conversions = Number(r["metrics.conversions"] ?? 0);
          const value = Number(r["metrics.conversionsValue"] ?? 0);
          return { ...r, cpa: conversions ? +(cost / conversions).toFixed(2) : null, roas: cost ? +(value / cost).toFixed(2) : null };
        });
        const total = withRatios.reduce<{ cost: number; clicks: number; impressions: number; conversions: number; value: number }>(
          (t, r) => ({
            cost: t.cost + Number(r["metrics.cost"] ?? 0),
            clicks: t.clicks + Number(r["metrics.clicks"] ?? 0),
            impressions: t.impressions + Number(r["metrics.impressions"] ?? 0),
            conversions: t.conversions + Number(r["metrics.conversions"] ?? 0),
            value: t.value + Number(r["metrics.conversionsValue"] ?? 0),
          }),
          { cost: 0, clicks: 0, impressions: 0, conversions: 0, value: 0 },
        );
        return {
          query,
          totals: {
            ...total,
            cost: +total.cost.toFixed(2),
            cpa: total.conversions ? +(total.cost / total.conversions).toFixed(2) : null,
            roas: total.cost ? +(total.value / total.cost).toFixed(2) : null,
          },
          count: withRatios.length,
          rows: withRatios,
        };
      }),
  );

  server.registerTool(
    "gads_list_accounts",
    {
      title: "List accessible accounts",
      description: "List accounts the signed-in user can access, and (from a manager account) the full client hierarchy with names, currency and status.",
      inputSchema: {
        manager_id: z.string().optional().describe("Manager account to expand; defaults to GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
      },
    },
    ({ manager_id }) =>
      run(async () => {
        const accessible = (await ads("GET", "customers:listAccessibleCustomers")) as { resourceNames?: string[] };
        const manager = (manager_id ?? process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "").replace(/-/g, "");
        const hierarchy = manager
          ? await gaql(
              manager,
              "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.level, customer_client.status, customer_client.currency_code, customer_client.time_zone FROM customer_client WHERE customer_client.level <= 2",
              5000,
              manager,
            )
          : undefined;
        return { accessible: accessible.resourceNames ?? [], hierarchy };
      }),
  );

  server.registerTool(
    "gads_change_history",
    {
      title: "Change history",
      description: "Who changed what in the account recently (up to 30 days back).",
      inputSchema: {
        days: z.number().int().min(1).max(30).default(7),
        customer_id: schema.customer_id,
        login_customer_id: schema.login_customer_id,
        limit: z.number().int().min(1).max(10000).default(200),
      },
    },
    ({ days, customer_id, login_customer_id, limit }) =>
      run(async () => {
        const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
        const rows = await gaql(
          cid(customer_id),
          `SELECT change_event.change_date_time, change_event.user_email, change_event.client_type, change_event.change_resource_type, change_event.resource_change_operation, change_event.changed_fields, campaign.name, ad_group.name FROM change_event WHERE change_event.change_date_time >= '${since}' ORDER BY change_event.change_date_time DESC`,
          limit,
          login_customer_id,
        );
        return { count: rows.length, rows };
      }),
  );

  server.registerTool(
    "gads_recommendations",
    {
      title: "Recommendations",
      description: "List Google's optimization recommendations, or apply / dismiss them by resource name.",
      inputSchema: {
        action: z.enum(["list", "apply", "dismiss"]).default("list"),
        resource_names: z.array(z.string()).optional().describe("For apply/dismiss"),
        customer_id: schema.customer_id,
        login_customer_id: schema.login_customer_id,
      },
    },
    ({ action, resource_names, customer_id, login_customer_id }) =>
      run(async () => {
        const id = cid(customer_id);
        if (action === "list") {
          return gaql(
            id,
            "SELECT recommendation.resource_name, recommendation.type, recommendation.campaign, recommendation.impact.base_metrics.conversions, recommendation.impact.potential_metrics.conversions FROM recommendation",
            500,
            login_customer_id,
          );
        }
        if (!resource_names?.length) throw new Error("resource_names is required to apply or dismiss");
        const path = `customers/${id}/recommendations:${action}`;
        const operations = resource_names.map((resourceName) => ({ resourceName }));
        return ads("POST", path, { operations, partialFailure: true }, login_customer_id);
      }),
  );
}
