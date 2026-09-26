#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { PRESETS, round, window } from "../shared/hub.js";
import { oauthRefresher, restClient, sha256 } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

const token = oauthRefresher({ tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken", clientIdEnv: "LINKEDIN_CLIENT_ID", clientSecretEnv: "LINKEDIN_CLIENT_SECRET", refreshTokenEnv: "LINKEDIN_REFRESH_TOKEN", signinHint: "run `npm run auth:linkedin`" });
const bearer = async () => optionalEnv("LINKEDIN_ACCESS_TOKEN") || token.get();
const li = restClient({
  name: "LinkedIn",
  base: () => optionalEnv("LINKEDIN_API_BASE", "https://api.linkedin.com/rest"),
  headers: async () => ({ Authorization: `Bearer ${await bearer()}`, "LinkedIn-Version": optionalEnv("LINKEDIN_VERSION", "202608"), "X-Restli-Protocol-Version": "2.0.0" }),
  hints: { 401: "run `npm run auth:linkedin` again", 403: "the app needs Advertising API access and the user needs a role on the ad account" },
  onUnauthorized: () => token.reset(),
});

type Rec = Record<string, unknown>;
const accountId = (id?: string) => String(id ?? requireEnv("LINKEDIN_AD_ACCOUNT_ID")).replace(/^urn:li:sponsoredAccount:/, "");
const urn = (kind: string, id: string | number) => (String(id).startsWith("urn:") ? String(id) : `urn:li:${kind}:${id}`);
const E = encodeURIComponent;
const ymdParts = (d: string) => {
  const [y, m, dd] = d.split("-").map(Number);
  return `(year:${y},month:${m},day:${dd})`;
};

/** Rest.li query strings: keep (), :, and , literal; encode URNs inside List(). */
const restli = (params: Record<string, string>) => Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");

async function analytics(o: { account: string; pivot: string; from: string; to: string; daily: boolean; campaigns?: string[]; fields: string[] }) {
  const q = restli({
    q: "analytics",
    pivot: o.pivot,
    timeGranularity: o.daily ? "DAILY" : "ALL",
    dateRange: `(start:${ymdParts(o.from)},end:${ymdParts(o.to)})`,
    ...(o.campaigns?.length ? { campaigns: `List(${o.campaigns.map((c) => E(urn("sponsoredCampaign", c))).join(",")})` } : { accounts: `List(${E(urn("sponsoredAccount", o.account))})` }),
    fields: [...new Set([...o.fields, "dateRange", "pivotValues"])].join(","),
  });
  return ((await li(`adAnalytics?${q}`)) as { elements?: Rec[] }).elements ?? [];
}

async function names(account: string, kind: "campaigns" | "campaignGroups" | "creatives"): Promise<Map<string, Rec>> {
  const path = kind === "campaigns" ? "adCampaigns" : kind === "campaignGroups" ? "adCampaignGroups" : "creatives";
  const out = new Map<string, Rec>();
  let start = 0;
  for (;;) {
    const r = (await li(`adAccounts/${account}/${path}?q=${kind === "creatives" ? "criteria" : "search"}&start=${start}&count=500`)) as { elements?: Rec[]; paging?: { total?: number } };
    for (const e of r.elements ?? []) out.set(String(e.id).replace(/^.*:/, ""), e);
    start += 500;
    if (!r.elements?.length || start >= (r.paging?.total ?? 0)) break;
  }
  return out;
}

const server = new McpServer(
  { name: "linkedin-ads", version: "0.1.0" },
  { instructions: "LinkedIn Marketing API (versioned REST): ad accounts, campaign groups, campaigns, performance reports with demographic pivots (company, job function, seniority, industry, country), budgets and status, Conversions API, lead-gen form responses. Money is in the account currency; new campaigns start paused." },
);

const ACC = z.string().optional().describe("Ad account ID (default LINKEDIN_AD_ACCOUNT_ID)");

server.registerTool(
  "linkedin_accounts",
  { title: "Ad accounts", description: "Ad accounts you can access (id, name, currency, status, type) and your role.", inputSchema: {} },
  () => run(async () => (((await li("adAccounts?q=search&search=(status:(values:List(ACTIVE,DRAFT,CANCELED)))&count=100")) as { elements?: Rec[] }).elements ?? []).map((a) => ({ id: a.id, name: a.name, currency: a.currency, status: a.status, type: a.type, test: a.test }))),
);

server.registerTool(
  "linkedin_report",
  {
    title: "Performance report",
    description:
      "LinkedIn Ads metrics by campaign, campaign group, creative or account — or B2B audience pivots (MEMBER_COMPANY, MEMBER_JOB_FUNCTION, MEMBER_SENIORITY, MEMBER_INDUSTRY, MEMBER_COUNTRY_V2, MEMBER_COMPANY_SIZE): impressions, clicks, spend, CTR, CPC, CPM, conversions, conversion value, leads (lead-gen forms), CPA, ROAS; daily or total with names attached.",
    inputSchema: {
      account_id: ACC,
      pivot: z.enum(["CAMPAIGN", "CAMPAIGN_GROUP", "CREATIVE", "ACCOUNT", "MEMBER_COMPANY", "MEMBER_JOB_FUNCTION", "MEMBER_SENIORITY", "MEMBER_INDUSTRY", "MEMBER_COUNTRY_V2", "MEMBER_COMPANY_SIZE", "MEMBER_JOB_TITLE"]).default("CAMPAIGN"),
      preset: z.enum(PRESETS).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      daily: z.boolean().default(false),
      campaigns: z.array(z.string()).optional(),
    },
  },
  (a) =>
    run(async () => {
      const acc = accountId(a.account_id);
      const w = window(a.preset, a.from, a.to);
      const rows = await analytics({ account: acc, pivot: a.pivot, from: w.from, to: w.to, daily: a.daily, campaigns: a.campaigns, fields: ["impressions", "clicks", "costInLocalCurrency", "externalWebsiteConversions", "conversionValueInLocalCurrency", "oneClickLeads", "landingPageClicks", "videoViews", "totalEngagements"] });
      const lookup = a.pivot === "CAMPAIGN" ? await names(acc, "campaigns").catch(() => new Map()) : a.pivot === "CAMPAIGN_GROUP" ? await names(acc, "campaignGroups").catch(() => new Map()) : new Map();
      const out = rows.map((r) => {
        const id = String((r.pivotValues as string[] | undefined)?.[0] ?? "").replace(/^.*:/, "");
        const spend = Number(r.costInLocalCurrency ?? 0);
        const conv = Number(r.externalWebsiteConversions ?? 0) + Number(r.oneClickLeads ?? 0);
        const value = Number(r.conversionValueInLocalCurrency ?? 0);
        const dr = r.dateRange as { start?: { year: number; month: number; day: number } } | undefined;
        return {
          ...(a.daily && dr?.start ? { date: `${dr.start.year}-${String(dr.start.month).padStart(2, "0")}-${String(dr.start.day).padStart(2, "0")}` } : {}),
          id,
          name: (lookup.get(id)?.name as string) ?? (r.pivotValues as string[] | undefined)?.[0],
          status: lookup.get(id)?.status,
          impressions: Number(r.impressions ?? 0),
          clicks: Number(r.clicks ?? 0),
          spend: round(spend),
          conversions: conv,
          leads: Number(r.oneClickLeads ?? 0),
          value: round(value),
          ctr_pct: Number(r.impressions) ? round((Number(r.clicks) / Number(r.impressions)) * 100) : null,
          cpc: Number(r.clicks) ? round(spend / Number(r.clicks)) : null,
          cpa: conv ? round(spend / conv) : null,
          roas: spend && value ? round(value / spend) : null,
        };
      });
      return { window: w, pivot: a.pivot, rows: out.sort((x, y) => y.spend - x.spend) };
    }),
);

server.registerTool(
  "linkedin_campaigns",
  {
    title: "Campaigns & groups",
    description: "List campaign groups and campaigns (status, objective, daily/total budget, bid, dates); pause/activate/archive; change daily budget or bid. Budgets and bids are in the account currency.",
    inputSchema: {
      account_id: ACC,
      action: z.enum(["list", "groups", "set_status", "update_budget"]).default("list"),
      ids: z.array(z.string()).optional(),
      status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]).optional(),
      daily_budget: z.number().optional(),
      bid: z.number().optional(),
    },
  },
  (a) =>
    run(async () => {
      const acc = accountId(a.account_id);
      if (a.action === "list" || a.action === "groups") {
        const m = await names(acc, a.action === "list" ? "campaigns" : "campaignGroups");
        return [...m.values()].map((c) => ({ id: c.id, name: c.name, status: c.status, objective: c.objectiveType, daily_budget: (c.dailyBudget as Rec)?.amount, total_budget: (c.totalBudget as Rec)?.amount, currency: ((c.dailyBudget ?? c.totalBudget) as Rec)?.currencyCode, bid: (c.unitCost as Rec)?.amount, type: c.type, group: c.campaignGroup }));
      }
      if (!a.ids?.length) throw new Error("ids is required");
      const cur = ((await li(`adAccounts/${acc}`)) as Rec).currency as string;
      const results = [];
      for (const id of a.ids) {
        const $set: Rec = {};
        if (a.action === "set_status") $set.status = a.status ?? "PAUSED";
        if (a.daily_budget !== undefined) $set.dailyBudget = { amount: String(a.daily_budget), currencyCode: cur };
        if (a.bid !== undefined) $set.unitCost = { amount: String(a.bid), currencyCode: cur };
        await li(`adAccounts/${acc}/adCampaigns/${id}`, { method: "POST", headers: { "X-RestLi-Method": "PARTIAL_UPDATE" }, body: { patch: { $set } } });
        results.push({ id, ...$set });
      }
      return { updated: results };
    }),
);

