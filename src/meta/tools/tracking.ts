import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireEnv } from "../../shared/env.js";
import { run } from "../../shared/server.js";
import { adAccount, graph, graphList, hash, schema } from "../client.js";

const pixelId = (id?: string) => id ?? requireEnv("META_PIXEL_ID");

export function registerTrackingTools(server: McpServer): void {
  server.registerTool(
    "meta_send_event",
    {
      title: "Send Conversions API event",
      description:
        "Send one server event to the Meta Conversions API. Email, phone and external_id are SHA-256 hashed before sending. Use test_event_code to see it under Events Manager → Test events.",
      inputSchema: {
        event_name: z.string().describe("Standard or custom event, e.g. Purchase, Lead, PageView"),
        event_id: z.string().optional().describe("Deduplication ID; must match the browser pixel eventID"),
        event_time: z.string().optional().describe("When it happened: ISO datetime or Unix seconds (default now; Meta accepts up to 7 days back, 62 for offline/system events)"),
        event_source_url: z.string().url().optional(),
        action_source: z
          .enum(["website", "app", "email", "phone_call", "chat", "physical_store", "system_generated", "business_messaging", "other"])
          .default("website"),
        email: z.string().optional(),
        phone: z.string().optional().describe("Include country code, e.g. 8801XXXXXXXXX"),
        external_id: z.string().optional(),
        client_ip_address: z.string().optional(),
        client_user_agent: z.string().optional(),
        fbc: z.string().optional().describe("_fbc cookie value"),
        fbp: z.string().optional().describe("_fbp cookie value"),
        value: z.number().optional(),
        currency: z.string().length(3).optional().describe("ISO 4217, e.g. BDT, USD"),
        custom_data: z.record(z.unknown()).optional().describe("Extra custom_data fields (content_ids, contents, ...)"),
        test_event_code: z.string().optional(),
        pixel_id: z.string().optional().describe("Defaults to META_PIXEL_ID"),
      },
    },
    (args) =>
      run(() => {
        const userData: Record<string, unknown> = {};
        if (args.email) userData.em = [hash(args.email)];
        if (args.phone) userData.ph = [hash(args.phone.replace(/\D/g, ""))];
        if (args.external_id) userData.external_id = [hash(args.external_id)];
        if (args.client_ip_address) userData.client_ip_address = args.client_ip_address;
        if (args.client_user_agent) userData.client_user_agent = args.client_user_agent;
        if (args.fbc) userData.fbc = args.fbc;
        if (args.fbp) userData.fbp = args.fbp;

        const customData: Record<string, unknown> = { ...args.custom_data };
        if (args.value !== undefined) customData.value = args.value;
        if (args.currency) customData.currency = args.currency.toUpperCase();

        const event = {
          event_name: args.event_name,
          event_time: args.event_time ? (/^\d+$/.test(args.event_time) ? Number(args.event_time) : Math.floor(Date.parse(args.event_time) / 1000)) : Math.floor(Date.now() / 1000),
          event_id: args.event_id,
          event_source_url: args.event_source_url,
          action_source: args.action_source,
          user_data: userData,
          custom_data: customData,
        };
        return graph("POST", `${pixelId(args.pixel_id)}/events`, { data: [event], test_event_code: args.test_event_code });
      }),
  );

  server.registerTool(
    "meta_list_pixels",
    {
      title: "List pixels / datasets",
      description: "List Meta pixels (datasets) attached to an ad account.",
      inputSchema: {
        ad_account_id: schema.adAccountId,
        fields: schema.fields("id,name,creation_time,last_fired_time,is_unavailable"),
        limit: schema.limit,
      },
    },
    ({ ad_account_id, fields, limit }) => run(() => graphList(`${adAccount(ad_account_id)}/adspixels`, { fields }, limit)),
  );

  server.registerTool(
    "meta_get_pixel",
    {
      title: "Get pixel info",
      description: "Read a pixel's name, creation time and when it last fired.",
      inputSchema: {
        pixel_id: z.string().optional().describe("Defaults to META_PIXEL_ID"),
        fields: schema.fields("id,name,creation_time,last_fired_time,is_unavailable,data_use_setting,owner_business"),
      },
    },
    ({ pixel_id, fields }) => run(() => graph("GET", pixelId(pixel_id), { fields })),
  );

  server.registerTool(
    "meta_pixel_stats",
    {
      title: "Pixel event stats",
      description: "Event counts received by a pixel, grouped by event, device, URL, browser, etc. Useful for tracking QA.",
      inputSchema: {
        pixel_id: z.string().optional(),
        aggregation: z
          .enum(["event", "host", "url", "device_type", "device_os", "browser_type", "pixel_fire", "custom_data_field", "event_source", "match_keys", "event_value_count"])
          .default("event"),
        start_time: z.string().optional().describe("Unix timestamp or ISO date"),
        end_time: z.string().optional(),
      },
    },
    ({ pixel_id, ...params }) => run(() => graph("GET", `${pixelId(pixel_id)}/stats`, params)),
  );

  server.registerTool(
    "meta_list_custom_conversions",
    {
      title: "List custom conversions",
      description: "List custom conversions in an ad account.",
      inputSchema: {
        ad_account_id: schema.adAccountId,
        fields: schema.fields("id,name,custom_event_type,rule,pixel,is_archived,last_fired_time"),
        limit: schema.limit,
      },
    },
    ({ ad_account_id, fields, limit }) => run(() => graphList(`${adAccount(ad_account_id)}/customconversions`, { fields }, limit)),
  );

  server.registerTool(
    "meta_create_custom_conversion",
    {
      title: "Create custom conversion",
      description:
        "Create a custom conversion from pixel events. rule example: {\"and\":[{\"event\":{\"eq\":\"Purchase\"}},{\"URL\":{\"i_contains\":\"/thank-you\"}}]}",
      inputSchema: {
        ad_account_id: schema.adAccountId,
        name: z.string(),
        pixel_id: z.string().optional(),
        custom_event_type: z.string().describe("e.g. PURCHASE, LEAD, COMPLETE_REGISTRATION, ADD_TO_CART, OTHER"),
        rule: z.record(z.unknown()),
        default_conversion_value: z.number().optional(),
        extra: schema.extra,
      },
    },
    ({ ad_account_id, pixel_id, extra, ...fields }) =>
      run(() =>
        graph("POST", `${adAccount(ad_account_id)}/customconversions`, { ...fields, event_source_id: pixelId(pixel_id), ...extra }),
      ),
  );
}
