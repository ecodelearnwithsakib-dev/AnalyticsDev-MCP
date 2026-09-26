#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { configRoot, profile } from "../shared/env.js";
import { closeChildren, PRESETS, window } from "../shared/hub.js";
import { run, startStdio } from "../shared/server.js";
import { DESTINATIONS, type SendOptions } from "./destinations.js";
import { SOURCES, type Deal } from "./sources.js";
import { registerPlaybooks } from "../shared/playbooks.js";

/** Which deal went to which platform — so a sync can run daily without double-counting. */
const stateFile = resolve(configRoot, ".state", `conversion-sync${profile ? `.${profile}` : ""}.json`);
type State = { sent: Record<string, { at: string; value: number; currency: string }> };
const loadState = (): State => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { sent: {} });
function saveState(s: State) {
  mkdirSync(resolve(configRoot, ".state"), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(s, null, 2), { mode: 0o600 });
}

const server = new McpServer(
  { name: "conversion-sync", version: "0.1.0" },
  {
    instructions:
      "Sends closed-won CRM deals (Pipedrive, Salesforce, HighLevel, Zoho, Odoo, HubSpot) to ad platforms as offline conversions (Google Ads, Meta CAPI, Microsoft Ads, Reddit, OpenAI Ads, LinkedIn) with click IDs or hashed email/phone. Always sync_preview first; sync_run defaults to test mode and needs confirm for real uploads. Each deal is sent to each platform once (state kept per profile).",
  },
);

const common = {
  sources: z.array(z.string()).optional().describe("pipedrive, salesforce, ghl, zoho, odoo, hubspot (default: all configured)"),
  destinations: z.array(z.string()).optional().describe("google, meta, microsoft, reddit, openai, linkedin (default: all configured)"),
  preset: z.enum(PRESETS).optional().describe("Won/closed date window; default last_7_days"),
  from: z.string().optional(),
  to: z.string().optional(),
  event: z.enum(["purchase", "lead"]).default("purchase").describe("Send as purchases (value = deal amount) or qualified leads"),
  google_action_id: z.string().optional().describe("Google Ads conversion action ID (else CONVSYNC_GOOGLE_ACTION_ID)"),
  msads_goal: z.string().optional().describe("Microsoft offline conversion goal name (else CONVSYNC_MSADS_GOAL)"),
};

const pick = <T extends { key: string; isConfigured: () => boolean }>(list: T[], keys?: string[]) =>
  keys?.length
    ? keys.map((k) => {
        const x = list.find((i) => i.key === k);
        if (!x) throw new Error(`Unknown ${k}. Known: ${list.map((i) => i.key).join(", ")}`);
        return x;
      })
    : list.filter((x) => x.isConfigured());

async function gather(a: { sources?: string[]; preset?: string; from?: string; to?: string }) {
  const w = window(a.preset, a.from, a.to);
  const errors: Record<string, string> = {};
  const deals: Deal[] = [];
  for (const s of pick(SOURCES, a.sources)) {
    try {
      deals.push(...(await s.fetch(w)));
    } catch (e) {
      errors[s.key] = e instanceof Error ? e.message : String(e);
    }
  }
  return { w, deals, errors };
}

server.registerTool(
  "sync_setup",
  {
    title: "Sources and destinations",
    description: "Which CRMs (sources) and ad platforms (destinations) are connected, plus the settings each destination needs (conversion action, offline goal, pixel).",
    inputSchema: {},
  },
  () =>
    run(async () => ({
      sources: SOURCES.map((s) => ({ key: s.key, title: s.title, connected: s.isConfigured() })),
      destinations: DESTINATIONS.map((d) => ({ key: d.key, title: d.title, connected: d.isConfigured() })),
      settings: ["CONVSYNC_GOOGLE_ACTION_ID (Google Ads conversion action ID)", "CONVSYNC_MSADS_GOAL (Microsoft offline goal name)", "CONVSYNC_META_EVENT (default Purchase)", "CONVSYNC_CURRENCY (when the CRM doesn't store one)", "CONVSYNC_SF_FIELDS / CONVSYNC_ZOHO_FIELDS / CONVSYNC_ODOO_FIELDS (custom click-ID fields to read, e.g. GCLID__c)", "CONVSYNC_LINKEDIN_RULE (LinkedIn conversion rule ID)"],
      state_file: stateFile,
    })),
);

