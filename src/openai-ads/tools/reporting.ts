import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { humanize, oai, toMicros } from "../client.js";
import { uploadImage } from "./manage.js";

const level = z.enum(["ad_account", "campaign", "ad_group", "ad"]);
type Level = z.infer<typeof level>;
type Row = Record<string, unknown>;

const SCOPE_PATH: Record<Level, (id?: string) => string> = {
  ad_account: () => "ad_account/insights",
  campaign: (id) => `campaigns/${id}/insights`,
  ad_group: (id) => `ad_groups/${id}/insights`,
  ad: (id) => `ads/${id}/insights`,
};

const SEGMENT_FIELDS: Record<string, string[]> = {
  country: ["country.name"],
  device: ["device.type"],
  platform: ["platform"],
  product: ["product.feed_id", "product.item_id", "product.title", "product.price"],
};

const METRICS = ["impressions", "clicks", "spend", "ctr", "cpc", "cpm"];

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Inclusive YYYY-MM-DD range; defaults to the last N full days (ending yesterday). */
function dateRange(from?: string, to?: string, lastDays = 7) {
  const yesterday = new Date(Date.now() - 86_400_000);
  const until = to ?? isoDay(yesterday);
  const since = from ?? isoDay(new Date(Date.parse(`${until}T00:00:00Z`) - (lastDays - 1) * 86_400_000));
  return { type: "date_range", since, until };
}

/** Sum a metric across rows whether the key is flat (spend) or prefixed (product_spend). */
const sum = (rows: Row[], metric: string) =>
  rows.reduce((acc, row) => {
    const key = Object.keys(row).find((k) => k === metric || k.endsWith(`_${metric}`));
    return acc + (key ? Number(row[key]) || 0 : 0);
  }, 0);

const round = (n: number, digits = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : null);