server.registerTool(
  "linkedin_conversions",
  {
    title: "Conversions API",
    description: "List conversion rules for the ad account, or send offline/server conversions (hashed email, value, event_id for deduplication) to a rule. Sending needs confirm.",
    inputSchema: {
      account_id: ACC,
      action: z.enum(["rules", "send"]).default("rules"),
      rule: z.string().optional().describe("Conversion rule ID (from rules)"),
      events: z.array(z.object({ time: z.string(), email: z.string().optional(), value: z.number().optional(), currency: z.string().optional(), event_id: z.string().optional(), first_name: z.string().optional(), last_name: z.string().optional(), company: z.string().optional() })).optional(),
      confirm: z.boolean().default(false),
    },
  },
  (a) =>
    run(async () => {
      const acc = accountId(a.account_id);
      if (a.action === "rules") return (((await li(`conversions?q=account&account=${E(urn("sponsoredAccount", acc))}&count=100`)) as { elements?: Rec[] }).elements ?? []).map((c) => ({ id: c.id, name: c.name, type: c.type, enabled: c.enabled, attribution: c.attributionType, value: c.value }));
      if (!a.rule || !a.events?.length) throw new Error("rule and events are required");
      if (!a.confirm) return { preview: true, would_send: a.events.length, note: "Pass confirm: true to send" };
      const elements = await Promise.all(
        a.events.map(async (e) => ({
          conversion: urn("llaPartnerConversion", a.rule!),
          conversionHappenedAt: Date.parse(e.time),
          conversionValue: e.value !== undefined ? { currencyCode: (e.currency ?? "USD").toUpperCase(), amount: String(e.value) } : undefined,
          eventId: e.event_id,
          user: { userIds: e.email ? [{ idType: "SHA256_EMAIL", idValue: await sha256(e.email, "email") }] : [], userInfo: e.first_name || e.last_name || e.company ? { firstName: e.first_name, lastName: e.last_name, companyName: e.company } : undefined },
        })),
      );
      await li("conversionEvents", { method: "POST", headers: { "X-RestLi-Method": "BATCH_CREATE" }, body: { elements } });
      return { sent: elements.length };
    }),
);

