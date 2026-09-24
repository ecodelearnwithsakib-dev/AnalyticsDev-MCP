#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { requestJson } from "../shared/http.js";
import { run, startStdio } from "../shared/server.js";

const sgtmUrl = () => requireEnv("SGTM_URL").replace(/\/+$/, "");

const stapeApiBase = () =>
  optionalEnv("STAPE_REGION").toUpperCase() === "EU" ? "https://api.app.eu.stape.io" : "https://api.app.stape.io";

const server = new McpServer({ name: "stape-sgtm", version: "0.1.0" });

server.registerTool(
  "sgtm_healthcheck",
  {
    title: "sGTM health check",
    description: "Call the server-side GTM /healthy endpoint to confirm the tagging server is up.",
    inputSchema: {},
  },
  () =>
    run(async () => {
      const url = `${sgtmUrl()}/healthy`;
      const res = await fetch(url);
      return { url, status: res.status, ok: res.ok, body: (await res.text()).slice(0, 500) };
    }),
);

server.registerTool(
  "sgtm_send_ga4_event",
  {
    title: "Send GA4 event to sGTM",
    description:
      "Send a GA4 Measurement Protocol event to the sGTM container (claimed by the GA4 client), useful for testing server tags in Preview mode.",
    inputSchema: {
      client_id: z.string().describe("GA client_id, e.g. 123456.7890"),
      event_name: z.string(),
      params: z.record(z.unknown()).optional(),
      user_id: z.string().optional(),
      measurement_id: z.string().optional().describe("Defaults to GA4_MEASUREMENT_ID"),
      api_secret: z.string().optional().describe("Defaults to GA4_API_SECRET"),
      path: z.string().default("/mp/collect").describe("Endpoint path on the sGTM server"),
    },
  },
  (args) =>
    run(async () => {
      const query = new URLSearchParams({
        measurement_id: args.measurement_id ?? requireEnv("GA4_MEASUREMENT_ID"),
        api_secret: args.api_secret ?? requireEnv("GA4_API_SECRET"),
      });
      const body = {
        client_id: args.client_id,
        user_id: args.user_id,
        events: [{ name: args.event_name, params: args.params ?? {} }],
      };
      const res = await fetch(`${sgtmUrl()}${args.path}?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, ok: res.ok, body: (await res.text()).slice(0, 500) };
    }),
);

server.registerTool(
  "stape_api_request",
  {
    title: "Stape API request",
    description:
      "Call the Stape account API (containers, domains, power-ups, logs, statistics). See https://api.app.stape.io/api/doc for paths.",
    inputSchema: {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      path: z.string().describe("API path starting with /api/, taken from the Stape API docs"),
      body: z.record(z.unknown()).optional(),
    },
  },
  ({ method, path, body }) =>
    run(async () => {
      const headers: Record<string, string> = { Authorization: requireEnv("STAPE_API_KEY") };
      if (optionalEnv("STAPE_REGION").toUpperCase() === "EU") headers["X-Stape-Region"] = "EU";
      return requestJson(`${stapeApiBase()}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    }),
);

await startStdio(server, "stape-sgtm");
