#!/usr/bin/env node
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { PRESETS, round, window } from "../shared/hub.js";
import { restClient } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/** Mailchimp Marketing API 3.0 with an API key (the data center is the part after the dash, e.g. us21). */
const dc = () => optionalEnv("MAILCHIMP_SERVER_PREFIX", requireEnv("MAILCHIMP_API_KEY").split("-")[1] ?? "");
const api = restClient({ name: "Mailchimp", base: () => `https://${dc()}.api.mailchimp.com/3.0`, headers: () => ({ Authorization: `Basic ${Buffer.from(`any:${requireEnv("MAILCHIMP_API_KEY")}`).toString("base64")}` }), hints: { 401: "check MAILCHIMP_API_KEY (must end with -usXX)" } });
const audience = (id?: string) => id ?? requireEnv("MAILCHIMP_AUDIENCE_ID");
const hash = (email: string) => createHash("md5").update(email.trim().toLowerCase()).digest("hex");

type Rec = Record<string, unknown>;
const AUD = z.string().optional().describe("Audience (list) ID (default MAILCHIMP_AUDIENCE_ID)");

const server = new McpServer(
  { name: "mailchimp", version: "0.1.0" },
  { instructions: "Mailchimp: account and audiences, campaign reports (opens, clicks, e-commerce revenue), audience growth, members (add/update, tags; subscribing needs consent + confirm), sending test emails or campaigns (confirm) and raw API." },
);

server.registerTool(
  "mailchimp_account",
  { title: "Account & audiences", description: "Account details and audiences with member counts, open/click rates and last campaign date.", inputSchema: {} },
  () =>
    run(async () => {
      const [acct, lists] = await Promise.all([api(""), api("lists", { query: { count: 100, fields: "lists.id,lists.name,lists.stats" } })]);
      const a = acct as Rec;
      return { account: { name: a.account_name, email: a.email, industry: a.account_industry, total_subscribers: a.total_subscribers, timezone: (a.contact as Rec)?.timezone ?? a.account_timezone }, audiences: ((lists as Rec).lists as Rec[]).map((l) => ({ id: l.id, name: l.name, members: (l.stats as Rec).member_count, unsubscribed: (l.stats as Rec).unsubscribe_count, open_rate: (l.stats as Rec).open_rate, click_rate: (l.stats as Rec).click_rate, last_campaign: (l.stats as Rec).campaign_last_sent })) };
    }),
);

server.registerTool(
  "mailchimp_campaign_report",
  { title: "Campaign reports", description: "Sent campaigns in a period with recipients, open and click rates, unsubscribes, bounces and e-commerce orders/revenue; or one campaign's full report including top links and domain performance.", inputSchema: { campaign_id: z.string().optional(), preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), limit: z.number().int().min(1).max(1000).default(100) } },
  (a) =>
    run(async () => {
      if (a.campaign_id) {
        const [rep, links, domains] = await Promise.all([api(`reports/${a.campaign_id}`), api(`reports/${a.campaign_id}/click-details`, { query: { count: 20 } }), api(`reports/${a.campaign_id}/domain-performance`)]);
        return { ...(rep as Rec), top_links: ((links as Rec).urls_clicked as Rec[])?.map((u) => ({ url: u.url, clicks: u.total_clicks, unique: u.unique_clicks })), domains: (domains as Rec).domains };
      }
      const w = window(a.preset, a.from, a.to);
      const r = (await api("reports", { query: { count: a.limit, since_send_time: `${w.from}T00:00:00+00:00`, before_send_time: `${w.to}T23:59:59+00:00` } })) as { reports: Rec[] };
      const rows = r.reports.map((x) => ({ id: x.id, title: x.campaign_title, subject: x.subject_line, sent: x.send_time, recipients: x.emails_sent, open_rate: round(Number((x.opens as Rec)?.open_rate ?? 0) * 100), click_rate: round(Number((x.clicks as Rec)?.click_rate ?? 0) * 100), unsubscribes: x.unsubscribed, bounces: Number((x.bounces as Rec)?.hard_bounces ?? 0) + Number((x.bounces as Rec)?.soft_bounces ?? 0), orders: (x.ecommerce as Rec)?.total_orders, revenue: (x.ecommerce as Rec)?.total_revenue, currency: (x.ecommerce as Rec)?.currency_code }));
      return { window: w, campaigns: rows, total_revenue: round(rows.reduce((s, x) => s + Number(x.revenue ?? 0), 0)) };
    }),
);

