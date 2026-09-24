import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { adAccount, graph, graphList, schema } from "../client.js";

const budget = z.number().int().positive().optional().describe("In the account currency's minor unit (e.g. 50000 = 500.00 BDT)");

export function registerAdsTools(server: McpServer): void {
  server.registerTool(
    "meta_list_ad_accounts",
    {
      title: "List ad accounts",
      description: "List ad accounts the token can access.",
      inputSchema: {
        fields: schema.fields("id,name,account_status,currency,timezone_name,amount_spent,balance,business"),
        limit: schema.limit,
      },
    },
    ({ fields, limit }) => run(() => graphList("me/adaccounts", { fields }, limit)),
  );

  server.registerTool(
    "meta_list_campaigns",
    {
      title: "List campaigns",
      description: "List campaigns in an ad account.",
      inputSchema: {
        ad_account_id: schema.adAccountId,
        effective_status: z.array(z.string()).optional().describe("e.g. [\"ACTIVE\",\"PAUSED\"]"),
        fields: schema.fields("id,name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,created_time"),
        limit: schema.limit,
      },
    },
    ({ ad_account_id, effective_status, fields, limit }) =>
      run(() => graphList(`${adAccount(ad_account_id)}/campaigns`, { fields, effective_status }, limit)),
  );

  server.registerTool(
    "meta_list_adsets",
    {
      title: "List ad sets",
      description: "List ad sets in a campaign, or in the whole ad account when campaign_id is omitted.",
      inputSchema: {
        campaign_id: z.string().optional(),
        ad_account_id: schema.adAccountId,
        effective_status: z.array(z.string()).optional(),
        fields: schema.fields(
          "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,targeting,start_time,end_time",
        ),
        limit: schema.limit,
      },
    },
    ({ campaign_id, ad_account_id, effective_status, fields, limit }) =>
      run(() => graphList(`${campaign_id ?? adAccount(ad_account_id)}/adsets`, { fields, effective_status }, limit)),
  );

  server.registerTool(
    "meta_list_ads",
    {
      title: "List ads",
      description: "List ads in an ad set or campaign, or in the whole ad account.",
      inputSchema: {
        parent_id: z.string().optional().describe("Ad set or campaign ID"),
        ad_account_id: schema.adAccountId,
        effective_status: z.array(z.string()).optional(),
        fields: schema.fields("id,name,status,effective_status,adset_id,campaign_id,creative{id,name,thumbnail_url},created_time"),
        limit: schema.limit,
      },
    },
    ({ parent_id, ad_account_id, effective_status, fields, limit }) =>
      run(() => graphList(`${parent_id ?? adAccount(ad_account_id)}/ads`, { fields, effective_status }, limit)),
  );

  server.registerTool(
    "meta_get_object",
    {
      title: "Get any Meta object",
      description: "Read any object by ID (campaign, ad set, ad, creative, page, post, audience, pixel, ...).",
      inputSchema: { id: z.string(), fields: z.string().optional() },
    },
    ({ id, fields }) => run(() => graph("GET", id, { fields })),
  );

  server.registerTool(
    "meta_create_campaign",
    {
      title: "Create campaign",
      description:
        "Create a campaign. Set daily_budget/lifetime_budget here for Advantage campaign budget, or leave empty and budget at ad set level.",
      inputSchema: {
        ad_account_id: schema.adAccountId,
        name: z.string(),
        objective: z.enum([
          "OUTCOME_AWARENESS",
          "OUTCOME_TRAFFIC",
          "OUTCOME_ENGAGEMENT",
          "OUTCOME_LEADS",
          "OUTCOME_APP_PROMOTION",
          "OUTCOME_SALES",
        ]),
        status: schema.status,
        special_ad_categories: z
          .array(z.enum(["NONE", "EMPLOYMENT", "HOUSING", "CREDIT", "ISSUES_ELECTIONS_POLITICS", "ONLINE_GAMBLING_AND_GAMING", "FINANCIAL_PRODUCTS_SERVICES"]))
          .default([]),
        daily_budget: budget,
        lifetime_budget: budget,
        bid_strategy: z.enum(["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP", "LOWEST_COST_WITH_MIN_ROAS"]).optional(),
        extra: schema.extra,
      },
    },
    ({ ad_account_id, extra, ...fields }) => run(() => graph("POST", `${adAccount(ad_account_id)}/campaigns`, { ...fields, ...extra })),
  );

  server.registerTool(
    "meta_create_adset",
    {
      title: "Create ad set",
      description:
        "Create an ad set. targeting example: {\"geo_locations\":{\"countries\":[\"BD\"]},\"age_min\":18,\"age_max\":45,\"flexible_spec\":[{\"interests\":[{\"id\":\"6003139266461\"}]}]}. Use meta_targeting_search to find interest IDs.",
      inputSchema: {
        ad_account_id: schema.adAccountId,
        campaign_id: z.string(),
        name: z.string(),
        optimization_goal: z
          .string()
          .describe("e.g. OFFSITE_CONVERSIONS, LINK_CLICKS, LANDING_PAGE_VIEWS, LEAD_GENERATION, REACH, THRUPLAY, CONVERSATIONS"),
        billing_event: z.string().default("IMPRESSIONS"),
        targeting: z.record(z.unknown()),
        daily_budget: budget,
        lifetime_budget: budget,
        bid_amount: z.number().int().optional(),
        bid_strategy: z.string().optional(),
        promoted_object: z
          .record(z.unknown())
          .optional()
          .describe("e.g. {\"pixel_id\":\"...\",\"custom_event_type\":\"PURCHASE\"} or {\"page_id\":\"...\"}"),
        destination_type: z.string().optional().describe("e.g. WEBSITE, MESSENGER, WHATSAPP, INSTAGRAM_DIRECT, ON_AD"),
        start_time: z.string().optional().describe("ISO 8601"),
        end_time: z.string().optional().describe("ISO 8601; required with lifetime_budget"),
        status: schema.status,
        extra: schema.extra,
      },
    },
    ({ ad_account_id, extra, ...fields }) => run(() => graph("POST", `${adAccount(ad_account_id)}/adsets`, { ...fields, ...extra })),
  );

  server.registerTool(
    "meta_upload_ad_image",
    {
      title: "Upload ad image",
      description: "Download an image from a URL and upload it to the ad account; returns the image hash for creatives.",
      inputSchema: { ad_account_id: schema.adAccountId, image_url: z.string().url() },
    },
    ({ ad_account_id, image_url }) =>
      run(async () => {
        const res = await fetch(image_url);
        if (!res.ok) throw new Error(`Could not download image: HTTP ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer()).toString("base64");
        return graph("POST", `${adAccount(ad_account_id)}/adimages`, { bytes });
      }),
  );

  server.registerTool(
    "meta_create_creative",
    {
      title: "Create ad creative",
      description:
        "Create a link/image ad creative for a Page (and optionally Instagram). For video, carousel or other formats pass a full object_story_spec.",
      inputSchema: {
        ad_account_id: schema.adAccountId,
        name: z.string(),
        page_id: z.string().optional(),
        instagram_user_id: z.string().optional(),
        link: z.string().url().optional(),
        message: z.string().optional().describe("Primary text"),
        headline: z.string().optional(),
        description: z.string().optional(),
        image_hash: z.string().optional().describe("From meta_upload_ad_image"),
        picture: z.string().url().optional().describe("Image URL, alternative to image_hash"),
        call_to_action: z.string().optional().describe("e.g. SHOP_NOW, LEARN_MORE, SIGN_UP, CONTACT_US, MESSAGE_PAGE"),
        object_story_spec: z.record(z.unknown()).optional().describe("Full spec; overrides the simple fields above"),
        url_tags: z.string().optional().describe("e.g. utm_source=facebook&utm_medium=paid"),
        extra: schema.extra,
      },
    },
    (args) =>
      run(() => {
        const spec = args.object_story_spec ?? {
          page_id: args.page_id,
          instagram_user_id: args.instagram_user_id,
          link_data: {
            link: args.link,
            message: args.message,
            name: args.headline,
            description: args.description,
            image_hash: args.image_hash,
            picture: args.picture,
            call_to_action: args.call_to_action ? { type: args.call_to_action, value: { link: args.link } } : undefined,
          },
        };
        return graph("POST", `${adAccount(args.ad_account_id)}/adcreatives`, {
          name: args.name,
          object_story_spec: spec,
          url_tags: args.url_tags,
          ...args.extra,
        });
      }),
  );

  server.registerTool(
    "meta_create_ad",
    {
      title: "Create ad",
      description: "Create an ad in an ad set from an existing creative.",
      inputSchema: {
        ad_account_id: schema.adAccountId,
        adset_id: z.string(),
        name: z.string(),
        creative_id: z.string(),
        status: schema.status,
        extra: schema.extra,
      },
    },
    ({ ad_account_id, adset_id, name, creative_id, status, extra }) =>
      run(() =>
        graph("POST", `${adAccount(ad_account_id)}/ads`, { adset_id, name, creative: { creative_id }, status, ...extra }),
      ),
  );

  server.registerTool(
    "meta_update_object",
    {
      title: "Update Meta object",
      description:
        "Update any campaign, ad set, ad or other object, e.g. {\"name\":\"...\"}, {\"daily_budget\":80000}, {\"status\":\"ACTIVE\"}, {\"targeting\":{...}}.",
      inputSchema: { id: z.string(), fields: z.record(z.unknown()) },
    },
    ({ id, fields }) => run(() => graph("POST", id, fields)),
  );

  server.registerTool(
    "meta_set_status",
    {
      title: "Set status",
      description: "Turn campaigns, ad sets or ads on/off in bulk.",
      inputSchema: { ids: z.array(z.string()).min(1), status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]) },
    },
    ({ ids, status }) =>
      run(async () => {
        const results: Record<string, unknown> = {};
        for (const id of ids) {
          results[id] = await graph("POST", id, { status }).catch((e: Error) => ({ error: e.message }));
        }
        return results;
      }),
  );

  server.registerTool(
    "meta_delete_object",
    {
      title: "Delete Meta object",
      description: "Permanently delete a campaign, ad set, ad, creative, audience or post. Prefer meta_set_status ARCHIVED when unsure.",
      inputSchema: { id: z.string(), confirm: z.literal(true).describe("Must be true; deletion cannot be undone") },
    },
    ({ id }) => run(() => graph("DELETE", id)),
  );

  server.registerTool(
    "meta_get_insights",
    {
      title: "Get ad insights",
      description:
        "Performance report for an ad account, campaign, ad set or ad. Use date_preset (today, yesterday, last_7d, last_30d, this_month, last_month, maximum) or since/until.",
      inputSchema: {
        object_id: z.string().optional().describe("Campaign/ad set/ad ID; defaults to the ad account"),
        ad_account_id: schema.adAccountId,
        level: z.enum(["account", "campaign", "adset", "ad"]).optional(),
        date_preset: z.string().optional(),
        since: z.string().optional().describe("YYYY-MM-DD"),
        until: z.string().optional().describe("YYYY-MM-DD"),
        time_increment: z.string().optional().describe("1 for daily, 7 for weekly, all_days, monthly"),
        breakdowns: z.string().optional().describe("e.g. age,gender or publisher_platform,platform_position or country"),
        action_breakdowns: z.string().optional(),
        filtering: z.array(z.record(z.unknown())).optional(),
        fields: schema.fields(
          "campaign_name,adset_name,ad_name,spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions,action_values,cost_per_action_type,purchase_roas",
        ),
        limit: schema.limit,
      },
    },
    ({ object_id, ad_account_id, since, until, date_preset, limit, ...params }) =>
      run(() =>
        graphList(
          `${object_id ?? adAccount(ad_account_id)}/insights`,
          {
            ...params,
            date_preset: since ? undefined : (date_preset ?? "last_7d"),
            time_range: since ? { since, until: until ?? since } : undefined,
          },
          limit,
        ),
      ),
  );

  server.registerTool(
    "meta_targeting_search",
    {
      title: "Search targeting options",
      description: "Find interest, behavior, location, language, school or employer IDs for ad set targeting.",
      inputSchema: {
        type: z.enum(["adinterest", "adinterestsuggestion", "adgeolocation", "adlocale", "adeducationschool", "adworkemployer", "adworkposition", "adTargetingCategory"]),
        q: z.string().optional().describe("Search text"),
        class: z.string().optional().describe("For adTargetingCategory: behaviors, demographics, life_events, ..."),
        interest_list: z.array(z.string()).optional().describe("For adinterestsuggestion"),
        location_types: z.array(z.string()).optional().describe("For adgeolocation: country, region, city, zip"),
        limit: schema.limit,
      },
    },
    ({ limit, ...params }) => run(() => graphList("search", params, limit)),
  );

  server.registerTool(
    "meta_delivery_estimate",
    {
      title: "Audience size estimate",
      description: "Estimate audience size / daily results for a targeting spec.",
      inputSchema: {
        ad_account_id: schema.adAccountId,
        targeting_spec: z.record(z.unknown()),
        optimization_goal: z.string().default("REACH"),
        promoted_object: z.record(z.unknown()).optional(),
      },
    },
    ({ ad_account_id, ...params }) => run(() => graph("GET", `${adAccount(ad_account_id)}/delivery_estimate`, params)),
  );

  server.registerTool(
    "meta_ad_preview",
    {
      title: "Ad preview",
      description: "Get an iframe preview of an ad or creative in a placement.",
      inputSchema: {
        id: z.string().describe("Ad ID or creative ID"),
        ad_format: z.string().default("MOBILE_FEED_STANDARD").describe("e.g. DESKTOP_FEED_STANDARD, INSTAGRAM_STANDARD, INSTAGRAM_STORY"),
      },
    },
    ({ id, ad_format }) => run(() => graph("GET", `${id}/previews`, { ad_format })),
  );
}