server.registerTool(
  "sync_preview",
  {
    title: "Preview the sync",
    description: "Lists won deals in the window with the identifiers found (email, phone, gclid, msclkid, fbc, rdt_cid…) and, per ad platform, whether each deal will be sent, was already sent, or why it can't be matched.",
    inputSchema: common,
  },
  (a) =>
    run(async () => {
      const { w, deals, errors } = await gather(a);
      const dests = pick(DESTINATIONS, a.destinations);
      const state = loadState();
      const opts: SendOptions = { event: a.event, test: true, google_action_id: a.google_action_id, msads_goal: a.msads_goal };
      const rows = deals.map((d) => ({
        deal: `${d.source}-${d.id}`,
        name: d.name,
        value: d.value,
        currency: d.currency,
        won_at: d.won_at,
        identifiers: Object.entries({ email: d.email, phone: d.phone, gclid: d.gclid, gbraid: d.gbraid, wbraid: d.wbraid, msclkid: d.msclkid, fbc: d.fbc, rdt_cid: d.rdt_cid, oppref: d.oppref }).filter(([, v]) => v).map(([k]) => k),
        destinations: Object.fromEntries(dests.map((x) => [x.key, state.sent[`${x.key}:${d.source}-${d.id}`] ? "already sent" : x.ineligible(d, opts) ?? "will send"])),
      }));
      const summary = Object.fromEntries(dests.map((x) => [x.key, { will_send: rows.filter((r) => r.destinations[x.key] === "will send").length, already_sent: rows.filter((r) => r.destinations[x.key] === "already sent").length }]));
      return { window: w, deals: rows.length, value: rows.reduce((s, r) => s + r.value, 0), summary, rows, errors: Object.keys(errors).length ? errors : undefined };
    }),
);

server.registerTool(
  "sync_run",
  {
    title: "Send conversions",
    description:
      "Uploads eligible, not-yet-sent deals to each ad platform. test: true (default) uses each platform's test/validation mode (Google validate_only, Meta test event code, Reddit test ID, OpenAI validate_only) and records nothing; test: false with confirm: true sends for real and remembers what was sent.",
    inputSchema: { ...common, test: z.boolean().default(true), confirm: z.boolean().default(false), meta_test_code: z.string().optional(), reddit_test_id: z.string().optional() },
  },
  (a) =>
    run(async () => {
      if (!a.test && !a.confirm) throw new Error("Real uploads change ad-platform reporting and bidding — run sync_preview, then pass test: false and confirm: true");
      const { w, deals, errors } = await gather(a);
      const dests = pick(DESTINATIONS, a.destinations);
      const state = loadState();
      const opts: SendOptions = { event: a.event, test: a.test, google_action_id: a.google_action_id, msads_goal: a.msads_goal, meta_test_code: a.meta_test_code, reddit_test_id: a.reddit_test_id };
      const results: Record<string, unknown> = {};
      for (const dest of dests) {
        const batch = deals.filter((d) => !state.sent[`${dest.key}:${d.source}-${d.id}`] && !dest.ineligible(d, opts));
        if (!batch.length) {
          results[dest.key] = { sent: 0, note: "nothing new to send" };
          continue;
        }
        try {
          const r = await dest.send(batch, opts);
          if (!a.test) for (const key of r.sent) state.sent[`${dest.key}:${key}`] = { at: new Date().toISOString(), value: batch.find((d) => `${d.source}-${d.id}` === key)?.value ?? 0, currency: batch[0].currency };
          results[dest.key] = { attempted: batch.length, sent: r.sent.length, failed: Object.keys(r.failed).length ? r.failed : undefined, test: a.test };
        } catch (e) {
          results[dest.key] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (!a.test) saveState(state);
      return { window: w, test: a.test, deals: deals.length, results, errors: Object.keys(errors).length ? errors : undefined };
    }),
);

server.registerTool(
  "sync_history",
  {
    title: "Sync history",
    description: "What has been sent to which platform (per profile), newest first, with totals per destination. forget removes entries so they can be re-sent.",
    inputSchema: { limit: z.number().int().min(1).max(5000).default(100), forget: z.array(z.string()).optional().describe("Keys like google:pipedrive-123 to forget"), confirm: z.boolean().default(false) },
  },
  (a) =>
    run(async () => {
      const state = loadState();
      if (a.forget?.length) {
        if (!a.confirm) throw new Error("Forgetting entries allows them to be uploaded again (possible duplicates); set confirm: true");
        for (const k of a.forget) delete state.sent[k];
        saveState(state);
      }
      const entries = Object.entries(state.sent).sort((x, y) => y[1].at.localeCompare(x[1].at));
      const totals: Record<string, { count: number; value: number }> = {};
      for (const [k, v] of entries) {
        const d = k.split(":")[0];
        totals[d] = { count: (totals[d]?.count ?? 0) + 1, value: (totals[d]?.value ?? 0) + v.value };
      }
      return { totals, recent: entries.slice(0, a.limit).map(([k, v]) => ({ key: k, ...v })), state_file: stateFile };
    }),
);

process.stdin.on("close", () => void closeChildren());
registerPlaybooks(server, ["offline_conversion_setup"]);
await startStdio(server, "conversion-sync");
