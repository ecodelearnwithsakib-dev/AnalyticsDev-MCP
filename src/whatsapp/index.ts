#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { PRESETS, window } from "../shared/hub.js";
import { restClient } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/** WhatsApp Business Platform (Cloud API) via the Graph API with a system-user access token. */
const version = () => optionalEnv("WHATSAPP_GRAPH_VERSION", "v24.0");
const api = restClient({ name: "WhatsApp", base: () => `https://graph.facebook.com/${version()}`, headers: () => ({ Authorization: `Bearer ${requireEnv("WHATSAPP_ACCESS_TOKEN")}` }), hints: { 190: "", 401: "check WHATSAPP_ACCESS_TOKEN (system user token with whatsapp_business_messaging / whatsapp_business_management)" } });
const phoneId = (id?: string) => id ?? requireEnv("WHATSAPP_PHONE_NUMBER_ID");
const waba = (id?: string) => id ?? requireEnv("WHATSAPP_BUSINESS_ACCOUNT_ID");
const digits = (p: string) => p.replace(/[^\d]/g, "");

type Rec = Record<string, unknown>;

const server = new McpServer(
  { name: "whatsapp", version: "0.1.0" },
  { instructions: "WhatsApp Business Cloud API: phone numbers and quality rating, message templates (list/create), sending template or free-form messages (free-form only within 24h of the customer's last message; every send needs confirm — always show the user the message first), conversation/pricing analytics and raw Graph calls. Only message people who opted in." },
);

server.registerTool(
  "wa_numbers",
  { title: "Phone numbers", description: "Business phone numbers on the WhatsApp Business Account with display name, verification, quality rating, messaging limit tier and status.", inputSchema: { waba_id: z.string().optional() } },
  (a) => run(async () => ((await api(`${waba(a.waba_id)}/phone_numbers`, { query: { fields: "id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,name_status,code_verification_status,throughput" } })) as { data: Rec[] }).data),
);

server.registerTool(
  "wa_templates",
  {
    title: "Message templates",
    description: "List message templates (name, language, category, status, components), or create a new template for review (MARKETING / UTILITY / AUTHENTICATION) — creation needs confirm.",
    inputSchema: { action: z.enum(["list", "create"]).default("list"), status: z.enum(["APPROVED", "PENDING", "REJECTED", "PAUSED"]).optional(), name: z.string().optional(), language: z.string().default("en_US"), category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]).optional(), components: z.array(z.record(z.unknown())).optional(), waba_id: z.string().optional(), confirm: z.boolean().default(false) },
  },
  (a) =>
    run(async () => {
      if (a.action === "list") return ((await api(`${waba(a.waba_id)}/message_templates`, { query: { fields: "id,name,language,category,status,quality_score,components,rejected_reason", limit: 250, status: a.status } })) as { data: Rec[] }).data;
      if (!a.name || !a.category || !a.components) throw new Error("name, category and components are required");
      if (!a.confirm) throw new Error("Submits a template to Meta for review; set confirm: true");
      return api(`${waba(a.waba_id)}/message_templates`, { body: { name: a.name, language: a.language, category: a.category, components: a.components } });
    }),
);

server.registerTool(
  "wa_send",
  {
    title: "Send message",
    description: "Send a WhatsApp message: an approved template (with body/header variables — works any time for opted-in users) or free-form text/image/document (only within 24h of the customer's last message). Needs confirm; always show the user the message first.",
    inputSchema: {
      to: z.array(z.string()).min(1).max(50).describe("Phone numbers with country code"),
      type: z.enum(["template", "text", "image", "document"]).default("template"),
      template: z.string().optional(),
      language: z.string().default("en_US"),
      variables: z.array(z.string()).optional().describe("Body {{1}}, {{2}}… values"),
      header_image: z.string().optional(),
      text: z.string().optional(),
      media_url: z.string().optional(),
      caption: z.string().optional(),
      filename: z.string().optional(),
      phone_number_id: z.string().optional(),
      confirm: z.boolean().default(false),
    },
  },
  (a) =>
    run(async () => {
      let payload: Rec;
      if (a.type === "template") {
        if (!a.template) throw new Error("template is required");
        const components: Rec[] = [];
        if (a.header_image) components.push({ type: "header", parameters: [{ type: "image", image: { link: a.header_image } }] });
        if (a.variables?.length) components.push({ type: "body", parameters: a.variables.map((v) => ({ type: "text", text: v })) });
        payload = { type: "template", template: { name: a.template, language: { code: a.language }, components } };
      } else if (a.type === "text") {
        if (!a.text) throw new Error("text is required");
        payload = { type: "text", text: { body: a.text, preview_url: /https?:\/\//.test(a.text) } };
      } else {
        if (!a.media_url) throw new Error("media_url is required");
        payload = { type: a.type, [a.type]: { link: a.media_url, caption: a.caption, filename: a.type === "document" ? a.filename : undefined } };
      }
      if (!a.confirm) return { preview: true, to: a.to, message: payload, note: "Messages go to real people — show this to the user, then pass confirm: true" };
      const out = [];
      for (const to of a.to) {
        try {
          const r = (await api(`${phoneId(a.phone_number_id)}/messages`, { body: { messaging_product: "whatsapp", recipient_type: "individual", to: digits(to), ...payload } })) as { messages?: { id: string; message_status?: string }[] };
          out.push({ to, id: r.messages?.[0]?.id, status: r.messages?.[0]?.message_status ?? "accepted" });
        } catch (e) {
          out.push({ to, error: (e as Error).message });
        }
      }
      return out;
    }),
);

server.registerTool(
  "wa_analytics",
  { title: "Analytics", description: "Messages sent/delivered, or conversations/pricing by category (marketing, utility, service, authentication) and country over a period.", inputSchema: { metric: z.enum(["messages", "pricing"]).default("pricing"), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), granularity: z.enum(["DAY", "MONTH"]).default("DAY"), waba_id: z.string().optional() } },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const start = Math.floor(Date.parse(`${w.from}T00:00:00Z`) / 1000);
      const end = Math.floor(Date.parse(`${w.to}T23:59:59Z`) / 1000);
      const field = a.metric === "messages" ? `analytics.start(${start}).end(${end}).granularity(${a.granularity})` : `pricing_analytics.start(${start}).end(${end}).granularity(${a.granularity}).dimensions(["PRICING_CATEGORY","COUNTRY"])`;
      const r = (await api(waba(a.waba_id), { query: { fields: field } })) as Rec;
      return { window: w, data: r.analytics ?? r.pricing_analytics };
    }),
);

server.registerTool(
  "wa_api",
  { title: "WhatsApp Graph API call", description: "Call any WhatsApp Business Graph endpoint (business profile, flows, media, QR codes, block users…). Writes need confirm.", inputSchema: { method: z.enum(["GET", "POST", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method !== "GET" && !a.confirm) throw new Error("Write calls change your WhatsApp account or message people; set confirm: true");
      return api(a.path.replace(/^\/?(v\d+\.\d+\/)?/, ""), { method: a.method, query: a.query, body: a.body });
    }),
);

await startStdio(server, "whatsapp");
