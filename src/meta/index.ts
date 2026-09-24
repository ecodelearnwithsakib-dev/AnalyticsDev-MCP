#!/usr/bin/env node
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { requestJson } from "../shared/http.js";
import { run, startStdio } from "../shared/server.js";

const apiVersion = () => optionalEnv("META_API_VERSION", "v23.0");
const graphUrl = (path: string) => `https://graph.facebook.com/${apiVersion()}/${path}`;

/** Meta requires PII to be normalized (trimmed, lowercased) and SHA-256 hashed. */
function hash(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

const server = new McpServer({ name: "meta-capi", version: "0.1.0" });

server.registerTool(
  "meta_send_event",
  {
    title: "Send Meta CAPI event",
    description:
      "Send one server event to the Meta Conversions API. Email, phone and external_id are SHA-256 hashed before sending. Use test_event_code to see it under Events Manager → Test events.",
    inputSchema: {
      event_name: z.string().describe("Standard or custom event, e.g. Purchase, Lead, PageView"),
      event_id: z.string().optional().describe("Deduplication ID; must match the browser pixel eventID"),
      event_source_url: z.string().url().optional(),
      action_source: z
        .enum(["website", "app", "email", "phone_call", "chat", "physical_store", "system_generated", "other"])
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
    run(async () => {
      const pixelId = args.pixel_id ?? requireEnv("META_PIXEL_ID");

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

      const body = {
        data: [
          {
            event_name: args.event_name,
            event_time: Math.floor(Date.now() / 1000),
            event_id: args.event_id,
            event_source_url: args.event_source_url,
            action_source: args.action_source,
            user_data: userData,
            custom_data: customData,
          },
        ],
        test_event_code: args.test_event_code,
        access_token: requireEnv("META_ACCESS_TOKEN"),
      };

      return requestJson(graphUrl(`${pixelId}/events`), { method: "POST", body: JSON.stringify(body) });
    }),
);

server.registerTool(
  "meta_get_pixel",
  {
    title: "Get Meta pixel info",
    description: "Read a pixel's name, creation time and when it last fired.",
    inputSchema: {
      pixel_id: z.string().optional().describe("Defaults to META_PIXEL_ID"),
    },
  },
  ({ pixel_id }) =>
    run(async () => {
      const pixelId = pixel_id ?? requireEnv("META_PIXEL_ID");
      const params = new URLSearchParams({
        fields: "id,name,creation_time,last_fired_time,is_unavailable",
        access_token: requireEnv("META_ACCESS_TOKEN"),
      });
      return requestJson(`${graphUrl(pixelId)}?${params}`);
    }),
);

await startStdio(server, "meta-capi");
