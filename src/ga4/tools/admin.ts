import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { account, admin, adminList, adminUpdate, property, schema } from "../client.js";

export function registerAdminTools(server: McpServer): void {
  // ---------- Generic ----------
  server.registerTool(
    "ga4_admin_get",
    {
      title: "Get any GA4 Admin resource",
      description:
        "Read any Admin API resource by name, e.g. properties/123, properties/123/dataRetentionSettings, properties/123/dataStreams/456/enhancedMeasurementSettings (v1alpha), properties/123/googleSignalsSettings (v1alpha), properties/123/attributionSettings (v1alpha).",
      inputSchema: { name: z.string(), version: schema.version },
    },
    ({ name, version }) => run(() => admin("GET", name, undefined, undefined, version)),
  );

  server.registerTool(
    "ga4_admin_update",
    {
      title: "Update any GA4 Admin resource",
      description:
        "PATCH any Admin API resource; updateMask is built from the keys in fields. Examples: rename a property ({\"displayName\":\"...\"}), change timezone/currency, update a custom dimension, toggle enhanced measurement (v1alpha), attribution settings (v1alpha).",
      inputSchema: { name: z.string(), fields: z.record(z.unknown()), version: schema.version },
    },
    ({ name, fields, version }) => run(() => adminUpdate(name, fields, version)),
  );

  server.registerTool(
    "ga4_admin_delete",
    {
      title: "Delete any GA4 Admin resource",
      description: "Delete an Admin API resource (key event, data stream, link, access binding, MP secret, ...). Deleting a property moves it to trash for 35 days.",
      inputSchema: {
        name: z.string(),
        version: schema.version,
        confirm: z.literal(true).describe("Must be true"),
      },
    },
    ({ name, version }) => run(() => admin("DELETE", name, undefined, undefined, version)),
  );

  // ---------- Accounts & properties ----------
  server.registerTool(
    "ga4_list_account_summaries",
    {
      title: "List GA4 accounts & properties",
      description: "List every GA4 account and property the credentials can access.",
      inputSchema: { limit: schema.limit },
    },
    ({ limit }) => run(() => adminList("accountSummaries", "accountSummaries", limit)),
  );

  server.registerTool(
    "ga4_list_properties",
    {
      title: "List GA4 properties",
      description: "List properties in an account (including trashed ones when show_deleted).",
      inputSchema: { account: schema.account, show_deleted: z.boolean().default(false), limit: schema.limit },
    },
    ({ account: id, show_deleted, limit }) =>
      run(() => adminList("properties", "properties", limit, "v1beta", { filter: `parent:${account(id)}`, showDeleted: show_deleted })),
  );

  server.registerTool(
    "ga4_get_property",
    {
      title: "Get GA4 property",
      description: "Property settings: name, timezone, currency, industry, service level, create time.",
      inputSchema: { property: schema.property },
    },
    ({ property: id }) => run(() => admin("GET", property(id))),
  );

  server.registerTool(
    "ga4_create_property",
    {
      title: "Create GA4 property",
      description: "Create a new GA4 property in an account.",
      inputSchema: {
        account: schema.account,
        display_name: z.string(),
        time_zone: z.string().default("Asia/Dhaka"),
        currency_code: z.string().default("BDT"),
        industry_category: z.string().optional().describe("e.g. SHOPPING, TECHNOLOGY, BUSINESS_AND_INDUSTRIAL_MARKETS"),
      },
    },
    ({ account: id, display_name, time_zone, currency_code, industry_category }) =>
      run(() =>
        admin("POST", "properties", {
          parent: account(id),
          displayName: display_name,
          timeZone: time_zone,
          currencyCode: currency_code,
          industryCategory: industry_category,
        }),
      ),
  );

  // ---------- Data streams ----------
  server.registerTool(
    "ga4_list_data_streams",
    {
      title: "List data streams",
      description: "List web/app data streams with their measurement IDs.",
      inputSchema: { property: schema.property },
    },
    ({ property: id }) => run(() => adminList(`${property(id)}/dataStreams`, "dataStreams")),
  );

  server.registerTool(
    "ga4_create_web_stream",
    {
      title: "Create web data stream",
      description: "Create a web data stream; returns its measurement ID (G-XXXX).",
      inputSchema: { property: schema.property, display_name: z.string(), default_uri: z.string().url() },
    },
    ({ property: id, display_name, default_uri }) =>
      run(() =>
        admin("POST", `${property(id)}/dataStreams`, {
          type: "WEB_DATA_STREAM",
          displayName: display_name,
          webStreamData: { defaultUri: default_uri },
        }),
      ),
  );

  server.registerTool(
    "ga4_list_mp_secrets",
    {
      title: "List Measurement Protocol secrets",
      description: "List Measurement Protocol API secrets of a data stream.",
      inputSchema: { property: schema.property, stream_id: z.string() },
    },
    ({ property: id, stream_id }) =>
      run(() => adminList(`${property(id)}/dataStreams/${stream_id}/measurementProtocolSecrets`, "measurementProtocolSecrets")),
  );

  server.registerTool(
    "ga4_create_mp_secret",
    {
      title: "Create Measurement Protocol secret",
      description: "Create a Measurement Protocol API secret for a data stream (for server-side / sGTM hits).",
      inputSchema: { property: schema.property, stream_id: z.string(), display_name: z.string() },
    },
    ({ property: id, stream_id, display_name }) =>
      run(() =>
        admin("POST", `${property(id)}/dataStreams/${stream_id}/measurementProtocolSecrets`, { displayName: display_name }),
      ),
  );

  // ---------- Key events ----------
  server.registerTool(
    "ga4_list_key_events",
    {
      title: "List key events",
      description: "List key events (formerly conversions).",
      inputSchema: { property: schema.property },
    },
    ({ property: id }) => run(() => adminList(`${property(id)}/keyEvents`, "keyEvents")),
  );

  server.registerTool(
    "ga4_create_key_event",
    {
      title: "Mark event as key event",
      description: "Mark an event name as a key event (conversion).",
      inputSchema: {
        property: schema.property,
        event_name: z.string(),
        counting_method: z.enum(["ONCE_PER_EVENT", "ONCE_PER_SESSION"]).default("ONCE_PER_EVENT"),
        default_value: z.number().optional(),
        currency_code: z.string().optional(),
      },
    },
    ({ property: id, event_name, counting_method, default_value, currency_code }) =>
      run(() =>
        admin("POST", `${property(id)}/keyEvents`, {
          eventName: event_name,
          countingMethod: counting_method,
          defaultValue: default_value !== undefined ? { numericValue: default_value, currencyCode: currency_code ?? "USD" } : undefined,
        }),
      ),
  );

  // ---------- Custom definitions ----------
  server.registerTool(
    "ga4_list_custom_definitions",
    {
      title: "List custom dimensions & metrics",
      description: "List custom dimensions and custom metrics of a property.",
      inputSchema: { property: schema.property },
    },
    ({ property: id }) =>
      run(async () => ({
        customDimensions: (await adminList(`${property(id)}/customDimensions`, "customDimensions")).customDimensions,
        customMetrics: (await adminList(`${property(id)}/customMetrics`, "customMetrics")).customMetrics,
      })),
  );

  server.registerTool(
    "ga4_create_custom_dimension",
    {
      title: "Create custom dimension",
      description: "Register an event, user or item parameter as a custom dimension.",
      inputSchema: {
        property: schema.property,
        parameter_name: z.string().describe("Event/user/item parameter, e.g. payment_type"),
        display_name: z.string(),
        scope: z.enum(["EVENT", "USER", "ITEM"]).default("EVENT"),
        description: z.string().optional(),
      },
    },
    ({ property: id, parameter_name, display_name, scope, description }) =>
      run(() =>
        admin("POST", `${property(id)}/customDimensions`, {
          parameterName: parameter_name,
          displayName: display_name,
          scope,
          description,
        }),
      ),
  );

  server.registerTool(
    "ga4_create_custom_metric",
    {
      title: "Create custom metric",
      description: "Register a numeric event parameter as a custom metric.",
      inputSchema: {
        property: schema.property,
        parameter_name: z.string(),
        display_name: z.string(),
        measurement_unit: z
          .enum(["STANDARD", "CURRENCY", "FEET", "METERS", "KILOMETERS", "MILES", "MILLISECONDS", "SECONDS", "MINUTES", "HOURS"])
          .default("STANDARD"),
        description: z.string().optional(),
        restricted_metric_type: z.array(z.enum(["COST_DATA", "REVENUE_DATA"])).optional().describe("Required for CURRENCY metrics"),
      },
    },
    ({ property: id, parameter_name, display_name, measurement_unit, description, restricted_metric_type }) =>
      run(() =>
        admin("POST", `${property(id)}/customMetrics`, {
          parameterName: parameter_name,
          displayName: display_name,
          measurementUnit: measurement_unit,
          scope: "EVENT",
          description,
          restrictedMetricType: restricted_metric_type,
        }),
      ),
  );

  server.registerTool(
    "ga4_archive_custom_definition",
    {
      title: "Archive custom dimension/metric",
      description: "Archive a custom dimension or metric by resource name (properties/123/customDimensions/456 or .../customMetrics/789).",
      inputSchema: { name: z.string() },
    },
    ({ name }) => run(() => admin("POST", `${name}:archive`, {})),
  );

  // ---------- Settings ----------
  server.registerTool(
    "ga4_set_data_retention",
    {
      title: "Set data retention",
      description: "Set event/user data retention (standard properties allow up to FOURTEEN_MONTHS).",
      inputSchema: {
        property: schema.property,
        event_data_retention: z.enum(["TWO_MONTHS", "FOURTEEN_MONTHS", "TWENTY_SIX_MONTHS", "THIRTY_EIGHT_MONTHS", "FIFTY_MONTHS"]),
        user_data_retention: z
          .enum(["TWO_MONTHS", "FOURTEEN_MONTHS", "TWENTY_SIX_MONTHS", "THIRTY_EIGHT_MONTHS", "FIFTY_MONTHS"])
          .optional(),
        reset_user_data_on_new_activity: z.boolean().default(true),
      },
    },
    ({ property: id, event_data_retention, user_data_retention, reset_user_data_on_new_activity }) =>
      run(() =>
        adminUpdate(`${property(id)}/dataRetentionSettings`, {
          eventDataRetention: event_data_retention,
          ...(user_data_retention && { userDataRetention: user_data_retention }),
          resetUserDataOnNewActivity: reset_user_data_on_new_activity,
        }),
      ),
  );

  // ---------- Links ----------
  server.registerTool(
    "ga4_list_links",
    {
      title: "List product links",
      description: "List links to Google Ads, Firebase, BigQuery, Search Ads 360 or DV360.",
      inputSchema: {
        property: schema.property,
        type: z.enum(["googleAdsLinks", "firebaseLinks", "bigQueryLinks", "searchAds360Links", "displayVideo360AdvertiserLinks"]),
      },
    },
    ({ property: id, type }) =>
      run(() => adminList(`${property(id)}/${type}`, type, 200, ["googleAdsLinks", "firebaseLinks"].includes(type) ? "v1beta" : "v1alpha")),
  );

  server.registerTool(
    "ga4_create_google_ads_link",
    {
      title: "Link Google Ads",
      description: "Link a Google Ads customer account to the property.",
      inputSchema: {
        property: schema.property,
        customer_id: z.string().describe("Google Ads customer ID without dashes"),
        ads_personalization_enabled: z.boolean().default(true),
      },
    },
    ({ property: id, customer_id, ads_personalization_enabled }) =>
      run(() =>
        admin("POST", `${property(id)}/googleAdsLinks`, {
          customerId: customer_id.replace(/-/g, ""),
          adsPersonalizationEnabled: ads_personalization_enabled,
        }),
      ),
  );

  // ---------- Audiences (v1alpha) ----------
  server.registerTool(
    "ga4_list_audiences",
    {
      title: "List audiences",
      description: "List GA4 audiences.",
      inputSchema: { property: schema.property },
    },
    ({ property: id }) => run(() => adminList(`${property(id)}/audiences`, "audiences", 200, "v1alpha")),
  );

  server.registerTool(
    "ga4_create_audience",
    {
      title: "Create audience",
      description:
        "Create an audience (Admin API v1alpha). audience example: {\"displayName\":\"Purchasers\",\"description\":\"Users who purchased\",\"membershipDurationDays\":30,\"filterClauses\":[{\"clauseType\":\"INCLUDE\",\"simpleFilter\":{\"scope\":\"AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS\",\"filterExpression\":{\"andGroup\":{\"filterExpressions\":[{\"orGroup\":{\"filterExpressions\":[{\"eventFilter\":{\"eventName\":\"purchase\"}}]}}]}}}}]}",
      inputSchema: { property: schema.property, audience: z.record(z.unknown()) },
    },
    ({ property: id, audience }) => run(() => admin("POST", `${property(id)}/audiences`, audience, undefined, "v1alpha")),
  );

  // ---------- User access (v1alpha) ----------
  server.registerTool(
    "ga4_list_users",
    {
      title: "List user access",
      description: "List users and their roles on a property or account.",
      inputSchema: { property: schema.property, account: z.string().optional().describe("Pass to list account-level access instead") },
    },
    ({ property: pid, account: aid }) =>
      run(() => adminList(`${aid ? account(aid) : property(pid)}/accessBindings`, "accessBindings", 500, "v1alpha")),
  );

  server.registerTool(
    "ga4_add_user",
    {
      title: "Grant user access",
      description: "Give an email access to a property or account. Remove access with ga4_admin_delete on the accessBinding name (v1alpha).",
      inputSchema: {
        property: schema.property,
        account: z.string().optional().describe("Grant at account level instead"),
        email: z.string().email(),
        roles: z
          .array(z.enum(["predefinedRoles/viewer", "predefinedRoles/analyst", "predefinedRoles/editor", "predefinedRoles/admin", "predefinedRoles/no-cost-data", "predefinedRoles/no-revenue-data"]))
          .default(["predefinedRoles/viewer"]),
      },
    },
    ({ property: pid, account: aid, email, roles }) =>
      run(() =>
        admin("POST", `${aid ? account(aid) : property(pid)}/accessBindings`, { user: email, roles }, undefined, "v1alpha"),
      ),
  );

  // ---------- Audit ----------
  server.registerTool(
    "ga4_change_history",
    {
      title: "Search change history",
      description: "Who changed what in a GA4 account/property (up to 2 years back).",
      inputSchema: {
        account: schema.account,
        property: z.string().optional(),
        earliest_change_time: z.string().optional().describe("RFC 3339, e.g. 2026-09-01T00:00:00Z"),
        latest_change_time: z.string().optional(),
        resource_type: z.array(z.string()).optional().describe("e.g. PROPERTY, KEY_EVENT, CUSTOM_DIMENSION, DATA_STREAM, AUDIENCE"),
        action: z.array(z.enum(["CREATED", "UPDATED", "DELETED"])).optional(),
        actor_email: z.array(z.string()).optional(),
        page_size: z.number().int().min(1).max(200).default(50),
      },
    },
    (args) =>
      run(() =>
        admin("POST", `${account(args.account)}:searchChangeHistoryEvents`, {
          property: args.property ? property(args.property) : undefined,
          earliestChangeTime: args.earliest_change_time,
          latestChangeTime: args.latest_change_time,
          resourceType: args.resource_type,
          action: args.action,
          actorEmail: args.actor_email,
          pageSize: args.page_size,
        }),
      ),
  );

  server.registerTool(
    "ga4_run_access_report",
    {
      title: "Data access report",
      description:
        "Who viewed GA4 data and when. body example: {\"dateRanges\":[{\"startDate\":\"30daysAgo\",\"endDate\":\"today\"}],\"dimensions\":[{\"dimensionName\":\"userEmail\"}],\"metrics\":[{\"metricName\":\"accessCount\"}]}",
      inputSchema: { property: schema.property, body: z.record(z.unknown()) },
    },
    ({ property: id, body }) => run(() => admin("POST", `${property(id)}:runAccessReport`, body)),
  );
}
