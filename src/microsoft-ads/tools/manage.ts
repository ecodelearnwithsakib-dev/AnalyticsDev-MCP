import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { accountId, ids, msads, schema, withErrors, type Service } from "../client.js";

const CAMPAIGN_TYPES = ["Search", "Shopping", "Audience", "PerformanceMax", "Hotel", "App", "DynamicSearchAds"] as const;
const AD_TYPES = ["ResponsiveSearch", "ResponsiveAd", "DynamicSearch", "Product", "ExpandedText", "AppInstall"];
const matchType = z.enum(["Exact", "Phrase", "Broad"]);

const BIDDING = {
  enhanced_cpc: () => ({ Type: "EnhancedCpcBiddingScheme" }),
  manual_cpc: () => ({ Type: "ManualCpcBiddingScheme" }),
  max_clicks: (a: Bid) => ({ Type: "MaxClicksBiddingScheme", MaxCpc: a.max_cpc ? { Amount: a.max_cpc } : null }),
  max_conversions: (a: Bid) => ({ Type: "MaxConversionsBiddingScheme", TargetCpa: a.target_cpa ?? null, MaxCpc: a.max_cpc ? { Amount: a.max_cpc } : null }),
  max_conversion_value: (a: Bid) => ({ Type: "MaxConversionValueBiddingScheme", TargetRoas: a.target_roas ?? null }),
  target_impression_share: (a: Bid) => ({
    Type: "TargetImpressionShareBiddingScheme",
    TargetImpressionShare: a.target_impression_share ?? 50,
    TargetAdPosition: "Anywhere",
    MaxCpc: a.max_cpc ? { Amount: a.max_cpc } : null,
  }),
};
type Bid = { max_cpc?: number; target_cpa?: number; target_roas?: number; target_impression_share?: number };

/** Account time zone and currency, needed when creating campaigns. */
async function accountInfo(account: string) {
  const res = (await msads("customer", "POST", "Account/Query", { AccountId: account })) as { Account?: { TimeZone?: string; CurrencyCode?: string } };
  return { timeZone: res.Account?.TimeZone ?? "GreenwichMeanTimeDublinEdinburghLisbonLondon", currency: res.Account?.CurrencyCode };
}

function textAssets(texts: string[], pins?: Record<string, string>) {
  return texts.map((Text) => ({ Asset: { Type: "TextAsset", Text }, PinnedField: pins?.[Text] ?? null }));
}

function rsa(a: { final_url: string; headlines: string[]; descriptions: string[]; path1?: string; path2?: string; pins?: Record<string, string> }) {
  if (a.headlines.length < 3 || a.descriptions.length < 2) throw new Error("Responsive search ads need 3–15 headlines and 2–4 descriptions");
  const long = a.headlines.find((h) => h.length > 30) ?? a.descriptions.find((d) => d.length > 90);
  if (long) throw new Error(`Too long (headlines ≤30, descriptions ≤90 chars): "${long}"`);
  return {
    Type: "ResponsiveSearch",
    FinalUrls: [a.final_url],
    Headlines: textAssets(a.headlines, a.pins),
    Descriptions: textAssets(a.descriptions, a.pins),
    Path1: a.path1 ?? null,
    Path2: a.path2 ?? null,
    Status: "Paused",
  };
}

const locationCriterion = (campaignId: string, locationId: string) => ({
  Type: "BiddableCampaignCriterion",
  CampaignId: String(campaignId),
  Criterion: { Type: "LocationCriterion", LocationId: String(locationId) },
  CriterionBid: { Type: "BidMultiplier", Multiplier: 0 },
  Status: "Active",
});

