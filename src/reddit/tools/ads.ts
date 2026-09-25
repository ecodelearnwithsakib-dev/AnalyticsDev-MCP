import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv } from "../../shared/env.js";
import { run } from "../../shared/server.js";
import { adAccountId, ads, adsAll, confirm, fromMicros, PRESET, reportWindow, sha256, toMicros, type Rec } from "../client.js";

const ACCOUNT = z.string().optional().describe("Ad account ID (t2_… / a2_…); defaults to REDDIT_AD_ACCOUNT_ID");

const LEVEL_KEY = { account: "AD_ACCOUNT_ID", campaign: "CAMPAIGN_ID", ad_group: "AD_GROUP_ID", ad: "AD_ID" } as const;
const DEFAULT_FIELDS = ["IMPRESSIONS", "REACH", "FREQUENCY", "CLICKS", "SPEND", "CTR", "CPC", "ECPM", "KEY_CONVERSION_TOTAL_COUNT", "KEY_CONVERSION_ECPA", "CONVERSION_PURCHASE_CLICKS", "CONVERSION_PURCHASE_VIEWS", "CONVERSION_PURCHASE_TOTAL_VALUE", "CONVERSION_LEAD_CLICKS", "CONVERSION_SIGN_UP_CLICKS"];

/** Report values: SPEND/CPC/CPV/ECPM/…ECPA are micro-currency; CONVERSION_*_TOTAL_VALUE is in cents. */
function readable(row: Rec): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(row)) {
    const K = k.toUpperCase();
    if (v === null || v === undefined) continue;
    if (/^(SPEND|CPC|CPV|ECPM)$/.test(K) || /ECPA$/.test(K) || /^APP_INSTALL.*REVENUE/.test(K) || /^COST_PER/.test(K)) out[k.toLowerCase()] = fromMicros(v);
    else if (/^CONVERSION.*TOTAL_VALUE$/.test(K)) out[k.toLowerCase()] = Math.round(Number(v)) / 100;
    else out[k.toLowerCase()] = v;
  }
  return out;
}

const status = (e: Rec) => e.effective_status ?? e.configured_status;

