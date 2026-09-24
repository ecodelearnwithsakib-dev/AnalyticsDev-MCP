import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { ads, cid, gaql, resource, schema } from "../client.js";

const sha256 = (value: string) => createHash("sha256").update(value.trim().toLowerCase()).digest("hex");

export function registerPlanningTools(server: McpServer): void {
  server.registerTool(
    "gads_keyword_ideas",
    {
      title: "Keyword Planner ideas",
      description: "Keyword ideas with average monthly searches, competition and top-of-page bid range, from seed keywords and/or a URL.",
      inputSchema: {
        keywords: z.array(z.string()).default([]),
        url: z.string().url().optional(),
        location_ids: z.array(z.string()).default(["2050"]).describe("Geo target IDs; 2050 = Bangladesh"),
        language_id: z.string().default("1000").describe("1000 = English, 1056 = Bengali"),
        include_adult: z.boolean().default(false),
        limit: z.number().int().min(1).max(2000).default(100),
        customer_id: schema.customer_id,
        login_customer_id: schema.login_customer_id,
      },
    },
    (args) =>
      run(async () => {
        if (!args.keywords.length && !args.url) throw new Error("Provide keywords and/or url");
        const seed =
          args.keywords.length && args.url
            ? { keywordAndUrlSeed: { keywords: args.keywords, url: args.url } }
            : args.url
              ? { urlSeed: { url: args.url } }
              : { keywordSeed: { keywords: args.keywords } };
        const res = (await ads(
          "POST",
          `customers/${cid(args.customer_id)}:generateKeywordIdeas`,
          {
            language: `languageConstants/${args.language_id}`,
            geoTargetConstants: args.location_ids.map((l) => `geoTargetConstants/${l}`),
            includeAdultKeywords: args.include_adult,
            keywordPlanNetwork: "GOOGLE_SEARCH",
            pageSize: args.limit,
            ...seed,
          },
          args.login_customer_id,
        )) as { results?: { text: string; keywordIdeaMetrics?: Record<string, unknown> }[] };
        return (res.results ?? [])
          .map((r) => ({
            keyword: r.text,
            avg_monthly_searches: Number(r.keywordIdeaMetrics?.avgMonthlySearches ?? 0),
            competition: r.keywordIdeaMetrics?.competition,
            competition_index: r.keywordIdeaMetrics?.competitionIndex !== undefined ? Number(r.keywordIdeaMetrics.competitionIndex) : undefined,
            low_top_of_page_bid: r.keywordIdeaMetrics?.lowTopOfPageBidMicros ? Number(r.keywordIdeaMetrics.lowTopOfPageBidMicros) / 1e6 : undefined,
            high_top_of_page_bid: r.keywordIdeaMetrics?.highTopOfPageBidMicros ? Number(r.keywordIdeaMetrics.highTopOfPageBidMicros) / 1e6 : undefined,
          }))
          .sort((a, b) => b.avg_monthly_searches - a.avg_monthly_searches)
          .slice(0, args.limit);
      }),
  );

  server.registerTool(
    "gads_geo_targets",
    {
      title: "Find location IDs",
      description: "Look up geo target IDs for countries, regions and cities (e.g. 'Dhaka', 'Chattogram').",
      inputSchema: {
        names: z.array(z.string()).min(1),
        country_code: z.string().length(2).optional().describe("e.g. BD"),
        locale: z.string().default("en"),
      },
    },
    ({ names, country_code, locale }) =>
      run(async () => {
        const res = (await ads("POST", "geoTargetConstants:suggest", { locale, countryCode: country_code, locationNames: { names } })) as {
          geoTargetConstantSuggestions?: { geoTargetConstant?: Record<string, unknown>; searchTerm?: string; reach?: string }[];
        };
        return (res.geoTargetConstantSuggestions ?? []).map((s) => ({
          search: s.searchTerm,
          id: s.geoTargetConstant?.id,
          name: s.geoTargetConstant?.canonicalName,
          type: s.geoTargetConstant?.targetType,
          reach: s.reach ? Number(s.reach) : undefined,
        }));
      }),
  );

  server.registerTool(
    "gads_list_conversion_actions",
    {
      title: "List conversion actions",
      description: "Conversion actions with type, status, category, primary/secondary and counting settings.",
      inputSchema: { customer_id: schema.customer_id, login_customer_id: schema.login_customer_id },
    },
    ({ customer_id, login_customer_id }) =>
      run(() =>
        gaql(
          cid(customer_id),
          "SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.status, conversion_action.category, conversion_action.primary_for_goal, conversion_action.counting_type, conversion_action.tag_snippets FROM conversion_action WHERE conversion_action.status != 'REMOVED'",
          500,
          login_customer_id,
        ).then((rows) => rows.map(({ ["conversionAction.tagSnippets"]: _snippets, ...rest }) => rest)),
      ),
  );

  server.registerTool(
    "gads_upload_click_conversions",
    {
      title: "Upload offline / enhanced conversions",
      description:
        "Upload offline click conversions (by GCLID, GBRAID or WBRAID) and/or enhanced conversions for leads (hashed email/phone). conversion_time format: 'YYYY-MM-DD HH:MM:SS+06:00'. Uploads are partial-failure: per-row errors are returned.",
      inputSchema: {
        conversion_action_id: z.string(),
        conversions: z
          .array(
            z.object({
              gclid: z.string().optional(),
              gbraid: z.string().optional(),
              wbraid: z.string().optional(),
              email: z.string().optional().describe("Hashed before upload"),
              phone: z.string().optional().describe("E.164, e.g. +8801XXXXXXXXX; hashed before upload"),
              conversion_time: z.string(),
              value: z.number().optional(),
              currency: z.string().length(3).optional(),
              order_id: z.string().optional(),
            }),
          )
          .min(1)
          .max(2000),
        validate_only: schema.validate_only,
        customer_id: schema.customer_id,
        login_customer_id: schema.login_customer_id,
      },
    },
    ({ conversion_action_id, conversions, validate_only, customer_id, login_customer_id }) =>
      run(() => {
        const id = cid(customer_id);
        const conversionAction = resource(id, "conversionActions", conversion_action_id);
        return ads(
          "POST",
          `customers/${id}:uploadClickConversions`,
          {
            conversions: conversions.map((c) => ({
              conversionAction,
              gclid: c.gclid,
              gbraid: c.gbraid,
              wbraid: c.wbraid,
              conversionDateTime: c.conversion_time,
              conversionValue: c.value,
              currencyCode: c.currency,
              orderId: c.order_id,
              userIdentifiers: [
                ...(c.email ? [{ hashedEmail: sha256(c.email) }] : []),
                ...(c.phone ? [{ hashedPhoneNumber: sha256(c.phone.replace(/[^\d+]/g, "")) }] : []),
              ],
            })),
            partialFailure: true,
            validateOnly: validate_only,
          },
          login_customer_id,
        );
      }),
  );
}
