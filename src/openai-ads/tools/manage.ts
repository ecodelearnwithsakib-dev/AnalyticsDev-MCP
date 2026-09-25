import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { humanize, KINDS, listAll, oai, schema, toMicros, unixTime, type Kind } from "../client.js";

const platform = z.enum(["web", "desktop_web", "ios_web", "android_web", "ios_app", "android_app"]);

const targetingInput = {
  countries: z.array(z.string()).optional().describe("ISO country codes, e.g. [\"US\",\"GB\"]"),
  location_ids: z.array(z.string()).optional().describe("Region/market IDs from oai_ads_geo_lookup"),
  excluded_countries: z.array(z.string()).optional(),
  excluded_location_ids: z.array(z.string()).optional(),
  platforms: z.array(platform).optional().describe("Where ads can show; omit for all ChatGPT apps and web"),
  include_audience_ids: z.array(z.string()).optional().describe("Custom audiences to target"),
  exclude_audience_ids: z.array(z.string()).optional().describe("Custom audiences to exclude"),
};
type TargetingArgs = { [K in keyof typeof targetingInput]?: z.infer<(typeof targetingInput)[K]> };

function buildTargeting(a: TargetingArgs): Record<string, unknown> | undefined {
  const t: Record<string, unknown> = {};
  const locations = (countries?: string[], ids?: string[]) =>
    countries?.length || ids?.length
      ? { ...(countries?.length && { countries: countries.map((c) => c.toUpperCase()) }), ...(ids?.length && { include: ids.map((id) => ({ id })) }) }
      : undefined;
  const include = locations(a.countries, a.location_ids);
  const exclude = locations(a.excluded_countries, a.excluded_location_ids);
  if (include) t.locations = include;
  if (exclude) t.excluded_locations = exclude;
  if (a.platforms?.length) t.platforms = { included: a.platforms };
  if (a.include_audience_ids?.length) t.custom_audiences = { ids: a.include_audience_ids };
  if (a.exclude_audience_ids?.length) t.excluded_custom_audiences = { ids: a.exclude_audience_ids };
  return Object.keys(t).length ? t : undefined;
}

const campaignInput = {
  name: z.string().min(3),
  objective: z.enum(["impressions", "clicks", "conversions"]).default("clicks").describe("Campaign bidding_type: what to optimize for"),
  daily_budget: z.number().positive().optional().describe("Daily budget in account currency (required for maximize_* strategies)"),
  lifetime_budget: z.number().positive().optional().describe("Lifetime budget in account currency"),
  conversion_event_setting_id: z.string().optional().describe("Required for objective=conversions; a standard event setting (ces_...)"),
  start_date: z.string().optional().describe("YYYY-MM-DD or ISO datetime"),
  end_date: z.string().optional(),
  description: z.string().optional(),
  product_feed_id: z.string().optional().describe("Makes this a product-feed campaign"),
  landing_query: schema.landingQuery,
  ...targetingInput,
};

const adGroupInput = {
  name: z.string().min(3),
  context_hints: z.array(z.string()).default([]).describe("Topics/conversations to show in, e.g. [\"trail running shoes\"]"),
  billing_event: z.enum(["impression", "click"]).optional().describe("Defaults from the campaign objective"),
  strategy: z.enum(["fixed_bid", "maximize_clicks", "maximize_conversions"]).optional().describe("Defaults to fixed_bid when max_bid is set, otherwise maximize_* for the objective"),
  max_bid: z.number().positive().optional().describe("Max bid in account currency: per click, or per impression (CPM ÷ 1000)"),
  max_cpm: z.number().positive().optional().describe("Convenience: CPM bid, converted to a per-impression bid"),
  audience_bid_multipliers: z.record(z.number().positive()).optional().describe("{custom_audience_id: multiplier} e.g. {\"caud_1\": 1.5}; fixed_bid only"),
  product_feed_id: z.string().optional(),
  product_filters: z
    .array(z.object({ field: z.string(), operator: z.enum(["in", "not_in", "gt", "gte", "lt", "lte", "contains", "not_contains", "starts_with"]), values: z.array(z.string()) }))
    .optional()
    .describe("Product set filters for product-feed campaigns"),
  description: z.string().optional(),
  landing_query: schema.landingQuery,
};

