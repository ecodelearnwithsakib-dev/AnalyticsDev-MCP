import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv, saveEnv } from "../../shared/env.js";
import { run } from "../../shared/server.js";
import { hashPii, oai, toMinor } from "../client.js";

/** Standard events and the data shape each one requires. */
const EVENT_DATA_TYPE = {
  order_created: "contents",
  checkout_started: "contents",
  items_added: "contents",
  contents_viewed: "contents",
  page_viewed: "contents",
  lead_created: "customer_action",
  appointment_scheduled: "customer_action",
  registration_completed: "customer_action",
  app_installed: "customer_action",
  app_opened: "customer_action",
  subscription_created: "plan_enrollment",
  trial_started: "plan_enrollment",
  custom: "custom",
} as const;
const eventType = z.enum(Object.keys(EVENT_DATA_TYPE) as [keyof typeof EVENT_DATA_TYPE, ...(keyof typeof EVENT_DATA_TYPE)[]]);

const content = z.object({
  id: z.string().optional(),
  group_id: z.string().optional(),
  name: z.string().optional(),
  content_type: z.string().optional(),
  quantity: z.number().int().optional(),
  price: z.number().optional().describe("Item price in currency units"),
  variant: z.record(z.string()).optional(),
});

const event = z.object({
  type: eventType,
  id: z.string().describe("Unique event ID (e.g. order ID); reuse it on retries and for Pixel deduplication"),
  time: z.string().optional().describe("ISO datetime or Unix ms; defaults to now (must be within the last 7 days)"),
  custom_event_name: z.string().optional(),
  action_source: z.enum(["web", "mobile_app", "offline", "physical_store", "phone_call", "email", "other"]).default("web"),
  source_url: z.string().url().optional().describe("Required for web events"),
  oppref: z.string().optional().describe("OpenAI click reference from the landing URL, passed unchanged"),
  obref: z.string().optional().describe("__obref cookie value from the Pixel, passed unchanged"),
  value: z.number().optional().describe("Order value in currency units, e.g. 1500.50"),
  currency: z.string().length(3).optional(),
  plan_id: z.string().optional(),
  contents: z.array(content).optional(),
  email: z.string().optional(),
  phone: z.string().optional().describe("With country code"),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  external_id: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  postal_code: z.string().optional(),
  ip_address: z.string().optional(),
  user_agent: z.string().optional(),
  gaid: z.string().optional(),
  custom_data: z.record(z.unknown()).optional().describe("Extra properties for custom events"),
});

function buildEvent(e: z.infer<typeof event>) {
  const timestamp = e.time === undefined ? Date.now() : /^\d+$/.test(e.time) ? Number(e.time) : Date.parse(e.time);
  if (Number.isNaN(timestamp)) throw new Error(`Invalid time for event ${e.id}: ${e.time}`);
  if (e.type === "custom" && !e.custom_event_name) throw new Error(`Event ${e.id}: custom events need custom_event_name`);
  if (e.action_source === "web" && !e.source_url) throw new Error(`Event ${e.id}: web events need source_url`);
  if (e.value !== undefined && !e.currency) throw new Error(`Event ${e.id}: value needs currency`);
  const list = (v?: string) => (v ? [v] : undefined);
  const user = {
    obref: e.obref,
    emails_sha256: e.email ? [hashPii.email(e.email)] : undefined,
    phone_numbers_sha256: e.phone ? [hashPii.phoneDigits(e.phone)] : undefined,
    first_names_sha256: e.first_name ? [hashPii.name(e.first_name)] : undefined,
    last_names_sha256: e.last_name ? [hashPii.name(e.last_name)] : undefined,
    external_ids_sha256: e.external_id ? [hashPii.externalId(e.external_id)] : undefined,
    countries: list(e.country?.toUpperCase()),
    regions: list(e.region),
    cities: list(e.city),
    postal_codes: list(e.postal_code),
    ip_address: e.ip_address,
    user_agent: e.user_agent,
    android_advertising_id: e.gaid,
  };
  const hasUser = Object.values(user).some((v) => v !== undefined);
  const dataType = EVENT_DATA_TYPE[e.type];
  const currency = e.currency?.toUpperCase();
  return {
    id: e.id,
    type: e.type,
    custom_event_name: e.custom_event_name,
    timestamp_ms: timestamp,
    action_source: e.action_source,
    source_url: e.source_url,
    oppref: e.oppref,
    ...(hasUser && { user }),
    data: {
      type: dataType,
      ...(e.value !== undefined && currency && { amount: toMinor(e.value, currency), currency }),
      ...(e.plan_id && { plan_id: e.plan_id }),
      ...(e.contents?.length &&
        dataType !== "customer_action" && {
          contents: e.contents.map((c) => ({
            id: c.id,
            group_id: c.group_id,
            name: c.name,
            content_type: c.content_type,
            quantity: c.quantity,
            ...(c.price !== undefined && currency && { amount: toMinor(c.price, currency), currency }),
            variant_dict: c.variant,
          })),
        }),
      ...(dataType === "custom" && e.custom_data),
    },
  };
}