export function registerAdsTools(server: McpServer): void {
  server.registerTool(
    "reddit_ads_accounts",
    {
      title: "Ads: accounts & assets",
      description: "Reddit Ads setup: who am I, businesses, ad accounts (per business), one account's details, funding instruments, pixels (with last fired time), profiles, and feature access.",
      inputSchema: {
        what: z.enum(["me", "businesses", "ad_accounts", "account", "funding", "pixels", "profiles", "feature_access"]),
        business_id: z.string().optional(),
        ad_account_id: ACCOUNT,
      },
    },
    (a) =>
      run(async () => {
        switch (a.what) {
          case "me":
            return (await ads<{ data: Rec }>("/me")).data;
          case "businesses":
            return (await ads<{ data: Rec[] }>("/me/businesses")).data;
          case "ad_accounts": {
            const biz = a.business_id ?? optionalEnv("REDDIT_BUSINESS_ID") ?? ((await ads<{ data: Rec[] }>("/me/businesses")).data?.[0]?.id as string);
            return (await adsAll(`/businesses/${biz}/ad_accounts`)).map((x) => ({ id: x.id, name: x.name, currency: x.currency, time_zone: x.time_zone_id, status: x.admin_approval ?? x.status }));
          }
          case "account":
            return (await ads<{ data: Rec }>(`/ad_accounts/${adAccountId(a.ad_account_id)}`)).data;
          case "funding":
            return (await adsAll(`/ad_accounts/${adAccountId(a.ad_account_id)}/funding_instruments`)).map((f) => ({ id: f.id, name: f.name, type: f.type, currency: f.currency, credit_limit: fromMicros(f.credit_limit), start: f.start_time, end: f.end_time }));
          case "pixels": {
            const pixels = await adsAll(`/ad_accounts/${adAccountId(a.ad_account_id)}/pixels`);
            return Promise.all(pixels.map(async (p) => ({ id: p.id, name: p.name, last_fired_at: await ads<{ data?: Rec }>(`/pixels/${p.id}/last_fired_at`).then((r) => r.data?.last_fired_at ?? r.data).catch(() => undefined) })));
          }
          case "profiles":
            return (await adsAll(`/ad_accounts/${adAccountId(a.ad_account_id)}/profiles`)).map((p) => ({ id: p.id, name: p.name ?? p.display_name }));
          case "feature_access":
            return (await ads<{ data: Rec }>("/feature_access")).data;
        }
      }),
  );

  server.registerTool(
    "reddit_ads_report",
    {
      title: "Ads: performance report",
      description:
        "Reddit Ads metrics for a period at account/campaign/ad group/ad level, optionally broken down by DATE, COUNTRY, REGION, COMMUNITY (subreddit), PLACEMENT, KEYWORD, INTEREST, GENDER, OS_TYPE, HOUR… — impressions, reach, frequency, clicks, spend, CTR, CPC, eCPM, conversions, purchase value, ROAS and CPA, with names attached and totals. Money is converted from micros/cents automatically.",
      inputSchema: {
        ad_account_id: ACCOUNT,
        level: z.enum(["account", "campaign", "ad_group", "ad"]).default("campaign"),
        breakdowns: z.array(z.enum(["DATE", "HOUR", "COUNTRY", "REGION", "DMA", "COMMUNITY", "PLACEMENT", "KEYWORD", "INTEREST", "GENDER", "OS_TYPE", "LANGUAGE", "ASSET_ID"])).max(2).optional(),
        preset: PRESET.describe("Default last_7_days (complete UTC days)"),
        from: z.string().optional(),
        to: z.string().optional(),
        fields: z.array(z.string()).optional().describe("Report fields (default: delivery + key conversions + purchases)"),
        filter: z.string().optional().describe("Reddit filter syntax, e.g. campaign_id==123"),
        time_zone_id: z.string().optional().describe("e.g. Asia/Dhaka (default UTC)"),
        sort_by: z.string().default("spend"),
        limit: z.number().int().min(1).max(5000).default(200),
      },
    },
    (a) =>
      run(async () => {
        const acct = adAccountId(a.ad_account_id);
        const w = reportWindow(a.preset, a.from, a.to);
        const breakdowns = [LEVEL_KEY[a.level], ...(a.breakdowns ?? [])].filter((b, i, arr) => arr.indexOf(b) === i);
        const rows: Rec[] = [];
        let token: string | undefined;
        do {
          const res = await ads<{ data?: { metrics?: Rec[] } | Rec[]; pagination?: { next_url?: string } }>(`/ad_accounts/${acct}/reports`, {
            method: "POST",
            query: { "page.size": 1000, "page.token": token },
            body: { data: { starts_at: w.starts_at, ends_at: w.ends_at, fields: a.fields ?? DEFAULT_FIELDS, breakdowns, filter: a.filter, time_zone_id: a.time_zone_id } },
          });
          const data = res.data as { metrics?: Rec[] } | Rec[] | undefined;
          rows.push(...(Array.isArray(data) ? data : data?.metrics ?? []));
          token = res.pagination?.next_url ? new URL(res.pagination.next_url).searchParams.get("page.token") ?? undefined : undefined;
        } while (token && rows.length < 20000);
        // Attach names for the level's entity.
        const names = new Map<string, string>();
        if (a.level !== "account") {
          const path = { campaign: "campaigns", ad_group: "ad_groups", ad: "ads" }[a.level];
          for (const e of await adsAll(`/ad_accounts/${acct}/${path}`, {}, 5000).catch(() => [] as Rec[])) names.set(String(e.id), String(e.name));
        }
        const idKey = LEVEL_KEY[a.level].toLowerCase();
        const shaped = rows.map((r) => {
          const x = readable(r);
          const spend = Number(x.spend ?? 0);
          const value = Number(x.conversion_purchase_total_value ?? 0);
          const conv = Number(x.key_conversion_total_count ?? 0);
          return { ...(a.level !== "account" ? { name: names.get(String(x[idKey] ?? x.id)) } : {}), ...x, roas: spend && value ? Math.round((value / spend) * 100) / 100 : undefined, cpa: spend && conv ? Math.round((spend / conv) * 100) / 100 : undefined };
        });
        const sum = (k: string) => Math.round(shaped.reduce((s, r) => s + (Number((r as Rec)[k]) || 0), 0) * 100) / 100;
        const totals = { impressions: sum("impressions"), clicks: sum("clicks"), spend: sum("spend"), conversions: sum("key_conversion_total_count"), purchase_value: sum("conversion_purchase_total_value") };
        return {
          window: { from: w.from, to: w.to, time_zone: a.time_zone_id ?? "UTC" },
          totals: { ...totals, ctr_pct: totals.impressions ? Math.round((totals.clicks / totals.impressions) * 10000) / 100 : 0, cpc: totals.clicks ? Math.round((totals.spend / totals.clicks) * 100) / 100 : 0, cpa: totals.conversions ? Math.round((totals.spend / totals.conversions) * 100) / 100 : undefined, roas: totals.spend ? Math.round((totals.purchase_value / totals.spend) * 100) / 100 : undefined },
          rows: shaped.sort((x, y) => Number((y as Rec)[a.sort_by] ?? 0) - Number((x as Rec)[a.sort_by] ?? 0)).slice(0, a.limit),
        };
      }),
  );

  server.registerTool(
    "reddit_ads_manage",
    {
      title: "Ads: campaigns, ad groups & ads",
      description:
        "Manage Reddit Ads: list campaigns, ad groups or ads (status, budget, bids in account currency), get one, pause/activate/archive (delete needs confirm), change budget or bid, and create a campaign → ad group (subreddit/interest/keyword/geo/device targeting) → ad from a promoted post. New items start PAUSED unless you say otherwise.",
      inputSchema: {
        action: z.enum(["list", "get", "set_status", "update", "create_campaign", "create_ad_group", "create_ad"]),
        entity: z.enum(["campaign", "ad_group", "ad"]).default("campaign"),
        ad_account_id: ACCOUNT,
        id: z.string().optional(),
        status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"]).optional(),
        name: z.string().optional(),
        objective: z.enum(["CLICKS", "CONVERSIONS", "IMPRESSIONS", "VIDEO_VIEWABLE_IMPRESSIONS", "LEAD_GENERATION", "APP_INSTALLS", "CATALOG_SALES"]).optional(),
        daily_budget: z.number().optional().describe("Account currency (converted to micros)"),
        lifetime_budget: z.number().optional(),
        bid: z.number().optional().describe("Bid in account currency"),
        bid_type: z.enum(["CPC", "CPM", "CPV", "CPV6"]).optional(),
        bid_strategy: z.enum(["BIDLESS", "MAXIMIZE_VOLUME", "TARGET_CPX"]).optional(),
        optimization_goal: z.string().optional().describe("e.g. PURCHASE, LEAD, SIGN_UP, PAGE_VISIT, CLICKS"),
        campaign_id: z.string().optional(),
        ad_group_id: z.string().optional(),
        funding_instrument_id: z.string().optional(),
        pixel_id: z.string().optional(),
        start: z.string().optional().describe("ISO start time (default now)"),
        end: z.string().optional(),
        targeting: z
          .object({
            communities: z.array(z.string()).optional().describe("Subreddit names"),
            excluded_communities: z.array(z.string()).optional(),
            interests: z.array(z.string()).optional().describe("Interest IDs (see reddit_ads_targeting)"),
            keywords: z.array(z.string()).optional(),
            geolocations: z.array(z.string()).optional().describe("Geo IDs like US, BD, US_CA (see reddit_ads_targeting)"),
            devices: z.array(z.object({ type: z.enum(["DESKTOP", "MOBILE"]), os: z.enum(["ANDROID", "IOS"]).optional() })).optional(),
            custom_audience_ids: z.array(z.string()).optional(),
            gender: z.enum(["FEMALE", "MALE"]).optional(),
            expand_targeting: z.boolean().optional(),
          })
          .optional(),
        post_id: z.string().optional().describe("create_ad: the promoted post (t3_…) — make one with reddit_ads_api /profiles/{id}/posts"),
        click_url: z.string().url().optional(),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        const acct = adAccountId(a.ad_account_id);
        const path = { campaign: "campaigns", ad_group: "ad_groups", ad: "ads" }[a.entity];
        const brief = (e: Rec) => ({ id: e.id, name: e.name, status: status(e), objective: e.objective ?? e.campaign_objective_type, daily_budget: e.goal_type === "DAILY_SPEND" ? fromMicros(e.goal_value) : undefined, lifetime_budget: e.goal_type === "LIFETIME_SPEND" ? fromMicros(e.goal_value) : undefined, bid: fromMicros(e.bid_value), bid_type: e.bid_type ?? undefined, bid_strategy: e.bid_strategy ?? undefined, campaign_id: e.campaign_id, ad_group_id: e.ad_group_id, start: e.start_time, end: e.end_time ?? undefined, rejection: e.rejection_reason ?? undefined });
        const budget = (): Rec => (a.daily_budget !== undefined ? { goal_type: "DAILY_SPEND", goal_value: toMicros(a.daily_budget) } : a.lifetime_budget !== undefined ? { goal_type: "LIFETIME_SPEND", goal_value: toMicros(a.lifetime_budget) } : {});
        const bidding = (): Rec => ({ ...(a.bid !== undefined ? { bid_value: toMicros(a.bid) } : {}), ...(a.bid_type ? { bid_type: a.bid_type } : {}), ...(a.bid_strategy ? { bid_strategy: a.bid_strategy } : {}) });
        switch (a.action) {
          case "list": {
            const rows = await adsAll(`/ad_accounts/${acct}/${path}`, {}, 5000);
            return { count: rows.length, [path]: rows.filter((e) => (!a.campaign_id || e.campaign_id === a.campaign_id) && (!a.ad_group_id || e.ad_group_id === a.ad_group_id)).map(brief) };
          }
          case "get":
            if (!a.id) throw new Error("id is required");
            return (await ads<{ data: Rec }>(`/${path}/${a.id}`)).data;
          case "set_status":
            if (!a.id || !a.status) throw new Error("id and status are required");
            if (a.status === "DELETED" && !a.confirm) throw new Error("Deleting can't be undone — prefer ARCHIVED; set confirm: true");
            return brief((await ads<{ data: Rec }>(`/${path}/${a.id}`, { method: "PATCH", body: { data: { configured_status: a.status } } })).data);
          case "update": {
            if (!a.id) throw new Error("id is required");
            const data: Rec = { ...budget(), ...bidding() };
            if (a.name) data.name = a.name;
            if (a.end) data.end_time = new Date(a.end).toISOString();
            if (a.entity === "ad_group" && a.targeting) data.targeting = a.targeting;
            if (a.entity === "ad" && a.click_url) data.click_url = a.click_url;
            if (!Object.keys(data).length) throw new Error("Nothing to change");
            return brief((await ads<{ data: Rec }>(`/${path}/${a.id}`, { method: "PATCH", body: { data } })).data);
          }
          case "create_campaign": {
            if (!a.name || !a.objective) throw new Error("name and objective are required");
            const data: Rec = { name: a.name, objective: a.objective, configured_status: a.status ?? "PAUSED", funding_instrument_id: a.funding_instrument_id, ...budget(), ...bidding(), start_time: a.start ? new Date(a.start).toISOString() : undefined, end_time: a.end ? new Date(a.end).toISOString() : undefined };
            return brief((await ads<{ data: Rec }>(`/ad_accounts/${acct}/campaigns`, { body: { data } })).data);
          }
          case "create_ad_group": {
            if (!a.name || !a.campaign_id) throw new Error("name and campaign_id are required");
            const data: Rec = {
              name: a.name,
              campaign_id: a.campaign_id,
              configured_status: a.status ?? "PAUSED",
              ...budget(),
              ...bidding(),
              optimization_goal: a.optimization_goal,
              conversion_pixel_id: a.pixel_id,
              start_time: new Date(a.start ?? Date.now()).toISOString(),
              end_time: a.end ? new Date(a.end).toISOString() : undefined,
              targeting: a.targeting ? { ...a.targeting, communities: a.targeting.communities?.map((c) => c.replace(/^r\//, "")), excluded_communities: a.targeting.excluded_communities?.map((c) => c.replace(/^r\//, "")) } : undefined,
            };
            return brief((await ads<{ data: Rec }>(`/ad_accounts/${acct}/ad_groups`, { body: { data } })).data);
          }
          case "create_ad":
            if (!a.name || !a.ad_group_id || !a.post_id) throw new Error("name, ad_group_id and post_id are required");
            return brief((await ads<{ data: Rec }>(`/ad_accounts/${acct}/ads`, { body: { data: { name: a.name, ad_group_id: a.ad_group_id, post_id: a.post_id, click_url: a.click_url, configured_status: a.status ?? "PAUSED" } } })).data);
        }
      }),
  );

  server.registerTool(
    "reddit_ads_targeting",
    {
      title: "Ads: targeting & planning",
      description: "Plan Reddit targeting: search subreddits (with subscriber counts), community suggestions from a website or seed, interests, geolocations (country, region, city, postal code), devices, languages, keyword suggestions from seeds, and bid suggestions for a targeting setup.",
      inputSchema: {
        what: z.enum(["communities", "community_suggestions", "interests", "geolocations", "devices", "languages", "keywords", "bid_suggestion"]),
        query: z.string().optional().describe("communities: search text; community_suggestions: a website URL or subreddit; geolocations: city search"),
        country: z.string().optional().describe("geolocations: 2-letter country"),
        postal_code: z.string().optional(),
        seeds: z.array(z.string()).optional().describe("keywords: seed keywords"),
        ad_account_id: ACCOUNT,
        objective: z.string().optional(),
        bid_type: z.enum(["CPC", "CPM", "CPV", "CPV6"]).default("CPC"),
        targeting: z.record(z.unknown()).optional(),
      },
    },
    (a) =>
      run(async () => {
        switch (a.what) {
          case "communities":
            if (!a.query) throw new Error("query is required");
            return ((await ads<{ data: Rec[] }>("/targeting/communities/search", { query: { query: a.query, "page.size": 50 } })).data ?? []).map((c) => ({ name: c.name, id: c.id, subscribers: c.subscriber_count, description: String(c.description ?? "").slice(0, 120) }));
          case "community_suggestions":
            if (!a.query) throw new Error("query (website URL or subreddit) is required");
            return (await ads<{ data: Rec[] }>("/targeting/communities/suggestions", { query: a.query.startsWith("http") ? { website_url: a.query } : { names: a.query.replace(/^r\//, "") } })).data;
          case "interests":
            return ((await ads<{ data: Rec[] }>("/targeting/interests")).data ?? []).map((i) => ({ id: i.id, name: i.name, category: i.category }));
          case "geolocations":
            return (await ads<{ data: Rec[] }>("/targeting/geolocations", { query: { country: a.country, cities_search: a.query, postal_code: a.postal_code } })).data;
          case "devices":
            return (await ads<{ data: Rec[] }>("/targeting/devices")).data;
          case "languages":
            return (await ads<{ data: Rec[] }>("/targeting/languages")).data;
          case "keywords":
            if (!a.seeds?.length) throw new Error("seeds is required");
            return (await ads<{ data: Rec[] }>("/targeting/keyword_suggestions", { body: { data: { seed_keywords: a.seeds } } })).data;
          case "bid_suggestion": {
            const res = await ads<{ data: Rec }>("/forecasting/bid_suggestions", { body: { data: { ad_account_id: adAccountId(a.ad_account_id), bid_type: a.bid_type, objective: a.objective, targeting: a.targeting ?? {} } } });
            return Object.fromEntries(Object.entries(res.data ?? {}).map(([k, v]) => [k, /bid/.test(k) && typeof v === "number" ? fromMicros(v) : v]));
          }
        }
      }),
  );

  server.registerTool(
    "reddit_ads_conversions",
    {
      title: "Ads: Conversions API",
      description:
        "Send server-side conversion events to a Reddit pixel (Conversions API v3): Purchase, Lead, SignUp, AddToCart, ViewContent, PageVisit, Search, AddToWishlist or custom — with value, currency, conversion_id for dedup with the pixel, click id (rdt_cid), and user data (email/phone/external id hashed locally with SHA-256). Use test_id to validate in Events Manager first; real sends need confirm.",
      inputSchema: {
        pixel_id: z.string().optional().describe("Defaults to REDDIT_PIXEL_ID"),
        test_id: z.string().optional().describe("Test ID from Events Manager → Test (events are not attributed)"),
        events: z
          .array(
            z.object({
              type: z.enum(["PURCHASE", "LEAD", "SIGN_UP", "ADD_TO_CART", "VIEW_CONTENT", "PAGE_VISIT", "SEARCH", "ADD_TO_WISHLIST", "CUSTOM"]),
              custom_event_name: z.string().optional(),
              event_at: z.string().optional().describe("ISO time (default now; max 7 days old)"),
              action_source: z.enum(["WEBSITE", "APP", "PHYSICAL_STORE", "OTHER"]).default("WEBSITE"),
              click_id: z.string().optional().describe("rdt_cid from the landing URL"),
              event_source_url: z.string().optional(),
              value: z.number().optional(),
              currency: z.string().optional(),
              conversion_id: z.string().optional().describe("Same id as the pixel event for deduplication"),
              item_count: z.number().int().optional(),
              email: z.string().optional(),
              phone: z.string().optional(),
              external_id: z.string().optional(),
              ip_address: z.string().optional(),
              user_agent: z.string().optional(),
            }),
          )
          .min(1)
          .max(1000),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        const pixel = a.pixel_id ?? optionalEnv("REDDIT_PIXEL_ID");
        if (!pixel) throw new Error("pixel_id is required (or set REDDIT_PIXEL_ID)");
        if (!a.test_id && !a.confirm) throw new Error("These events count as real conversions — pass test_id to validate first, or confirm: true to send");
        const events = a.events.map((e) => ({
          event_at: Date.parse(e.event_at ?? new Date().toISOString()),
          action_source: e.action_source,
          click_id: e.click_id,
          event_source_url: e.event_source_url,
          type: { tracking_type: e.type, custom_event_name: e.type === "CUSTOM" ? e.custom_event_name : undefined },
          metadata: { conversion_id: e.conversion_id, value: e.value, currency: e.currency, item_count: e.item_count },
          user: {
            email: e.email ? sha256(e.email, "email") : undefined,
            phone_number: e.phone ? sha256(e.phone, "phone") : undefined,
            external_id: e.external_id ? sha256(e.external_id) : undefined,
            ip_address: e.ip_address,
            user_agent: e.user_agent,
          },
        }));
        const bearer = optionalEnv("REDDIT_CONVERSION_TOKEN") || undefined;
        const res = await ads<Rec>(`/pixels/${pixel}/conversion_events`, { body: { data: { test_id: a.test_id, events } }, bearer });
        return { sent: events.length, test: !!a.test_id, response: res };
      }),
  );

  server.registerTool(
    "reddit_ads_audiences",
    {
      title: "Ads: custom audiences",
      description: "Customer-list audiences: list custom and saved audiences, create a customer list, add or remove users (emails hashed locally with SHA-256, or mobile ad IDs), and delete an audience (confirm).",
      inputSchema: {
        action: z.enum(["list", "saved", "get", "create", "add_users", "remove_users", "delete"]),
        ad_account_id: ACCOUNT,
        id: z.string().optional(),
        name: z.string().optional(),
        emails: z.array(z.string()).optional(),
        mobile_ad_ids: z.array(z.string()).optional(),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        const acct = adAccountId(a.ad_account_id);
        switch (a.action) {
          case "list":
            return (await adsAll(`/ad_accounts/${acct}/custom_audiences`)).map((c) => ({ id: c.id, name: c.name, status: c.status, size: c.size_range_lower ? `${c.size_range_lower}–${c.size_range_upper}` : undefined, type: c.type }));
          case "saved":
            return (await adsAll(`/ad_accounts/${acct}/saved_audiences`)).map((c) => ({ id: c.id, name: c.name }));
          case "get":
            return (await ads<{ data: Rec }>(`/custom_audiences/${a.id}`)).data;
          case "create":
            if (!a.name) throw new Error("name is required");
            return (await ads<{ data: Rec }>(`/ad_accounts/${acct}/custom_audiences`, { body: { data: { name: a.name, type: "CUSTOMER_LIST" } } })).data;
          case "add_users":
          case "remove_users": {
            if (!a.id) throw new Error("id is required");
            const rows = [...(a.emails ?? []).map((e) => [sha256(e, "email")]), ...(a.mobile_ad_ids ?? []).map((m) => [sha256(m.toLowerCase())])];
            if (!rows.length) throw new Error("emails or mobile_ad_ids are required");
            const column = a.emails?.length ? "EMAIL_SHA256" : "MAID_SHA256";
            if (a.emails?.length && a.mobile_ad_ids?.length) throw new Error("Send emails and mobile ad IDs in separate calls");
            let done = 0;
            for (let i = 0; i < rows.length; i += 2500) {
              await ads(`/custom_audiences/${a.id}/users`, { method: "PATCH", body: { data: { action_type: a.action === "add_users" ? "ADD" : "REMOVE", column_order: [column], user_data: rows.slice(i, i + 2500) } } });
              done += rows.slice(i, i + 2500).length;
            }
            return { audience: a.id, [a.action === "add_users" ? "added" : "removed"]: done, hashed: true };
          }
          case "delete":
            if (!a.id) throw new Error("id is required");
            if (!a.confirm) throw new Error("Deleting an audience removes it from ad groups using it; set confirm: true");
            await ads(`/custom_audiences/${a.id}`, { method: "DELETE" });
            return { deleted: a.id };
        }
      }),
  );

  server.registerTool(
    "reddit_ads_api",
    {
      title: "Ads: any endpoint",
      description: "Call ANY Reddit Ads API v3 endpoint (https://ads-api.reddit.com/api/v3), e.g. /profiles/{id}/posts to create a promoted post, /ad_accounts/{id}/lead_gen_forms, product catalogs and feeds, /channel_planning/reach, /ad_accounts/{id}/history.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"),
        path: z.string(),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional(),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        if (a.method === "DELETE" && !a.confirm) throw new Error("DELETE calls need confirm: true");
        return ads(a.path.replace("{ad_account_id}", adAccountId()), { method: a.method, query: a.query, body: a.body });
      }),
  );
}
