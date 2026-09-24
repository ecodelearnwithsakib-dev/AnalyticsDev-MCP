import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { ads, cid, gaql, resource, schema, toMicros } from "../client.js";

const matchType = z.enum(["EXACT", "PHRASE", "BROAD"]);

/** customers/1/adGroupAds/2~3 → adGroupAds */
const collectionOf = (resourceName: string) => {
  const match = resourceName.match(/^customers\/\d+\/([A-Za-z]+)\//);
  if (!match) throw new Error(`Not a Google Ads resource name: ${resourceName}`);
  return match[1];
};

function mutate(customerId: string, collection: string, operations: unknown[], opts: { validate_only?: boolean; login_customer_id?: string }) {
  return ads(
    "POST",
    `customers/${customerId}/${collection}:mutate`,
    { operations, partialFailure: false, validateOnly: opts.validate_only },
    opts.login_customer_id,
  );
}

export function registerManageTools(server: McpServer): void {
  server.registerTool(
    "gads_api_request",
    {
      title: "Google Ads API request",
      description: "Call ANY Google Ads REST endpoint directly, e.g. POST customers/123/assets:mutate or customers/123:generateReachForecast. path is relative to the API version.",
      inputSchema: {
        method: z.enum(["GET", "POST"]).default("POST"),
        path: z.string(),
        body: z.record(z.unknown()).optional(),
        login_customer_id: schema.login_customer_id,
      },
    },
    ({ method, path, body, login_customer_id }) => run(() => ads(method, path, body, login_customer_id)),
  );

  server.registerTool(
    "gads_mutate",
    {
      title: "Mutate any resource",
      description:
        "Create/update/remove any Google Ads resource via its service, e.g. collection 'campaigns', 'adGroups', 'adGroupAds', 'adGroupCriteria', 'campaignCriteria', 'campaignBudgets', 'assets', 'assetGroups', 'userLists', 'conversionActions', 'sharedSets', 'labels'. Operations use REST JSON: {\"update\":{\"resourceName\":\"customers/1/campaigns/2\",\"name\":\"New\"},\"updateMask\":\"name\"}, {\"create\":{...}} or {\"remove\":\"customers/1/...\"}. Use collection 'googleAds' with mutateOperations for atomic multi-resource changes.",
      inputSchema: {
        collection: z.string(),
        operations: z.array(z.record(z.unknown())).min(1),
        customer_id: schema.customer_id,
        login_customer_id: schema.login_customer_id,
        validate_only: schema.validate_only,
        partial_failure: z.boolean().default(false),
      },
    },
    ({ collection, operations, customer_id, login_customer_id, validate_only, partial_failure }) =>
      run(() => {
        const id = cid(customer_id);
        const body =
          collection === "googleAds"
            ? { mutateOperations: operations, partialFailure: partial_failure, validateOnly: validate_only }
            : { operations, partialFailure: partial_failure, validateOnly: validate_only };
        return ads("POST", `customers/${id}/${collection}:mutate`, body, login_customer_id);
      }),
  );

  server.registerTool(
    "gads_set_status",
    {
      title: "Enable / pause / remove",
      description:
        "Change status of campaigns, ad groups, ads, keywords or asset groups by resource name (from gads_search, e.g. customers/1/campaigns/2, customers/1/adGroupAds/3~4, customers/1/adGroupCriteria/3~5). REMOVED is permanent and needs confirm_remove.",
      inputSchema: {
        resource_names: z.array(z.string()).min(1),
        status: z.enum(["ENABLED", "PAUSED", "REMOVED"]),
        confirm_remove: z.boolean().default(false),
        customer_id: schema.customer_id,
        login_customer_id: schema.login_customer_id,
        validate_only: schema.validate_only,
      },
    },
    ({ resource_names, status, confirm_remove, customer_id, login_customer_id, validate_only }) =>
      run(async () => {
        if (status === "REMOVED" && !confirm_remove) throw new Error("Removing is permanent; pass confirm_remove: true");
        const byCollection = new Map<string, string[]>();
        for (const name of resource_names) byCollection.set(collectionOf(name), [...(byCollection.get(collectionOf(name)) ?? []), name]);
        const results: Record<string, unknown> = {};
        for (const [collection, names] of byCollection) {
          const operations = names.map((resourceName) =>
            status === "REMOVED" ? { remove: resourceName } : { update: { resourceName, status }, updateMask: "status" },
          );
          results[collection] = await mutate(cid(customer_id), collection, operations, { validate_only, login_customer_id });
        }
        return results;
      }),
  );

  server.registerTool(
    "gads_update_budget",
    {
      title: "Change campaign budget",
      description: "Set a campaign's daily budget in account currency units (e.g. 1500 = 1,500 BDT/day). Shared budgets change for every campaign using them.",
      inputSchema: {
        campaign_id: z.string(),
        daily_amount: z.number().positive(),
        customer_id: schema.customer_id,
        login_customer_id: schema.login_customer_id,
        validate_only: schema.validate_only,
      },
    },
    ({ campaign_id, daily_amount, customer_id, login_customer_id, validate_only }) =>
      run(async () => {
        const id = cid(customer_id);
        const [row] = await gaql(
          id,
          `SELECT campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${campaign_id}`,
          1,
          login_customer_id,
        );
        if (!row) throw new Error(`Campaign ${campaign_id} not found`);
        const budget = row["campaign.campaignBudget"] as string;
        const result = await mutate(
          id,
          "campaignBudgets",
          [{ update: { resourceName: budget, amountMicros: toMicros(daily_amount) }, updateMask: "amount_micros" }],
          { validate_only, login_customer_id },
        );
        return { budget, previous_daily_amount: row["campaignBudget.amount"], new_daily_amount: daily_amount, shared: row["campaignBudget.explicitlyShared"], result };
      }),
  );

  server.registerTool(
    "gads_create_search_campaign",
    {
      title: "Create Search campaign",
      description:
        "Create a Search campaign with its budget, bidding, locations and languages in one atomic request. Created PAUSED. Common IDs: location Bangladesh 2050, US 2840, UK 2826, India 2356; language English 1000, Bengali 1056 (find others with gads_geo_targets).",
      inputSchema: {
        name: z.string(),
        daily_budget: z.number().positive().describe("Account currency units per day"),
        bidding: z.enum(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "MAXIMIZE_CLICKS", "MANUAL_CPC"]).default("MAXIMIZE_CONVERSIONS"),
        target_cpa: z.number().positive().optional().describe("With MAXIMIZE_CONVERSIONS"),
        target_roas: z.number().positive().optional().describe("With MAXIMIZE_CONVERSION_VALUE, e.g. 4 = 400%"),
        max_cpc: z.number().positive().optional().describe("Cap for MAXIMIZE_CLICKS"),
        location_ids: z.array(z.string()).default(["2050"]),
        language_ids: z.array(z.string()).default(["1000"]),
        search_partners: z.boolean().default(false),
        display_expansion: z.boolean().default(false),
        status: z.enum(["PAUSED", "ENABLED"]).default("PAUSED"),
        extra: z.record(z.unknown()).optional().describe("Extra campaign fields sent as-is (e.g. finalUrlSuffix, trackingUrlTemplate)"),
        customer_id: schema.customer_id,
        login_customer_id: schema.login_customer_id,
        validate_only: schema.validate_only,
      },
    },
    (args) =>
      run(() => {
        const id = cid(args.customer_id);
        const budgetName = `customers/${id}/campaignBudgets/-1`;
        const campaignName = `customers/${id}/campaigns/-2`;
        const bidding = {
          MAXIMIZE_CONVERSIONS: { maximizeConversions: args.target_cpa ? { targetCpaMicros: toMicros(args.target_cpa) } : {} },
          MAXIMIZE_CONVERSION_VALUE: { maximizeConversionValue: args.target_roas ? { targetRoas: args.target_roas } : {} },
          MAXIMIZE_CLICKS: { targetSpend: args.max_cpc ? { cpcBidCeilingMicros: toMicros(args.max_cpc) } : {} },
          MANUAL_CPC: { manualCpc: { enhancedCpcEnabled: false } },
        }[args.bidding];
        const mutateOperations = [
          {
            campaignBudgetOperation: {
              create: { resourceName: budgetName, name: `${args.name} budget`, amountMicros: toMicros(args.daily_budget), deliveryMethod: "STANDARD", explicitlyShared: false },
            },
          },
          {
            campaignOperation: {
              create: {
                resourceName: campaignName,
                name: args.name,
                status: args.status,
                advertisingChannelType: "SEARCH",
                campaignBudget: budgetName,
                networkSettings: {
                  targetGoogleSearch: true,
                  targetSearchNetwork: args.search_partners,
                  targetContentNetwork: args.display_expansion,
                  targetPartnerSearchNetwork: false,
                },
                containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
                ...bidding,
                ...args.extra,
              },
            },
          },
          ...args.location_ids.map((locationId) => ({
            campaignCriterionOperation: { create: { campaign: campaignName, location: { geoTargetConstant: `geoTargetConstants/${locationId}` } } },
          })),
          ...args.language_ids.map((languageId) => ({
            campaignCriterionOperation: { create: { campaign: campaignName, language: { languageConstant: `languageConstants/${languageId}` } } },
          })),
        ];
        return ads("POST", `customers/${id}/googleAds:mutate`, { mutateOperations, validateOnly: args.validate_only }, args.login_customer_id);
      }),
  );

  server.registerTool(
    "gads_create_ad_group",
    {
      title: "Create ad group",
      description: "Create a Search ad group in a campaign.",
      inputSchema: {
        campaign_id: z.string(),
        name: z.string(),
        default_cpc: z.number().positive().optional().describe("Default max CPC (manual CPC campaigns)"),
        status: z.enum(["ENABLED", "PAUSED"]).default("ENABLED"),
        customer_id: schema.customer_id,
        login_customer_id: schema.login_customer_id,
        validate_only: schema.validate_only,
      },
    },
    (args) =>
      run(() => {
        const id = cid(args.customer_id);
        return mutate(
          id,
          "adGroups",
          [
            {
              create: {
                name: args.name,
                campaign: resource(id, "campaigns", args.campaign_id),
                status: args.status,
                type: "SEARCH_STANDARD",
                cpcBidMicros: args.default_cpc ? toMicros(args.default_cpc) : undefined,
              },
            },
          ],
          args,
        );
      }),
  );

  server.registerTool(
    "gads_add_keywords",
    {
      title: "Add keywords",
      description: "Add keywords to an ad group, or negative keywords to an ad group or a whole campaign.",
      inputSchema: {
        keywords: z.array(z.object({ text: z.string(), match_type: matchType.default("PHRASE"), max_cpc: z.number().positive().optional() })).min(1),
        ad_group_id: z.string().optional(),
        campaign_id: z.string().optional().describe("For campaign-level negatives"),
        negative: z.boolean().default(false),
        customer_id: schema.customer_id,
        login_customer_id: schema.login_customer_id,
        validate_only: schema.validate_only,
      },
    },
    (args) =>
      run(() => {
        const id = cid(args.customer_id);
        if (args.ad_group_id) {
          return mutate(
            id,
            "adGroupCriteria",
            args.keywords.map((k) => ({
              create: {
                adGroup: resource(id, "adGroups", args.ad_group_id!),
                status: "ENABLED",
                negative: args.negative || undefined,
                keyword: { text: k.text, matchType: k.match_type },
                cpcBidMicros: k.max_cpc && !args.negative ? toMicros(k.max_cpc) : undefined,
              },
            })),
            args,
          );
        }
        if (!args.campaign_id || !args.negative) throw new Error("Pass ad_group_id, or campaign_id with negative: true");
        return mutate(
          id,
          "campaignCriteria",
          args.keywords.map((k) => ({
            create: { campaign: resource(id, "campaigns", args.campaign_id!), negative: true, keyword: { text: k.text, matchType: k.match_type } },
          })),
          args,
        );
      }),
  );

  server.registerTool(
    "gads_create_responsive_search_ad",
    {
      title: "Create responsive search ad",
      description: "Create an RSA: 3–15 headlines (≤30 chars), 2–4 descriptions (≤90 chars). Pin a headline with {\"text\":\"...\",\"pin\":\"HEADLINE_1\"}.",
      inputSchema: {
        ad_group_id: z.string(),
        final_url: z.string().url(),
        headlines: z.array(z.union([z.string().max(30), z.object({ text: z.string().max(30), pin: z.enum(["HEADLINE_1", "HEADLINE_2", "HEADLINE_3"]).optional() })])).min(3).max(15),
        descriptions: z.array(z.union([z.string().max(90), z.object({ text: z.string().max(90), pin: z.enum(["DESCRIPTION_1", "DESCRIPTION_2"]).optional() })])).min(2).max(4),
        path1: z.string().max(15).optional(),
        path2: z.string().max(15).optional(),
        status: z.enum(["ENABLED", "PAUSED"]).default("ENABLED"),
        customer_id: schema.customer_id,
        login_customer_id: schema.login_customer_id,
        validate_only: schema.validate_only,
      },
    },
    (args) =>
      run(() => {
        const id = cid(args.customer_id);
        const asset = (a: string | { text: string; pin?: string }) =>
          typeof a === "string" ? { text: a } : { text: a.text, ...(a.pin && { pinnedField: a.pin }) };
        return mutate(
          id,
          "adGroupAds",
          [
            {
              create: {
                adGroup: resource(id, "adGroups", args.ad_group_id),
                status: args.status,
                ad: {
                  finalUrls: [args.final_url],
                  responsiveSearchAd: { headlines: args.headlines.map(asset), descriptions: args.descriptions.map(asset), path1: args.path1, path2: args.path2 },
                },
              },
            },
          ],
          args,
        );
      }),
  );
}