const adInput = {
  name: z.string().min(1),
  title: z.string().min(3).max(50),
  body: z.string().min(1).max(100),
  target_url: z.string().url(),
  image_url: z.string().url().optional().describe("Public image (≥640×640); uploaded automatically"),
  file_id: z.string().optional().describe("Existing file_id from oai_ads_upload"),
  type: z.enum(["chat_card", "product_ad_template"]).default("chat_card"),
  price: z.string().optional().describe("Shown price text, for product templates"),
  landing_query: schema.landingQuery,
};

async function campaignBody(a: z.infer<z.ZodObject<typeof campaignInput>>) {
  if (!a.daily_budget && !a.lifetime_budget) throw new Error("Set daily_budget or lifetime_budget");
  if (a.objective === "conversions" && !a.conversion_event_setting_id) {
    throw new Error("objective=conversions needs conversion_event_setting_id (see oai_ads_conversion_setup)");
  }
  return {
    name: a.name,
    description: a.description,
    bidding_type: a.objective,
    budget: {
      ...(a.daily_budget && { daily_spend_limit_micros: await toMicros(a.daily_budget) }),
      ...(a.lifetime_budget && { lifetime_spend_limit_micros: await toMicros(a.lifetime_budget) }),
    },
    start_time: a.start_date ? unixTime(a.start_date) : undefined,
    end_time: a.end_date ? unixTime(a.end_date) : undefined,
    targeting: buildTargeting(a),
    conversion_event_setting_ids: a.conversion_event_setting_id ? [a.conversion_event_setting_id] : undefined,
    ...(a.product_feed_id && { mode: "product_feed", product_feed_id: a.product_feed_id }),
    ...(a.landing_query && { landing_page_configuration: { query_string_template: a.landing_query } }),
  };
}

async function biddingConfig(a: z.infer<z.ZodObject<typeof adGroupInput>>, objective: string) {
  const perImpression = a.max_cpm ? a.max_cpm / 1000 : undefined;
  const bid = a.max_bid ?? perImpression;
  const billing = a.billing_event ?? (objective === "impressions" || a.max_cpm ? "impression" : "click");
  const strategy = a.strategy ?? (bid ? "fixed_bid" : objective === "conversions" ? "maximize_conversions" : "maximize_clicks");
  if (strategy === "fixed_bid" && !bid) throw new Error("fixed_bid needs max_bid (or max_cpm)");
  if (strategy !== "fixed_bid" && a.audience_bid_multipliers) throw new Error("Audience bid multipliers work only with fixed_bid");
  return {
    billing_event_type: billing,
    strategy,
    ...(strategy === "fixed_bid" && bid && { max_bid_micros: await toMicros(bid) }),
    ...(a.audience_bid_multipliers && {
      custom_audience_bid_multipliers: Object.entries(a.audience_bid_multipliers).map(([id, m]) => ({
        custom_audience_id: id,
        bid_multiplier_micros: Math.round(m * 1e6),
      })),
    }),
  };
}

function adGroupBody(a: z.infer<z.ZodObject<typeof adGroupInput>>, bidding: Record<string, unknown>) {
  return {
    name: a.name,
    description: a.description,
    context_hints: a.context_hints.length ? a.context_hints : undefined,
    bidding_config: bidding,
    ...(a.product_feed_id && { product_set: { product_feed_id: a.product_feed_id, filters: a.product_filters } }),
    ...(a.landing_query && { landing_page_configuration: { query_string_template: a.landing_query } }),
  };
}

export async function uploadImage(imageUrl?: string, filePath?: string, purpose?: string): Promise<string> {
  let res: unknown;
  if (filePath) {
    const form = new FormData();
    form.append("file", await openAsBlob(filePath), basename(filePath));
    if (purpose) form.append("purpose", purpose);
    res = await oai("POST", "upload", { form });
  } else if (imageUrl) {
    res = await oai("POST", "upload", { body: { image_url: imageUrl, purpose } });
  } else {
    throw new Error("Provide image_url or file_path");
  }
  return (res as { file_id: string }).file_id;
}