server.registerTool(
  "mailchimp_growth",
  { title: "Audience growth", description: "Monthly audience growth history (subscribed, unsubscribed, cleaned) and top signup locations/clients.", inputSchema: { audience_id: AUD, months: z.number().int().min(1).max(36).default(12) } },
  (a) =>
    run(async () => {
      const id = audience(a.audience_id);
      const [g, loc] = await Promise.all([api(`lists/${id}/growth-history`, { query: { count: a.months, sort_field: "month", sort_dir: "DESC" } }), api(`lists/${id}/locations`).catch(() => ({ locations: [] }))]);
      return { history: (g as Rec).history, top_locations: ((loc as Rec).locations as Rec[])?.slice(0, 10) };
    }),
);

server.registerTool(
  "mailchimp_members",
  {
    title: "Members",
    description: "Look up a member by email; add or update a member (merge fields like FNAME/LNAME, tags); set tags; or change status. Adding someone as 'subscribed' requires their consent and confirm — use 'pending' to send a double opt-in email.",
    inputSchema: { action: z.enum(["get", "upsert", "tags", "search"]).default("get"), audience_id: AUD, email: z.string().optional(), query: z.string().optional(), status: z.enum(["subscribed", "unsubscribed", "cleaned", "pending", "transactional"]).optional(), merge_fields: z.record(z.unknown()).optional(), tags: z.array(z.string()).optional(), remove_tags: z.array(z.string()).optional(), confirm: z.boolean().default(false) },
  },
  (a) =>
    run(async () => {
      const id = audience(a.audience_id);
      if (a.action === "search") return (((await api("search-members", { query: { query: a.query ?? a.email ?? "", list_id: id } })) as Rec).exact_matches as Rec)?.members;
      if (!a.email) throw new Error("email is required");
      const path = `lists/${id}/members/${hash(a.email)}`;
      if (a.action === "get") {
        const m = (await api(path)) as Rec;
        return { email: m.email_address, status: m.status, merge_fields: m.merge_fields, tags: (m.tags as Rec[])?.map((t) => t.name), rating: m.member_rating, signup: m.timestamp_signup, last_changed: m.last_changed, stats: m.stats, location: m.location };
      }
      if (a.action === "tags") return api(`${path}/tags`, { body: { tags: [...(a.tags ?? []).map((n) => ({ name: n, status: "active" })), ...(a.remove_tags ?? []).map((n) => ({ name: n, status: "inactive" }))] } });
      if (a.status === "subscribed" && !a.confirm) throw new Error("Subscribing someone directly requires their consent; set confirm: true (or use status 'pending' for double opt-in)");
      const r = await api(path, { method: "PUT", body: { email_address: a.email, status_if_new: a.status ?? "pending", status: a.status, merge_fields: a.merge_fields } });
      if (a.tags?.length) await api(`${path}/tags`, { body: { tags: a.tags.map((n) => ({ name: n, status: "active" })) } });
      return { email: (r as Rec).email_address, status: (r as Rec).status };
    }),
);

server.registerTool(
  "mailchimp_send",
  { title: "Send campaign / test", description: "Send a test email of a campaign to given addresses, schedule it, or send it now to the whole audience. Always needs confirm; send now can't be undone.", inputSchema: { campaign_id: z.string(), action: z.enum(["test", "schedule", "send"]), test_emails: z.array(z.string()).optional(), schedule_time: z.string().optional().describe("ISO time, on a quarter hour"), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (!a.confirm) throw new Error(a.action === "send" ? "This emails the whole audience now and can't be undone; set confirm: true" : "Set confirm: true");
      if (a.action === "test") await api(`campaigns/${a.campaign_id}/actions/test`, { body: { test_emails: a.test_emails, send_type: "html" } });
      else if (a.action === "schedule") await api(`campaigns/${a.campaign_id}/actions/schedule`, { body: { schedule_time: a.schedule_time } });
      else await api(`campaigns/${a.campaign_id}/actions/send`, { method: "POST" });
      return { done: a.action, campaign: a.campaign_id };
    }),
);

server.registerTool(
  "mailchimp_api",
  { title: "Mailchimp API call", description: "Call any Mailchimp Marketing API endpoint (campaigns, automations, templates, ecommerce/stores, segments…). Writes need confirm.", inputSchema: { method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method !== "GET" && !a.confirm) throw new Error("Write calls change Mailchimp; set confirm: true");
      return api(a.path.replace(/^\/?(3\.0\/)?/, ""), { method: a.method, query: a.query, body: a.body });
    }),
);

await startStdio(server, "mailchimp");