export function registerReportingTools(server: McpServer): void {
  server.registerTool(
    "oai_ads_insights",
    {
      title: "Performance report",
      description:
        "Impressions, clicks, spend, CTR, CPC, CPM (spend in account currency) for the account, a campaign, ad group or ad — broken down by campaign/ad group/ad, by day/month/hour, and optionally by country, device, platform or product. Adds click-through conversions + CPA and a totals row. Dates are in the account timezone.",
      inputSchema: {
        scope: level.default("ad_account").describe("What to report on"),
        id: z.string().optional().describe("Campaign/ad group/ad ID when scope isn't ad_account"),
        level: level.optional().describe("Row entity; defaults to campaign for account scope, else the scope itself"),
        granularity: z.enum(["none", "daily", "monthly", "hourly"]).default("none"),
        date_from: z.string().optional().describe("YYYY-MM-DD (inclusive)"),
        date_to: z.string().optional().describe("YYYY-MM-DD (inclusive); defaults to yesterday"),
        last_days: z.number().int().min(1).max(1825).default(7),
        segment: z.enum(["country", "device", "platform", "product"]).optional(),
        campaign_ids: z.array(z.string()).optional().describe("Only these campaigns"),
        filters: z.array(z.object({ field: z.string(), operator: z.enum(["IN", "GREATER_THAN", "LESS_THAN"]), value: z.unknown() })).optional(),
        sort: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) })).optional(),
        fields: z.array(z.string()).optional().describe("Override projected fields, e.g. [\"ad.title\",\"ad.review_status\",\"ad.clicks\"]"),
        include_zero_rows: z.boolean().default(false),
        include_conversions: z.boolean().default(true),
        limit: z.number().int().min(1).max(10000).default(500),
      },
    },
    (a) =>
      run(async () => {
        if (a.scope !== "ad_account" && !a.id) throw new Error(`scope=${a.scope} needs id`);
        const rowLevel: Level = a.level ?? (a.scope === "ad_account" ? "campaign" : a.scope);
        const range = dateRange(a.date_from, a.date_to, a.last_days);
        const fields = a.fields ?? [
          ...(a.granularity === "none" ? [] : ["metadata.readable_time"]),
          `${rowLevel}.id`,
          `${rowLevel}.name`,
          ...(a.segment ? SEGMENT_FIELDS[a.segment] : []),
          ...METRICS.map((m) => `${a.segment ?? rowLevel}.${m}`),
        ];
        const filters = [
          ...(a.campaign_ids?.length ? [{ field: "campaign.id", operator: "IN", value: a.campaign_ids }] : []),
          ...(a.filters ?? []),
        ];
        const sort = a.sort ?? (a.granularity === "none" ? [{ field: `${a.segment ?? rowLevel}.spend`, direction: "desc" }] : undefined);
        const query = {
          aggregation_level: rowLevel,
          time_granularity: a.granularity,
          time_ranges: [range],
          fields,
          filters: filters.length ? filters : undefined,
          sort,
          segments: a.segment ? [a.segment] : undefined,
          override_segment_group_order: a.segment === "product" ? ["product", rowLevel] : undefined,
          includes: a.include_zero_rows ? [a.segment === "product" ? "zero_impression_products" : "zero_impression_items"] : undefined,
        };

        const rows: Row[] = [];
        let after: string | undefined;
        let page: { data?: Row[]; has_more?: boolean; last_id?: string };
        do {
          page = (await oai("GET", SCOPE_PATH[a.scope](a.id), { query: { ...query, limit: Math.min(2000, a.limit - rows.length), after } })) as typeof page;
          rows.push(...(page.data ?? []));
          after = page.last_id;
        } while (page.has_more && after && rows.length < a.limit);

        const totals: Row = { impressions: sum(rows, "impressions"), clicks: sum(rows, "clicks"), spend: round(sum(rows, "spend")) };
        let conversionNote: string | undefined;
        if (a.include_conversions && !a.segment) {
          try {
            const conv = (await oai("POST", "conversions/insights", {
              body: {
                aggregation_level: rowLevel,
                time_granularity: "none",
                time_ranges: [JSON.stringify(range)],
                entity_ids: a.scope === "ad_account" ? undefined : [a.id],
                group_by_entity: true,
              },
            })) as { data?: Row[] };
            const byEntity = new Map((conv.data ?? []).map((c) => [String(c.entity_id), c]));
            if (a.granularity === "none") {
              for (const row of rows) {
                const c = byEntity.get(String(row[`${rowLevel}_id`] ?? row.id));
                if (!c) continue;
                row.conversions = c.conversions;
                row.view_through_conversions = c.view_through_conversions;
                row.cpa = Number(c.conversions) ? round(Number(row.spend) / Number(c.conversions)) : null;
              }
            }
            totals.conversions = (conv.data ?? []).reduce((n, c) => n + (Number(c.conversions) || 0), 0);
            totals.view_through_conversions = (conv.data ?? []).reduce((n, c) => n + (Number(c.view_through_conversions) || 0), 0);
            totals.cpa = Number(totals.conversions) ? round(Number(totals.spend) / Number(totals.conversions)) : null;
          } catch (error) {
            conversionNote = `Conversions unavailable: ${error instanceof Error ? error.message : error}`;
          }
        }
        const impressions = Number(totals.impressions);
        const clicks = Number(totals.clicks);
        totals.ctr = impressions ? round((clicks / impressions) * 100, 3) : null;
        totals.cpc = clicks ? round(Number(totals.spend) / clicks) : null;
        totals.cpm = impressions ? round((Number(totals.spend) / impressions) * 1000) : null;

        return {
          range,
          level: rowLevel,
          totals,
          ...(conversionNote && { note: conversionNote }),
          row_count: rows.length,
          has_more: Boolean(page.has_more),
          rows: rows.map(({ id: _cursor, start_time: _s, end_time: _e, ...rest }) => rest),
        };
      }),
  );

  server.registerTool(
    "oai_ads_conversion_insights",
    {
      title: "Conversion report",
      description:
        "Attributed conversions (click-through, plus view-through where available) per ad account, campaign, ad group or ad, as totals or daily, optionally by device or country.",
      inputSchema: {
        level: level.default("campaign"),
        entity_ids: z.array(z.string()).optional(),
        daily: z.boolean().default(false),
        breakdown: z.enum(["device", "country"]).optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        last_days: z.number().int().min(1).max(1825).default(30),
        include_zero_rows: z.boolean().default(false),
      },
    },
    (a) =>
      run(() =>
        oai("POST", "conversions/insights", {
          body: {
            aggregation_level: a.level,
            time_granularity: a.daily ? "daily" : "none",
            breakdown: a.breakdown,
            time_ranges: [JSON.stringify(dateRange(a.date_from, a.date_to, a.last_days))],
            entity_ids: a.entity_ids,
            group_by_entity: true,
            include_zero_rows: a.include_zero_rows,
          },
        }),
      ),
  );

  server.registerTool(
    "oai_ads_account",
    {
      title: "Ad account",
      description:
        "Get the ad account (currency, timezone, status, review, spend limits, accessible accounts), update brand name/url/favicon, or activate/pause the whole account (pause needs confirm).",
      inputSchema: {
        action: z.enum(["get", "update_brand", "activate", "pause"]).default("get"),
        brand_name: z.string().optional(),
        brand_url: z.string().url().optional(),
        favicon_url: z.string().url().optional().describe("Image or website URL; uploaded as the account favicon"),
        favicon_file_id: z.string().optional(),
        confirm: z.boolean().default(false),
      },
    },
    (a) =>
      run(async () => {
        if (a.action === "get") {
          const [account, limits, accounts] = await Promise.allSettled([
            oai("GET", "ad_account"),
            oai("GET", "ad_account/spend_limit_windows"),
            oai("GET", "ad_accounts"),
          ]);
          const value = (r: PromiseSettledResult<unknown>) => (r.status === "fulfilled" ? humanize(r.value) : `unavailable: ${(r.reason as Error).message}`);
          if (account.status === "rejected") throw account.reason;
          return { account: value(account), spend_limits: value(limits), accessible_accounts: value(accounts) };
        }
        if (a.action === "update_brand") {
          const favicon = a.favicon_file_id ?? (a.favicon_url ? await uploadImage(a.favicon_url, undefined, "account_favicon") : undefined);
          return oai("POST", "ad_account/brand", { body: { name: a.brand_name, url: a.brand_url, favicon_file_id: favicon } });
        }
        if (a.action === "pause" && !a.confirm) throw new Error("Pausing the account stops all delivery; set confirm: true");
        return oai("POST", `ad_account/${a.action}`);
      }),
  );

  server.registerTool(
    "oai_ads_spend_limits",
    {
      title: "Account spending limits",
      description:
        "Account-wide spend caps in account currency: list, set/remove a recurring daily limit, or create/update/delete a date-range limit (end_date is exclusive). The daily-limit revision is fetched automatically.",
      inputSchema: {
        action: z.enum(["list", "set_daily", "remove_daily", "create_window", "update_window", "delete_window"]).default("list"),
        amount: z.number().nonnegative().optional().describe("Currency units, e.g. 100 = 100 USD"),
        start_date: z.string().optional().describe("YYYY-MM-DD"),
        end_date: z.string().nullable().optional().describe("YYYY-MM-DD exclusive; null = no end (daily)"),
        window_id: z.string().optional(),
        name: z.string().optional(),
        io_id: z.string().optional().describe("Insertion order reference"),
      },
    },
    (a) =>
      run(async () => {
        const list = async () => (await oai("GET", "ad_account/spend_limit_windows")) as { revision?: number };
        if (a.action === "list") return humanize(await list());
        const amount = a.amount !== undefined ? await toMicros(a.amount) : undefined;
        switch (a.action) {
          case "set_daily": {
            if (amount === undefined) throw new Error("amount is required");
            const revision = (await list()).revision ?? 0;
            return humanize(
              await oai("POST", "ad_account/daily_spend_limit", {
                body: { amount_micros: amount, expected_revision: revision, start_date: a.start_date, end_date: a.end_date },
              }),
            );
          }
          case "remove_daily":
            return humanize(await oai("POST", "ad_account/daily_spend_limit/delete", { body: { expected_revision: (await list()).revision ?? 0 } }));
          case "create_window":
            if (amount === undefined || !a.start_date || !a.end_date) throw new Error("amount, start_date and end_date are required");
            return humanize(
              await oai("POST", "ad_account/spend_limit_windows", {
                body: { amount_micros: amount, start_date: a.start_date, end_date: a.end_date, name: a.name, io_id: a.io_id },
              }),
            );
          case "update_window":
            if (!a.window_id) throw new Error("window_id is required");
            return humanize(
              await oai("POST", `ad_account/spend_limit_windows/${a.window_id}`, {
                body: { amount_micros: amount, start_date: a.start_date, end_date: a.end_date, name: a.name, io_id: a.io_id },
              }),
            );
          case "delete_window":
            if (!a.window_id) throw new Error("window_id is required");
            return humanize(await oai("POST", `ad_account/spend_limit_windows/${a.window_id}/delete`));
        }
      }),
  );

  server.registerTool(
    "oai_ads_geo_lookup",
    {
      title: "Find location IDs",
      description: "Search countries, regions and markets for campaign location targeting (e.g. \"Dhaka\", \"California\"); use the returned id in location_ids.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).default(10) },
    },
    ({ query, limit }) => run(() => oai("GET", "geo_lookup/search", { query: { q: query, limit } })),
  );
}