export function registerManageTools(server: McpServer): void {
  server.registerTool(
    "msads_api_request",
    {
      title: "Bing Ads API request",
      description:
        "Call ANY Microsoft Advertising REST v13 operation. service: campaign | reporting | customer | adinsight | bulk. path is relative to the service root, e.g. campaign POST Budgets/QueryByIds, campaign PUT AdGroups, adinsight POST Recommendations/Query, bulk POST Campaigns/DownloadByAccountIds. Long IDs go as strings; polymorphic objects need a \"Type\" field.",
      inputSchema: {
        service: z.enum(["campaign", "reporting", "customer", "adinsight", "bulk"]),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("POST"),
        path: z.string(),
        body: z.record(z.unknown()).optional(),
        account_id: schema.account_id,
      },
    },
    ({ service, method, path, body, account_id }) => run(() => msads(service as Service, method, path, body, { accountId: account_id })),
  );

  server.registerTool(
    "msads_list",
    {
      title: "List campaigns / ad groups / ads / keywords",
      description: "List campaigns (all types by default), an campaign's ad groups, an ad group's ads or keywords, or negative keywords of campaigns/ad groups.",
      inputSchema: {
        kind: z.enum(["campaigns", "ad_groups", "ads", "keywords", "negative_keywords"]),
        parent_id: z.string().optional().describe("campaign ID for ad_groups; ad group ID for ads/keywords"),
        entity_ids: z.array(z.string()).optional().describe("negative_keywords: campaign or ad group IDs"),
        entity_type: z.enum(["Campaign", "AdGroup"]).default("Campaign").describe("negative_keywords only"),
        campaign_types: z.array(z.enum(CAMPAIGN_TYPES)).optional().describe("campaigns: defaults to all types"),
        account_id: schema.account_id,
      },
    },
    (a) =>
      run(async () => {
        const opts = { accountId: a.account_id };
        const need = () => {
          if (!a.parent_id) throw new Error(`${a.kind} needs parent_id`);
          return String(a.parent_id);
        };
        switch (a.kind) {
          case "campaigns": {
            const all = [];
            for (const type of a.campaign_types ?? CAMPAIGN_TYPES.filter((t) => t !== "DynamicSearchAds")) {
              try {
                const res = (await msads("campaign", "POST", "Campaigns/QueryByAccountId", { AccountId: accountId(a.account_id), CampaignType: type }, opts)) as { Campaigns?: Record<string, unknown>[] };
                all.push(...(res.Campaigns ?? []));
              } catch (error) {
                if (a.campaign_types) throw error;
              }
            }
            return all.map((c) => ({
              id: c.Id,
              name: c.Name,
              type: c.CampaignType,
              status: c.Status,
              daily_budget: c.DailyBudget,
              budget_type: c.BudgetType,
              bidding: (c.BiddingScheme as { Type?: string } | undefined)?.Type,
              budget_id: c.BudgetId ?? undefined,
            }));
          }
          case "ad_groups":
            return ((await msads("campaign", "POST", "AdGroups/QueryByCampaignId", { CampaignId: need() }, opts)) as { AdGroups?: unknown[] }).AdGroups;
          case "ads":
            return ((await msads("campaign", "POST", "Ads/QueryByAdGroupId", { AdGroupId: need(), AdTypes: AD_TYPES }, opts)) as { Ads?: unknown[] }).Ads;
          case "keywords":
            return ((await msads("campaign", "POST", "Keywords/QueryByAdGroupId", { AdGroupId: need() }, opts)) as { Keywords?: unknown[] }).Keywords;
          case "negative_keywords":
            if (!a.entity_ids?.length) throw new Error("negative_keywords needs entity_ids");
            return msads("campaign", "POST", "NegativeKeywords/QueryByEntityIds", { EntityIds: ids(a.entity_ids), EntityType: a.entity_type, ParentEntityId: a.entity_type === "AdGroup" ? a.parent_id ?? null : accountId(a.account_id) }, opts);
        }
      }),
  );

  server.registerTool(
    "msads_create_search_campaign",
    {
      title: "Create Search campaign",
      description:
        "Build a Bing Search campaign in one call: campaign (daily budget in account currency, bid strategy, languages, account time zone), location targets, and optionally an ad group with keywords and a responsive search ad. Everything is created PAUSED.",
      inputSchema: {
        name: z.string(),
        daily_budget: z.number().positive(),
        bidding: z.enum(["enhanced_cpc", "manual_cpc", "max_clicks", "max_conversions", "max_conversion_value", "target_impression_share"]).default("max_clicks"),
        max_cpc: z.number().positive().optional(),
        target_cpa: z.number().positive().optional(),
        target_roas: z.number().positive().optional().describe("e.g. 4 = 400%"),
        target_impression_share: z.number().min(1).max(100).optional(),
        location_ids: z.array(z.string()).default([]).describe("Location IDs from msads_geo_locations (none = all locations)"),
        languages: z.array(z.string()).default(["All"]).describe("e.g. [\"English\"] or [\"All\"]"),
        final_url_suffix: z.string().optional().describe("e.g. utm_source=bing&utm_medium=cpc"),
        ad_group: z
          .object({
            name: z.string(),
            default_cpc: z.number().positive().optional(),
            keywords: z.array(z.object({ text: z.string(), match: matchType.default("Phrase"), bid: z.number().positive().optional() })).default([]),
            ad: z.object({ final_url: z.string().url(), headlines: z.array(z.string()), descriptions: z.array(z.string()), path1: z.string().optional(), path2: z.string().optional() }).optional(),
          })
          .optional(),
        account_id: schema.account_id,
      },
    },
    (a) =>
      run(async () => {
        const account = accountId(a.account_id);
        const opts = { accountId: account };
        if (a.ad_group?.ad) rsa(a.ad_group.ad); // validate before creating anything
        const { timeZone, currency } = await accountInfo(account);
        const created: Record<string, unknown> = { currency };
        const campaignRes = withErrors(
          (await msads(
            "campaign",
            "POST",
            "Campaigns",
            {
              AccountId: account,
              Campaigns: [
                {
                  Name: a.name,
                  CampaignType: "Search",
                  BudgetType: "DailyBudgetStandard",
                  DailyBudget: a.daily_budget,
                  TimeZone: timeZone,
                  Languages: a.languages,
                  Status: "Paused",
                  BiddingScheme: BIDDING[a.bidding](a),
                  FinalUrlSuffix: a.final_url_suffix ?? null,
                },
              ],
            },
            opts,
          )) as Record<string, unknown>,
        );
        const campaignId = (campaignRes.CampaignIds as (string | null)[] | undefined)?.[0];
        if (!campaignId) throw new Error(`Campaign not created: ${JSON.stringify(campaignRes.errors ?? campaignRes)}`);
        created.campaign_id = campaignId;
        const step = async (label: string, fn: () => Promise<unknown>) => {
          try {
            created[label] = await fn();
          } catch (error) {
            throw new Error(`${label} failed: ${error instanceof Error ? error.message : error}\nCreated so far (paused): ${JSON.stringify(created)}`);
          }
        };
        if (a.location_ids.length) {
          await step("locations", async () =>
            withErrors((await msads("campaign", "POST", "CampaignCriterions", { CampaignCriterions: a.location_ids.map((l) => locationCriterion(campaignId, l)), CriterionType: "Targets" }, opts)) as Record<string, unknown>),
          );
        }
        if (a.ad_group) {
          const g = a.ad_group;
          await step("ad_group", async () =>
            withErrors((await msads("campaign", "POST", "AdGroups", { CampaignId: campaignId, AdGroups: [{ Name: g.name, Status: "Paused", CpcBid: g.default_cpc ? { Amount: g.default_cpc } : null }] }, opts)) as Record<string, unknown>),
          );
          const adGroupId = ((created.ad_group as Record<string, unknown>).AdGroupIds as string[] | undefined)?.[0];
          if (adGroupId && g.keywords.length) {
            await step("keywords", async () =>
              withErrors((await msads("campaign", "POST", "Keywords", { AdGroupId: adGroupId, Keywords: g.keywords.map((k) => ({ Text: k.text, MatchType: k.match, Bid: k.bid ? { Amount: k.bid } : null, Status: "Active" })) }, opts)) as Record<string, unknown>),
            );
          }
          if (adGroupId && g.ad) {
            await step("ad", async () => withErrors((await msads("campaign", "POST", "Ads", { AdGroupId: adGroupId, Ads: [rsa(g.ad!)] }, opts)) as Record<string, unknown>));
          }
        }
        return { ...created, status: "Paused — activate with msads_set_status when ready" };
      }),
  );

  server.registerTool(
    "msads_create_ad_group",
    {
      title: "Create ad group",
      description: "Add a paused ad group to a campaign with an optional default CPC bid (account currency).",
      inputSchema: { campaign_id: z.string(), name: z.string(), default_cpc: z.number().positive().optional(), language: z.string().optional(), account_id: schema.account_id },
    },
    (a) =>
      run(async () =>
        withErrors(
          (await msads(
            "campaign",
            "POST",
            "AdGroups",
            { CampaignId: a.campaign_id, AdGroups: [{ Name: a.name, Status: "Paused", CpcBid: a.default_cpc ? { Amount: a.default_cpc } : null, Language: a.language ?? null }] },
            { accountId: a.account_id },
          )) as Record<string, unknown>,
        ),
      ),
  );

  server.registerTool(
    "msads_add_keywords",
    {
      title: "Add keywords / negatives",
      description: "Add keywords (Exact/Phrase/Broad, optional bid) to an ad group, or negative keywords to an ad group or campaign.",
      inputSchema: {
        keywords: z.array(z.object({ text: z.string(), match: matchType.default("Phrase"), bid: z.number().positive().optional() })).min(1).max(1000),
        ad_group_id: z.string().optional(),
        negative: z.boolean().default(false),
        negative_level: z.enum(["AdGroup", "Campaign"]).default("AdGroup"),
        campaign_id: z.string().optional().describe("For campaign-level negatives"),
        account_id: schema.account_id,
      },
    },
    (a) =>
      run(async () => {
        const opts = { accountId: a.account_id };
        if (a.negative) {
          const entityId = a.negative_level === "Campaign" ? a.campaign_id : a.ad_group_id;
          if (!entityId) throw new Error(`Campaign negatives need campaign_id; ad group negatives need ad_group_id`);
          return withErrors(
            (await msads("campaign", "POST", "EntityNegativeKeywords", {
              EntityNegativeKeywords: [{ EntityId: entityId, EntityType: a.negative_level, NegativeKeywords: a.keywords.map((k) => ({ Text: k.text, MatchType: k.match === "Broad" ? "Phrase" : k.match })) }],
            }, opts)) as Record<string, unknown>,
          );
        }
        if (!a.ad_group_id) throw new Error("ad_group_id is required");
        return withErrors(
          (await msads("campaign", "POST", "Keywords", { AdGroupId: a.ad_group_id, Keywords: a.keywords.map((k) => ({ Text: k.text, MatchType: k.match, Bid: k.bid ? { Amount: k.bid } : null, Status: "Active" })) }, opts)) as Record<string, unknown>,
        );
      }),
  );

  server.registerTool(
    "msads_create_responsive_search_ad",
    {
      title: "Create responsive search ad",
      description: "Add a paused responsive search ad: 3–15 headlines (≤30 chars), 2–4 descriptions (≤90 chars), final URL, optional display paths and pins ({\"headline text\":\"Headline1\"}).",
      inputSchema: {
        ad_group_id: z.string(),
        final_url: z.string().url(),
        headlines: z.array(z.string()).min(3).max(15),
        descriptions: z.array(z.string()).min(2).max(4),
        path1: z.string().max(15).optional(),
        path2: z.string().max(15).optional(),
        pins: z.record(z.string()).optional(),
        account_id: schema.account_id,
      },
    },
    (a) => run(async () => withErrors((await msads("campaign", "POST", "Ads", { AdGroupId: a.ad_group_id, Ads: [rsa(a)] }, { accountId: a.account_id })) as Record<string, unknown>)),
  );

  server.registerTool(
    "msads_set_status",
    {
      title: "Activate / pause / delete",
      description:
        "Activate or pause campaigns, ad groups, ads or keywords — or delete them (permanent, needs confirm_delete). Ad groups need parent_id = campaign ID; ads and keywords need parent_id = ad group ID.",
      inputSchema: {
        kind: z.enum(["campaign", "ad_group", "ad", "keyword"]),
        ids: z.array(z.string()).min(1).max(1000),
        action: z.enum(["Active", "Paused", "Delete"]),
        parent_id: z.string().optional(),
        confirm_delete: z.boolean().default(false),
        account_id: schema.account_id,
      },
    },
    (a) =>
      run(async () => {
        const opts = { accountId: a.account_id };
        const account = accountId(a.account_id);
        if (a.kind !== "campaign" && !a.parent_id) throw new Error(`${a.kind} needs parent_id (${a.kind === "ad_group" ? "campaign" : "ad group"} ID)`);
        const parent = String(a.parent_id);
        if (a.action === "Delete") {
          if (!a.confirm_delete) throw new Error("Deleting can't be undone; pause instead, or set confirm_delete: true");
          const del = {
            campaign: ["Campaigns", { AccountId: account, CampaignIds: ids(a.ids) }],
            ad_group: ["AdGroups", { CampaignId: parent, AdGroupIds: ids(a.ids) }],
            ad: ["Ads", { AdGroupId: parent, AdIds: ids(a.ids) }],
            keyword: ["Keywords", { AdGroupId: parent, KeywordIds: ids(a.ids) }],
          } as const;
          const [path, body] = del[a.kind];
          return withErrors((await msads("campaign", "DELETE", path, body, opts)) as Record<string, unknown>);
        }
        const status = a.action;
        switch (a.kind) {
          case "campaign":
            return withErrors((await msads("campaign", "PUT", "Campaigns", { AccountId: account, Campaigns: a.ids.map((Id) => ({ Id, Status: status })) }, opts)) as Record<string, unknown>);
          case "ad_group":
            return withErrors((await msads("campaign", "PUT", "AdGroups", { CampaignId: parent, AdGroups: a.ids.map((Id) => ({ Id, Status: status })) }, opts)) as Record<string, unknown>);
          case "keyword":
            return withErrors((await msads("campaign", "PUT", "Keywords", { AdGroupId: parent, Keywords: a.ids.map((Id) => ({ Id, Status: status })) }, opts)) as Record<string, unknown>);
          case "ad": {
            // UpdateAds needs each ad's concrete Type.
            const existing = ((await msads("campaign", "POST", "Ads/QueryByAdGroupId", { AdGroupId: parent, AdTypes: AD_TYPES }, opts)) as { Ads?: { Id: string | number; Type: string }[] }).Ads ?? [];
            const types = new Map(existing.map((ad) => [String(ad.Id), ad.Type]));
            const missing = a.ids.filter((id) => !types.has(String(id)));
            if (missing.length) throw new Error(`Ads not found in ad group ${parent}: ${missing.join(", ")}`);
            return withErrors((await msads("campaign", "PUT", "Ads", { AdGroupId: parent, Ads: a.ids.map((Id) => ({ Id, Type: types.get(String(Id)), Status: status })) }, opts)) as Record<string, unknown>);
          }
        }
      }),
  );

  server.registerTool(
    "msads_update_budget_bids",
    {
      title: "Update budgets / bids",
      description:
        "Change campaign daily budgets, ad group default CPC bids or keyword bids (account currency). Campaigns on a shared budget must be changed through Budgets (msads_api_request PUT Budgets).",
      inputSchema: {
        kind: z.enum(["campaign_budget", "ad_group_bid", "keyword_bid"]),
        items: z.array(z.object({ id: z.string(), amount: z.number().positive() })).min(1).max(1000),
        parent_id: z.string().optional().describe("ad_group_bid: campaign ID; keyword_bid: ad group ID"),
        account_id: schema.account_id,
      },
    },
    (a) =>
      run(async () => {
        const opts = { accountId: a.account_id };
        if (a.kind !== "campaign_budget" && !a.parent_id) throw new Error("parent_id is required");
        switch (a.kind) {
          case "campaign_budget":
            return withErrors((await msads("campaign", "PUT", "Campaigns", { AccountId: accountId(a.account_id), Campaigns: a.items.map((i) => ({ Id: i.id, DailyBudget: i.amount })) }, opts)) as Record<string, unknown>);
          case "ad_group_bid":
            return withErrors((await msads("campaign", "PUT", "AdGroups", { CampaignId: a.parent_id, AdGroups: a.items.map((i) => ({ Id: i.id, CpcBid: { Amount: i.amount } })) }, opts)) as Record<string, unknown>);
          case "keyword_bid":
            return withErrors((await msads("campaign", "PUT", "Keywords", { AdGroupId: a.parent_id, Keywords: a.items.map((i) => ({ Id: i.id, Bid: { Amount: i.amount } })) }, opts)) as Record<string, unknown>);
        }
      }),
  );
}
