import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { download, msads, parseCsv, schema, unzipFirst, withErrors } from "../client.js";

const GOAL_TYPES = ["Url", "Event", "Duration", "PagesViewedPerVisit", "OfflineConversion", "AppInstall", "InStoreTransaction"];

let geoCache: { at: number; rows: Record<string, unknown>[] } | undefined;

/** Microsoft's location catalogue (CSV behind a temporary URL), cached for a day. */
async function geoLocations() {
  if (geoCache && Date.now() - geoCache.at < 86_400_000) return geoCache.rows;
  const res = (await msads("campaign", "POST", "GeoLocationsFileUrl/Query", { Version: "2.0", LanguageLocale: "en" })) as { FileUrl: string };
  const rows = parseCsv(unzipFirst(await download(res.FileUrl)).toString("utf8"));
  geoCache = { at: Date.now(), rows };
  return rows;
}

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const isHash = (v: string) => /^[a-f0-9]{64}$/i.test(v);

export function registerPlanningTools(server: McpServer): void {
  server.registerTool(
    "msads_keyword_ideas",
    {
      title: "Keyword ideas",
      description: "Bing keyword planner: ideas from seed keywords and/or a URL with 12 months of search volume, competition, suggested bid and ad impression share.",
      inputSchema: {
        keywords: z.array(z.string()).default([]),
        url: z.string().url().optional(),
        location_ids: z.array(z.string()).default(["190"]).describe("From msads_geo_locations; 190 = United States"),
        language: z.string().default("English"),
        limit: z.number().int().min(1).max(1000).default(100),
        account_id: schema.account_id,
      },
    },
    (a) =>
      run(async () => {
        if (!a.keywords.length && !a.url) throw new Error("Provide keywords and/or url");
        const res = (await msads(
          "adinsight",
          "POST",
          "KeywordIdeas/Query",
          {
            ExpandIdeas: true,
            IdeaAttributes: ["Keyword", "Competition", "MonthlySearchCounts", "SuggestedBid", "AdImpressionShare", "Source"],
            SearchParameters: [
              ...(a.keywords.length ? [{ Type: "QuerySearchParameter", Queries: a.keywords }] : []),
              ...(a.url ? [{ Type: "UrlSearchParameter", Url: a.url }] : []),
              { Type: "LanguageSearchParameter", Languages: [{ Language: a.language }] },
              { Type: "LocationSearchParameter", Locations: a.location_ids.map((LocationId) => ({ LocationId })) },
              { Type: "NetworkSearchParameter", Network: { Network: "OwnedAndOperatedAndSyndicatedSearch" } },
            ],
          },
          { accountId: a.account_id },
        )) as { KeywordIdeas?: { Keyword: string; MonthlySearchCounts?: (string | number)[]; Competition?: string; SuggestedBid?: number; AdImpressionShare?: number; Source?: string }[] };
        return (res.KeywordIdeas ?? [])
          .map((k) => {
            const months = (k.MonthlySearchCounts ?? []).map(Number);
            return {
              keyword: k.Keyword,
              avg_monthly_searches: months.length ? Math.round(months.reduce((s, n) => s + n, 0) / months.length) : null,
              last_month: months.at(-1) ?? null,
              competition: k.Competition,
              suggested_bid: k.SuggestedBid,
              ad_impression_share: k.AdImpressionShare,
              source: k.Source,
            };
          })
          .sort((x, y) => (y.avg_monthly_searches ?? 0) - (x.avg_monthly_searches ?? 0))
          .slice(0, a.limit);
      }),
  );

  server.registerTool(
    "msads_geo_locations",
    {
      title: "Find location IDs",
      description: "Search Microsoft Advertising locations (countries, states, cities, metro areas, postal codes) by name to get the IDs used for targeting and keyword ideas.",
      inputSchema: { query: z.string(), type: z.string().optional().describe("e.g. Country, State, City, MetroArea, PostalCode"), limit: z.number().int().min(1).max(100).default(20) },
    },
    ({ query, type, limit }) =>
      run(async () => {
        const q = query.toLowerCase();
        const rows = await geoLocations();
        const hit = (r: Record<string, unknown>) =>
          Object.entries(r).some(([k, v]) => /name/i.test(k) && String(v ?? "").toLowerCase().includes(q)) &&
          (!type || String(r["Location Type"] ?? r.LocationType ?? "").toLowerCase() === type.toLowerCase());
        return rows
          .filter(hit)
          .filter((r) => !/deprecated/i.test(String(r.Status ?? "")))
          .sort((x, y) => String(x["Bing Display Name"] ?? "").length - String(y["Bing Display Name"] ?? "").length)
          .slice(0, limit);
      }),
  );

  server.registerTool(
    "msads_conversion_tracking",
    {
      title: "UET tags & conversion goals",
      description:
        "List UET tags (with tracking status and snippet) and conversion goals, create a UET tag, or create a conversion goal (url, event or offline) with optional fixed/variable revenue.",
      inputSchema: {
        action: z.enum(["list", "create_uet_tag", "create_goal"]).default("list"),
        name: z.string().optional(),
        goal_type: z.enum(["url", "event", "offline"]).optional(),
        tag_id: z.string().optional().describe("UET tag for url/event goals"),
        url_contains: z.string().optional().describe("url goals: destination URL contains"),
        event_action: z.string().optional().describe("event goals: event action, e.g. purchase"),
        category: z.string().default("Purchase").describe("GoalCategory, e.g. Purchase, Signup, SubmitLeadForm, Contact"),
        revenue: z.number().optional(),
        variable_revenue: z.boolean().default(false),
        currency: z.string().optional(),
        window_days: z.number().int().min(1).max(90).default(30),
        account_id: schema.account_id,
      },
    },
    (a) =>
      run(async () => {
        const opts = { accountId: a.account_id };
        if (a.action === "list") {
          const tags = (await msads("campaign", "POST", "UetTags/QueryByIds", { TagIds: null }, opts)) as { UetTags?: unknown[] };
          const goals: unknown[] = [];
          for (const type of GOAL_TYPES) {
            try {
              const res = (await msads("campaign", "POST", "ConversionGoals/QueryByIds", { ConversionGoalIds: null, ConversionGoalTypes: type }, opts)) as { ConversionGoals?: unknown[] };
              goals.push(...(res.ConversionGoals ?? []));
            } catch {
              // some goal types aren't enabled for every account
            }
          }
          return { uet_tags: tags.UetTags, conversion_goals: goals };
        }
        if (!a.name) throw new Error("name is required");
        if (a.action === "create_uet_tag") {
          return withErrors((await msads("campaign", "POST", "UetTags", { UetTags: [{ Name: a.name, Description: null }] }, opts)) as Record<string, unknown>);
        }
        if (!a.goal_type) throw new Error("goal_type is required");
        if (a.goal_type !== "offline" && !a.tag_id) throw new Error("url/event goals need tag_id");
        const typeFields = {
          url: { Type: "UrlGoal", UrlExpression: a.url_contains, UrlOperator: "Contains" },
          event: { Type: "EventGoal", ActionExpression: a.event_action, ActionOperator: "Equals" },
          offline: { Type: "OfflineConversionGoal" },
        }[a.goal_type];
        return withErrors(
          (await msads("campaign", "POST", "ConversionGoals", {
            ConversionGoals: [
              {
                Name: a.name,
                ...typeFields,
                GoalCategory: a.category,
                TagId: a.tag_id ?? null,
                ConversionWindowInMinutes: a.window_days * 1440,
                CountType: a.category === "Purchase" ? "All" : "Unique",
                Scope: "Account",
                Status: "Active",
                Revenue: a.revenue !== undefined || a.variable_revenue ? { Type: a.variable_revenue ? "VariableValue" : "FixedValue", Value: a.revenue ?? 0, CurrencyCode: a.currency ?? null } : { Type: "NoValue" },
              },
            ],
          }, opts)) as Record<string, unknown>,
        );
      }),
  );

  server.registerTool(
    "msads_upload_offline_conversions",
    {
      title: "Upload offline conversions",
      description:
        "Send offline conversions by Microsoft click ID (MSCLKID) to an offline conversion goal, with value and currency. Email/phone (enhanced conversions) are normalized and SHA-256 hashed locally. Conversions must be within 90 days of the click.",
      inputSchema: {
        goal_name: z.string().describe("Name of the offline conversion goal"),
        conversions: z
          .array(
            z.object({
              msclkid: z.string().optional(),
              time: z.string().describe("ISO datetime, e.g. 2026-09-24T14:30:00Z"),
              value: z.number().optional(),
              currency: z.string().length(3).optional(),
              email: z.string().optional(),
              phone: z.string().optional().describe("With country code"),
            }),
          )
          .min(1)
          .max(1000),
        account_id: schema.account_id,
      },
    },
    (a) =>
      run(async () => {
        const rows = a.conversions.map((c, i) => {
          if (!c.msclkid && !c.email && !c.phone) throw new Error(`Conversion ${i}: needs msclkid, email or phone`);
          const email = c.email?.trim().toLowerCase();
          const phone = c.phone ? `+${c.phone.replace(/[^\d]/g, "").replace(/^0+/, "")}` : undefined;
          return {
            ConversionName: a.goal_name,
            ConversionTime: new Date(c.time).toISOString(),
            ConversionValue: c.value ?? null,
            ConversionCurrencyCode: c.currency?.toUpperCase() ?? null,
            MicrosoftClickId: c.msclkid ?? null,
            HashedEmailAddress: email ? (isHash(email) ? email : sha256(email)) : null,
            HashedPhoneNumber: phone ? (isHash(c.phone!) ? c.phone : sha256(phone)) : null,
          };
        });
        return withErrors((await msads("campaign", "POST", "OfflineConversions/Apply", { OfflineConversions: rows }, { accountId: a.account_id })) as Record<string, unknown>);
      }),
  );
}