server.registerTool(
  "linkedin_leads",
  { title: "Lead gen form responses", description: "Lead Gen Form submissions for the ad account (answers, submitted time, form and campaign) for a window — ready to push into a CRM.", inputSchema: { account_id: ACC, preset: z.enum(PRESETS).optional(), limit: z.number().int().min(1).max(1000).default(100) } },
  (a) =>
    run(async () => {
      const acc = accountId(a.account_id);
      const w = window(a.preset ?? "last_7_days");
      const q = restli({ q: "owner", owner: `(sponsoredAccount:${E(urn("sponsoredAccount", acc))})`, leadType: "(leadType:SPONSORED)", submittedAtTimeRange: `(start:${Date.parse(`${w.from}T00:00:00Z`)},end:${Date.parse(`${w.to}T23:59:59Z`)})`, count: String(a.limit) });
      const r = (await li(`leadFormResponses?${q}`)) as { elements?: Rec[] };
      return (r.elements ?? []).map((l) => ({ id: l.id, submitted: l.submittedAt ? new Date(Number(l.submittedAt)).toISOString() : undefined, form: l.leadForm ?? l.versionedLeadGenFormUrn, campaign: (l.leadMetadata as Rec)?.sponsoredLeadMetadata, answers: ((l.formResponse as Rec)?.answers as Rec[] | undefined)?.map((x) => ({ question: x.questionId, answer: (x.answerDetails as Rec)?.textQuestionAnswer ?? x.answerDetails })) }));
    }),
);

server.registerTool(
  "linkedin_api",
  { title: "LinkedIn API call", description: "Call any versioned LinkedIn Marketing REST endpoint (relative to https://api.linkedin.com/rest), e.g. adTargetingFacets, adBudgetPricing, dmpSegments, organizationalEntityShareStatistics. Query strings are sent as written (Rest.li syntax).", inputSchema: { method: z.enum(["GET", "POST", "DELETE"]).default("GET"), path: z.string(), body: z.unknown().optional(), restli_method: z.string().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method === "DELETE" && !a.confirm) throw new Error("DELETE calls need confirm: true");
      return li(a.path.replace("{account}", accountId()), { method: a.method, body: a.body, headers: a.restli_method ? { "X-RestLi-Method": a.restli_method } : undefined });
    }),
);

await startStdio(server, "linkedin-ads");