const mask = (secret: string) => `${secret.slice(0, 6)}…${secret.slice(-4)}`;

export function registerConversionTools(server: McpServer): void {
  server.registerTool(
    "oai_ads_conversion_setup",
    {
      title: "Pixels & conversion events",
      description:
        "Conversion tracking setup: list pixels and event settings, create a web pixel, create an event setting (the goal a conversions campaign optimizes for), create a Conversions API key (saved straight into .env, never shown), or view Pixel events received in the last 15 minutes.",
      inputSchema: {
        action: z.enum(["list", "create_pixel", "create_event_setting", "create_capi_key", "recent_events"]).default("list"),
        name: z.string().min(3).optional(),
        event_type: eventType.optional(),
        custom_event_name: z.string().optional(),
        source_ids: z.array(z.string()).optional().describe("Pixel source IDs (clidsrc_…) for the event setting"),
        pixel_id: z.string().optional().describe("recent_events: defaults to OPENAI_ADS_PIXEL_ID"),
      },
    },
    (a) =>
      run(async () => {
        switch (a.action) {
          case "list": {
            const [pixels, settings] = await Promise.all([oai("GET", "conversions/pixels"), oai("GET", "conversions/event_settings")]);
            return { pixels, event_settings: settings };
          }
          case "create_pixel":
            return oai("POST", "conversions/pixels", { body: { name: a.name ?? "Website", client_type: "web" } });
          case "create_event_setting":
            if (!a.event_type || !a.source_ids?.length) throw new Error("event_type and source_ids are required");
            return oai("POST", "conversions/event_settings", {
              body: {
                name: a.name ?? a.custom_event_name ?? a.event_type,
                event_type: a.event_type,
                custom_event_name: a.custom_event_name,
                attribution_window_days: 30,
                source_ids: a.source_ids,
              },
            });
          case "create_capi_key": {
            const res = (await oai("POST", "conversions/api_keys", { body: { name: a.name ?? "Conversions API" } })) as { name?: string; api_key: string };
            saveEnv("OPENAI_ADS_CONVERSIONS_API_KEY", res.api_key);
            return { name: res.name, api_key: mask(res.api_key), saved_to: ".env as OPENAI_ADS_CONVERSIONS_API_KEY" };
          }
          case "recent_events":
            return oai("GET", "conversions/events", { query: { pid: a.pixel_id ?? requireEnv("OPENAI_ADS_PIXEL_ID"), limit: 50 } });
        }
      }),
  );

  server.registerTool(
    "oai_ads_send_conversions",
    {
      title: "Send conversions (CAPI)",
      description:
        "Send server-side conversion events to OpenAI's Conversions API (up to 1,000 per call). Email, phone, names and external IDs are normalized and SHA-256 hashed locally; value is in currency units. Use validate_only to test without recording.",
      inputSchema: {
        events: z.array(event).min(1).max(1000),
        pixel_id: z.string().optional().describe("Defaults to OPENAI_ADS_PIXEL_ID"),
        validate_only: z.boolean().default(false),
        integration_source: z.string().optional().describe("Stable ID of the sending integration, e.g. analyticsdev_mcp"),
      },
    },
    (a) =>
      run(async () => {
        const pid = a.pixel_id ?? requireEnv("OPENAI_ADS_PIXEL_ID");
        const endpoint = optionalEnv("OPENAI_ADS_CAPI_URL", "https://bzr.openai.com/v1/events");
        const events = a.events.map(buildEvent);
        const res = await oai("POST", "", {
          url: `${endpoint}?pid=${encodeURIComponent(pid)}`,
          apiKey: requireEnv("OPENAI_ADS_CONVERSIONS_API_KEY"),
          body: { validate_only: a.validate_only, integration_source: a.integration_source, events },
        });
        return { sent: events.length, validate_only: a.validate_only, response: res };
      }),
  );
}
