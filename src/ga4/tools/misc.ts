import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireEnv } from "../../shared/env.js";
import { run } from "../../shared/server.js";
import { API, google } from "../client.js";

export function registerMiscTools(server: McpServer): void {
  server.registerTool(
    "ga4_api_request",
    {
      title: "GA4 API request",
      description:
        "Call ANY Google Analytics Data or Admin API endpoint directly when no dedicated tool fits. path is relative to the version, e.g. 'properties/123/channelGroups' or 'properties/123:runReport'.",
      inputSchema: {
        api: z.enum(Object.keys(API) as [keyof typeof API, ...(keyof typeof API)[]]),
        version: z.enum(["v1beta", "v1alpha"]).default("v1beta"),
        method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"),
        path: z.string(),
        body: z.record(z.unknown()).optional(),
        query: z.record(z.unknown()).optional().describe("Query params, e.g. {\"updateMask\":\"displayName\"}"),
      },
    },
    ({ api, version, method, path, body, query }) => run(() => google(api, version, method, path, body, query)),
  );

  server.registerTool(
    "ga4_mp_send_event",
    {
      title: "Send Measurement Protocol event",
      description:
        "Send events straight to GA4 via the Measurement Protocol. Set validate_only to hit the debug endpoint and get validation messages without recording data.",
      inputSchema: {
        client_id: z.string().describe("GA client_id, e.g. 123456.7890 (from the _ga cookie)"),
        events: z
          .array(z.object({ name: z.string(), params: z.record(z.unknown()).optional() }))
          .min(1)
          .max(25)
          .describe("e.g. [{\"name\":\"purchase\",\"params\":{\"transaction_id\":\"T1\",\"value\":1500,\"currency\":\"BDT\"}}]"),
        user_id: z.string().optional(),
        user_properties: z.record(z.object({ value: z.unknown() })).optional(),
        timestamp_micros: z.number().int().optional(),
        measurement_id: z.string().optional().describe("Defaults to GA4_MEASUREMENT_ID"),
        api_secret: z.string().optional().describe("Defaults to GA4_API_SECRET"),
        validate_only: z.boolean().default(false),
        region: z.enum(["global", "eu"]).default("global"),
      },
    },
    (args) =>
      run(async () => {
        const host = args.region === "eu" ? "region1.google-analytics.com" : "www.google-analytics.com";
        const path = args.validate_only ? "debug/mp/collect" : "mp/collect";
        const query = new URLSearchParams({
          measurement_id: args.measurement_id ?? requireEnv("GA4_MEASUREMENT_ID"),
          api_secret: args.api_secret ?? requireEnv("GA4_API_SECRET"),
        });
        const res = await fetch(`https://${host}/${path}?${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: args.client_id,
            user_id: args.user_id,
            user_properties: args.user_properties,
            timestamp_micros: args.timestamp_micros,
            events: args.events.map((e) => ({ name: e.name, params: e.params ?? {} })),
          }),
        });
        const text = await res.text();
        // The live endpoint always returns 2xx with an empty body, even for bad payloads.
        return {
          status: res.status,
          validated: args.validate_only,
          response: text ? JSON.parse(text) : "accepted (use validate_only=true to check the payload)",
        };
      }),
  );
}