async function adBody(a: z.infer<z.ZodObject<typeof adInput>>) {
  const fileId = a.file_id ?? (a.image_url ? await uploadImage(a.image_url) : undefined);
  if (!fileId && a.type === "chat_card") throw new Error("chat_card ads need image_url or file_id");
  return {
    name: a.name,
    creative: { type: a.type, title: a.title, body: a.body, target_url: a.target_url, file_id: fileId, price: a.price },
    ...(a.landing_query && { landing_page_configuration: { query_string_template: a.landing_query } }),
  };
}

/** Keys, passwords and signing secrets (e.g. from POST api_keys or sftp_access) are masked so they never land in chat. */
function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) =>
      /api_key$|password|secret|private_key/i.test(k) && typeof v === "string" ? [k, `${v.slice(0, 4)}…(hidden)`] : [k, redactSecrets(v)],
    ),
  );
}

export function registerManageTools(server: McpServer): void {
  server.registerTool(
    "oai_ads_api_request",
    {
      title: "OpenAI Ads API request",
      description:
        "Call ANY OpenAI Ads API endpoint directly (base https://api.ads.openai.com/v1), e.g. GET ad_groups/adgrp_1 with query {include:[\"bid_too_low\"]}, POST bulk_mutation_jobs, GET lead_sync_subscriptions, POST feeds/{id}/sftp_access. Array query values are sent as key[]=…; objects inside them as JSON.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"),
        path: z.string(),
        query: z.record(z.unknown()).optional(),
        body: z.record(z.unknown()).optional(),
        idempotency_key: z.string().optional(),
      },
    },
    ({ method, path, query, body, idempotency_key }) =>
      run(async () => redactSecrets(await oai(method, path, { query, body, idempotencyKey: idempotency_key }))),
  );

  server.registerTool(
    "oai_ads_list",
    {
      title: "List campaigns / ad groups / ads",
      description: "List campaigns, ad groups or ads (optionally under a parent), with serving issues. Budgets and bids are shown in account currency.",
      inputSchema: {
        kind: schema.kind,
        campaign_id: z.string().optional().describe("For ad_group: only this campaign's ad groups"),
        ad_group_id: z.string().optional().describe("For ad: only this ad group's ads"),
        name: z.string().optional().describe("Filter by name"),
        include_serving_issues: z.boolean().default(true),
        order: z.enum(["asc", "desc"]).default("desc"),
        limit: schema.limit,
      },
    },
    (a) =>
      run(async () =>
        humanize(
          await listAll(
            KINDS[a.kind],
            {
              campaign_id: a.kind === "ad_group" ? a.campaign_id : undefined,
              ad_group_id: a.kind === "ad" ? a.ad_group_id : undefined,
              name: a.name,
              order: a.order,
              include: a.include_serving_issues ? ["serving_issues"] : undefined,
            },
            a.limit,
          ),
        ),
      ),
  );

  server.registerTool(
    "oai_ads_get",
    {
      title: "Get campaign / ad group / ad",
      description: "Full details of one campaign, ad group or ad, including review status, serving issues and (for ad groups) bid_too_low guidance.",
      inputSchema: { kind: schema.kind, id: z.string() },
    },
    ({ kind, id }) =>
      run(async () =>
        humanize(
          await oai("GET", `${KINDS[kind]}/${id}`, {
            query: { include: kind === "ad_group" ? ["serving_issues", "bid_too_low"] : ["serving_issues"] },
          }),
        ),
      ),
  );

  server.registerTool(
    "oai_ads_create_campaign",
    {
      title: "Create campaign",
      description:
        "Create a ChatGPT ads campaign (paused by default): objective, daily or lifetime budget in account currency, schedule, country/region targeting, platforms, custom audiences and conversion goal.",
      inputSchema: { ...campaignInput, status: schema.status },
    },
    (a) => run(async () => humanize(await oai("POST", "campaigns", { body: { ...(await campaignBody(a)), status: a.status }, idempotencyKey: true }))),
  );

  server.registerTool(
    "oai_ads_create_ad_group",
    {
      title: "Create ad group",
      description:
        "Create an ad group (paused by default) with context hints and bidding. Strategy defaults: fixed_bid when max_bid/max_cpm is given, else maximize_clicks/maximize_conversions to match the campaign objective.",
      inputSchema: { campaign_id: z.string(), ...adGroupInput, status: schema.status },
    },
    (a) =>
      run(async () => {
        const campaign = (await oai("GET", `campaigns/${a.campaign_id}`)) as { bidding_type?: string };
        const body = { campaign_id: a.campaign_id, ...adGroupBody(a, await biddingConfig(a, campaign.bidding_type ?? "clicks")), status: a.status };
        return humanize(await oai("POST", "ad_groups", { body, idempotencyKey: true }));
      }),
  );

  server.registerTool(
    "oai_ads_create_ad",
    {
      title: "Create ad",
      description: "Create a chat_card (or product template) ad, paused by default. image_url is uploaded automatically. Creating an ad submits it for review.",
      inputSchema: { ad_group_id: z.string(), ...adInput, status: schema.status },
    },
    (a) => run(async () => oai("POST", "ads", { body: { ad_group_id: a.ad_group_id, ...(await adBody(a)), status: a.status }, idempotencyKey: true })),
  );

  server.registerTool(
    "oai_ads_launch",
    {
      title: "Launch campaign + ad group + ads",
      description:
        "One call to build a full campaign: campaign → ad group → one or more ads, all PAUSED so you can preview before activating with oai_ads_set_status. Stops and reports what was created if a step fails.",
      inputSchema: {
        campaign: z.object(campaignInput),
        ad_group: z.object(adGroupInput),
        ads: z.array(z.object(adInput)).min(1).max(20),
      },
    },
    ({ campaign, ad_group, ads }) =>
      run(async () => {
        const created: Record<string, unknown> = {};
        try {
          const c = (await oai("POST", "campaigns", { body: { ...(await campaignBody(campaign)), status: "paused" }, idempotencyKey: true })) as { id: string };
          created.campaign_id = c.id;
          const bidding = await biddingConfig(ad_group, campaign.objective);
          const g = (await oai("POST", "ad_groups", { body: { campaign_id: c.id, ...adGroupBody(ad_group, bidding), status: "paused" }, idempotencyKey: true })) as { id: string };
          created.ad_group_id = g.id;
          created.ad_ids = [];
          for (const ad of ads) {
            const r = (await oai("POST", "ads", { body: { ad_group_id: g.id, ...(await adBody(ad)), status: "paused" }, idempotencyKey: true })) as { id: string; review_status?: string };
            (created.ad_ids as unknown[]).push({ id: r.id, review_status: r.review_status });
          }
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : error}\nCreated before the failure: ${JSON.stringify(created)}`);
        }
        return { ...created, status: "paused", next: "Preview with oai_ads_preview_ad, then oai_ads_set_status action=activate on the ads, ad group and campaign." };
      }),
  );

  server.registerTool(
    "oai_ads_update",
    {
      title: "Update campaign / ad group / ad",
      description:
        "Change settings. Convenience fields (daily_budget, lifetime_budget, max_bid, name, context_hints, end_date, targeting lists) are converted for you; `changes` is sent as-is for anything else (e.g. {\"creative\":{...}}). Targeting fields replace the campaign's whole targeting object.",
      inputSchema: {
        kind: schema.kind,
        id: z.string(),
        name: z.string().optional(),
        daily_budget: z.number().positive().optional(),
        lifetime_budget: z.number().positive().optional(),
        max_bid: z.number().positive().optional().describe("Ad group fixed bid in account currency"),
        context_hints: z.array(z.string()).optional(),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        ...targetingInput,
        changes: z.record(z.unknown()).optional(),
      },
    },
    (a) =>
      run(async () => {
        const body: Record<string, unknown> = { ...(a.name && { name: a.name }) };
        if (a.kind === "campaign") {
          if (a.daily_budget || a.lifetime_budget) {
            body.budget = {
              ...(a.daily_budget && { daily_spend_limit_micros: await toMicros(a.daily_budget) }),
              ...(a.lifetime_budget && { lifetime_spend_limit_micros: await toMicros(a.lifetime_budget) }),
            };
          }
          if (a.start_date) body.start_time = unixTime(a.start_date);
          if (a.end_date) body.end_time = unixTime(a.end_date);
          const targeting = buildTargeting(a);
          if (targeting) body.targeting = targeting;
        }
        if (a.kind === "ad_group") {
          if (a.context_hints) body.context_hints = a.context_hints;
          if (a.max_bid) {
            const current = (await oai("GET", `ad_groups/${a.id}`)) as { bidding_config?: Record<string, unknown> };
            body.bidding_config = { ...current.bidding_config, strategy: "fixed_bid", max_bid_micros: await toMicros(a.max_bid) };
          }
        }
        Object.assign(body, a.changes);
        if (!Object.keys(body).length) throw new Error("Nothing to update");
        return humanize(await oai("POST", `${KINDS[a.kind as Kind]}/${a.id}`, { body }));
      }),
  );

  server.registerTool(
    "oai_ads_set_status",
    {
      title: "Activate / pause / archive",
      description: "Activate, pause or archive campaigns, ad groups or ads. Archive is permanent and needs confirm_archive. Delivery also needs the parent campaign and ad group active.",
      inputSchema: {
        kind: schema.kind,
        ids: z.array(z.string()).min(1),
        action: z.enum(["activate", "pause", "archive"]),
        confirm_archive: z.boolean().default(false),
      },
    },
    ({ kind, ids, action, confirm_archive }) =>
      run(async () => {
        if (action === "archive" && !confirm_archive) throw new Error("Archiving can't be undone; set confirm_archive: true");
        const results = [];
        for (const id of ids) {
          try {
            const r = (await oai("POST", `${KINDS[kind]}/${id}/${action}`)) as { status?: string };
            results.push({ id, status: r?.status ?? action });
          } catch (error) {
            results.push({ id, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return results;
      }),
  );

  server.registerTool(
    "oai_ads_preview_ad",
    {
      title: "Preview ad",
      description: "Temporary iframe preview URL of how an ad looks in ChatGPT. Appearance only — check oai_ads_get for review status and serving issues.",
      inputSchema: { ad_id: z.string() },
    },
    ({ ad_id }) => run(() => oai("POST", `ads/${ad_id}/preview`)),
  );

  server.registerTool(
    "oai_ads_upload",
    {
      title: "Upload image",
      description: "Upload an ad image (≥640×640) or account favicon (≥128×128) from a URL or local file; returns a reusable file_id.",
      inputSchema: {
        image_url: z.string().url().optional(),
        file_path: z.string().optional().describe("Absolute path to a local image"),
        purpose: z.enum(["ad_creative", "account_favicon"]).default("ad_creative"),
      },
    },
    ({ image_url, file_path, purpose }) =>
      run(async () => ({ file_id: await uploadImage(image_url, file_path, purpose === "account_favicon" ? purpose : undefined) })),
  );

  server.registerTool(
    "oai_ads_bulk",
    {
      title: "Bulk create / update",
      description:
        "Bulk API (limited preview): up to 1,000 campaign/ad_group/ad create or update operations in one async job, then poll results. Operation types: campaign.create|update, ad_group.create|update, ad.create|update. Creates need idempotency_key; children reference parents with campaign_idempotency_key / ad_group_idempotency_key; updates need target_resource_id. Pass job_id alone to check an existing job.",
      inputSchema: {
        operations: z.array(z.record(z.unknown())).max(1000).optional(),
        job_id: z.string().optional(),
        validate_only: z.boolean().default(false),
        partial_failure: z.boolean().default(true),
        wait_seconds: z.number().int().min(0).max(120).default(30).describe("Poll until done for up to this long"),
      },
    },
    (a) =>
      run(async () => {
        let jobId = a.job_id;
        if (!jobId) {
          if (!a.operations?.length) throw new Error("Provide operations or job_id");
          const job = (await oai("POST", "bulk_mutation_jobs", {
            body: { operations: a.operations, validate_only: a.validate_only, partial_failure: a.partial_failure },
            idempotencyKey: true,
          })) as { id: string };
          jobId = job.id;
        }
        const deadline = Date.now() + a.wait_seconds * 1000;
        let job = (await oai("GET", `bulk_mutation_jobs/${jobId}`)) as { status: string };
        while (["pending", "in_progress"].includes(job.status) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          job = (await oai("GET", `bulk_mutation_jobs/${jobId}`)) as { status: string };
        }
        const done = !["pending", "in_progress"].includes(job.status);
        const operations = done ? await listAll(`bulk_mutation_jobs/${jobId}/operations`, {}, 1000, "operation_id") : undefined;
        return { job, operations: operations?.data };
      }),
  );
}
