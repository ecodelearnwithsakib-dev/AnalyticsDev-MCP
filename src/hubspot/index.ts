#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { PRESETS, round, window } from "../shared/hub.js";
import { restClient } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/** HubSpot CRM v3 with a private app access token (Settings → Integrations → Private apps). */
const api = restClient({
  name: "HubSpot",
  base: () => optionalEnv("HUBSPOT_API_BASE", "https://api.hubapi.com"),
  headers: () => ({ Authorization: `Bearer ${requireEnv("HUBSPOT_ACCESS_TOKEN")}` }),
  hints: { 401: "check HUBSPOT_ACCESS_TOKEN (private app token)", 403: "the private app is missing a scope (crm.objects.deals.read, crm.objects.contacts.read, …)" },
});

type Rec = Record<string, unknown>;
const OBJECTS = ["contacts", "companies", "deals", "tickets", "leads", "line_items", "products", "quotes", "calls", "emails", "meetings", "notes", "tasks"] as const;
const DEFAULT_PROPS: Record<string, string[]> = {
  contacts: ["email", "firstname", "lastname", "phone", "company", "lifecyclestage", "hs_lead_status", "hubspot_owner_id", "hs_analytics_source", "hs_analytics_source_data_1", "createdate"],
  companies: ["name", "domain", "industry", "city", "country", "numberofemployees", "annualrevenue", "hubspot_owner_id", "createdate"],
  deals: ["dealname", "amount", "deal_currency_code", "dealstage", "pipeline", "closedate", "hubspot_owner_id", "hs_is_closed_won", "hs_is_closed", "createdate"],
  tickets: ["subject", "content", "hs_pipeline_stage", "hs_ticket_priority", "hubspot_owner_id", "createdate"],
};

/** Search with automatic paging (CRM search caps at 10 000 results and 200 per page). */
async function search(object: string, body: Rec, max: number): Promise<Rec[]> {
  const out: Rec[] = [];
  let after: string | undefined;
  do {
    const r = (await api(`crm/v3/objects/${object}/search`, { body: { limit: Math.min(200, max - out.length), ...body, after } })) as { results: Rec[]; paging?: { next?: { after: string } } };
    out.push(...r.results);
    after = r.paging?.next?.after;
  } while (after && out.length < max);
  return out;
}
const flat = (r: Rec) => ({ id: r.id, ...(r.properties as Rec) });
const ms = (d: string, end = false) => String(Date.parse(`${d}T${end ? "23:59:59.999" : "00:00:00"}Z`));

let stageCache: Map<string, { label: string; pipeline: string; won?: boolean; closed?: boolean }> | undefined;
async function stages() {
  if (stageCache) return stageCache;
  const r = (await api("crm/v3/pipelines/deals")) as { results: { id: string; label: string; stages: { id: string; label: string; metadata?: { isClosed?: string; probability?: string } }[] }[] };
  stageCache = new Map();
  for (const p of r.results) for (const s of p.stages) stageCache.set(s.id, { label: s.label, pipeline: p.label, closed: s.metadata?.isClosed === "true", won: s.metadata?.isClosed === "true" && s.metadata?.probability === "1.0" });
  return stageCache;
}
async function resolveStage(v: string | undefined) {
  if (!v) return undefined;
  const st = await stages();
  if (st.has(v)) return v;
  for (const [id, s] of st) if (s.label.toLowerCase() === v.toLowerCase()) return id;
  throw new Error(`Unknown deal stage "${v}". Stages: ${[...st.values()].map((s) => `${s.pipeline}/${s.label}`).join(", ")}`);
}

const server = new McpServer(
  { name: "hubspot", version: "0.1.0" },
  { instructions: "HubSpot CRM via a private app token: search/create/update any CRM object (contacts, companies, deals, tickets, …), associations, deal pipeline report with won revenue by stage/owner/source, won deals for offline conversion sync, owners, properties, forms and raw API. Deletes and merges need confirm. HubSpot's official remote MCP can be used alongside." },
);

server.registerTool(
  "hubspot_account",
  { title: "Account", description: "Portal ID, time zone, currency and API usage for the connected HubSpot account.", inputSchema: {} },
  () =>
    run(async () => {
      const [info, usage] = await Promise.all([api("account-info/v3/details"), api("account-info/v3/api-usage/daily/private-apps").catch(() => undefined)]);
      return { ...(info as Rec), api_usage: usage };
    }),
);

server.registerTool(
  "hubspot_search",
  {
    title: "Search CRM",
    description: "Search any CRM object by text and/or filters (property, operator EQ/NEQ/GT/GTE/LT/LTE/CONTAINS_TOKEN/HAS_PROPERTY/IN…), sorted, with chosen properties. Dates can be YYYY-MM-DD.",
    inputSchema: {
      object: z.string().default("contacts").describe(`One of ${OBJECTS.join(", ")} or a custom object type`),
      query: z.string().optional(),
      filters: z.array(z.object({ property: z.string(), operator: z.string().default("EQ"), value: z.union([z.string(), z.number(), z.boolean()]).optional(), values: z.array(z.string()).optional() })).optional(),
      properties: z.array(z.string()).optional(),
      sort: z.string().optional().describe("property, prefix with - for descending"),
      limit: z.number().int().min(1).max(10000).default(50),
    },
  },
  (a) =>
    run(async () => {
      const toVal = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? ms(v) : v === undefined ? undefined : String(v));
      const rows = await search(
        a.object,
        {
          query: a.query,
          filterGroups: a.filters?.length ? [{ filters: a.filters.map((f) => ({ propertyName: f.property, operator: f.operator, value: toVal(f.value), values: f.values })) }] : undefined,
          properties: a.properties ?? DEFAULT_PROPS[a.object],
          sorts: a.sort ? [{ propertyName: a.sort.replace(/^-/, ""), direction: a.sort.startsWith("-") ? "DESCENDING" : "ASCENDING" }] : undefined,
        },
        a.limit,
      );
      return rows.map(flat);
    }),
);

server.registerTool(
  "hubspot_records",
  {
    title: "Records",
    description: "Get, create, update, upsert (by email/domain or a unique property), delete (confirm) or merge (confirm) CRM records; deal stages accept labels. Batch up to 100 records per call.",
    inputSchema: {
      object: z.string().default("contacts"),
      action: z.enum(["get", "create", "update", "upsert", "delete", "merge"]),
      id: z.string().optional(),
      id_property: z.string().optional().describe("Look up/upsert by this unique property (e.g. email)"),
      properties: z.record(z.unknown()).optional(),
      records: z.array(z.object({ id: z.string().optional(), properties: z.record(z.unknown()) })).max(100).optional(),
      merge_into: z.string().optional(),
      fields: z.array(z.string()).optional().describe("Properties to return on get"),
      associations: z.array(z.string()).optional().describe("Associated object types to include on get"),
      confirm: z.boolean().default(false),
    },
  },
  (a) =>
    run(async () => {
      const obj = `crm/v3/objects/${a.object}`;
      const fix = async (p: Rec = {}) => (a.object === "deals" && typeof p.dealstage === "string" ? { ...p, dealstage: await resolveStage(p.dealstage) } : p);
      switch (a.action) {
        case "get":
          if (!a.id) throw new Error("id is required");
          return flat((await api(`${obj}/${encodeURIComponent(a.id)}`, { query: { idProperty: a.id_property, properties: (a.fields ?? DEFAULT_PROPS[a.object])?.join(","), associations: a.associations?.join(",") } })) as Rec);
        case "create":
          if (a.records?.length) return api(`${obj}/batch/create`, { body: { inputs: await Promise.all(a.records.map(async (r) => ({ properties: await fix(r.properties) }))) } });
          return flat((await api(obj, { body: { properties: await fix(a.properties) } })) as Rec);
        case "update":
          if (a.records?.length) return api(`${obj}/batch/update`, { body: { inputs: await Promise.all(a.records.map(async (r) => ({ id: r.id, idProperty: a.id_property, properties: await fix(r.properties) }))) } });
          if (!a.id) throw new Error("id is required");
          return flat((await api(`${obj}/${encodeURIComponent(a.id)}`, { method: "PATCH", query: { idProperty: a.id_property }, body: { properties: await fix(a.properties) } })) as Rec);
        case "upsert": {
          const idProp = a.id_property ?? (a.object === "contacts" ? "email" : a.object === "companies" ? "domain" : undefined);
          if (!idProp) throw new Error("id_property is required for upsert");
          const inputs = await Promise.all((a.records ?? [{ properties: a.properties ?? {} }]).map(async (r) => ({ id: String(r.id ?? r.properties[idProp]), idProperty: idProp, properties: await fix(r.properties) })));
          return api(`${obj}/batch/upsert`, { body: { inputs } });
        }
        case "delete":
          if (!a.id) throw new Error("id is required");
          if (!a.confirm) throw new Error("Deleting moves the record to the recycle bin (90 days); set confirm: true");
          await api(`${obj}/${encodeURIComponent(a.id)}`, { method: "DELETE" });
          return { deleted: a.id };
        case "merge":
          if (!a.id || !a.merge_into) throw new Error("id and merge_into are required");
          if (!a.confirm) throw new Error("Merging can't be undone; set confirm: true");
          return api(`${obj}/merge`, { body: { primaryObjectId: a.merge_into, objectIdToMerge: a.id } });
      }
    }),
);

server.registerTool(
  "hubspot_associations",
  { title: "Associations", description: "List a record's associated records, or associate/unassociate two records (e.g. contact ↔ deal, deal ↔ company) with the default label.", inputSchema: { action: z.enum(["list", "associate", "remove"]).default("list"), from_object: z.string(), from_id: z.string(), to_object: z.string(), to_id: z.string().optional() } },
  (a) =>
    run(async () => {
      const base = `crm/v4/objects/${a.from_object}/${a.from_id}/associations`;
      if (a.action === "list") return api(`${base}/${a.to_object}`, { query: { limit: 500 } });
      if (!a.to_id) throw new Error("to_id is required");
      if (a.action === "associate") return api(`${base}/default/${a.to_object}/${a.to_id}`, { method: "PUT" });
      await api(`${base}/${a.to_object}/${a.to_id}`, { method: "DELETE" });
      return { removed: true };
    }),
);

server.registerTool(
  "hubspot_pipeline_report",
  {
    title: "Pipeline report",
    description: "Deal pipeline for a period: open pipeline by stage, deals created, won/lost count and revenue, win rate, average deal size and sales cycle, and won revenue by owner and original traffic source.",
    inputSchema: { preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), pipeline: z.string().optional().describe("Pipeline label or ID") },
  },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const st = await stages();
      const pipeFilter = a.pipeline ? [{ propertyName: "pipeline", operator: "EQ", value: a.pipeline }] : [];
      const props = [...DEFAULT_PROPS.deals, "hs_analytics_source", "days_to_close"];
      const [open, created, closed] = await Promise.all([
        search("deals", { filterGroups: [{ filters: [{ propertyName: "hs_is_closed", operator: "EQ", value: "false" }, ...pipeFilter] }], properties: props }, 10000),
        search("deals", { filterGroups: [{ filters: [{ propertyName: "createdate", operator: "BETWEEN", value: ms(w.from), highValue: ms(w.to, true) }, ...pipeFilter] }], properties: props }, 10000),
        search("deals", { filterGroups: [{ filters: [{ propertyName: "closedate", operator: "BETWEEN", value: ms(w.from), highValue: ms(w.to, true) }, { propertyName: "hs_is_closed", operator: "EQ", value: "true" }, ...pipeFilter] }], properties: props }, 10000),
      ]);
      const amt = (d: Rec) => Number((d.properties as Rec).amount ?? 0);
      const won = closed.filter((d) => (d.properties as Rec).hs_is_closed_won === "true");
      const byStage: Record<string, { deals: number; amount: number }> = {};
      for (const d of open) {
        const s = st.get(String((d.properties as Rec).dealstage));
        const k = s ? `${s.pipeline} / ${s.label}` : String((d.properties as Rec).dealstage);
        (byStage[k] ??= { deals: 0, amount: 0 }).deals++;
        byStage[k].amount += amt(d);
      }
      const group = (key: string) => {
        const m: Record<string, { deals: number; revenue: number }> = {};
        for (const d of won) {
          const k = String((d.properties as Rec)[key] ?? "(none)");
          (m[k] ??= { deals: 0, revenue: 0 }).deals++;
          m[k].revenue += amt(d);
        }
        return Object.entries(m).map(([k, v]) => ({ key: k, deals: v.deals, revenue: round(v.revenue) })).sort((x, y) => y.revenue - x.revenue);
      };
      const wonRev = won.reduce((s, d) => s + amt(d), 0);
      const cycles = won.map((d) => Number((d.properties as Rec).days_to_close)).filter((n) => Number.isFinite(n));
      return {
        window: w,
        open_pipeline: { deals: open.length, amount: round(open.reduce((s, d) => s + amt(d), 0)), by_stage: Object.entries(byStage).map(([k, v]) => ({ stage: k, deals: v.deals, amount: round(v.amount) })) },
        created: created.length,
        won: won.length,
        lost: closed.length - won.length,
        won_revenue: round(wonRev),
        win_rate: closed.length ? round((won.length / closed.length) * 100) : null,
        avg_deal: won.length ? round(wonRev / won.length) : null,
        avg_days_to_close: cycles.length ? round(cycles.reduce((s, n) => s + n, 0) / cycles.length) : null,
        won_by_owner: group("hubspot_owner_id"),
        won_by_source: group("hs_analytics_source"),
      };
    }),
);

server.registerTool(
  "hubspot_won_deals",
  {
    title: "Won deals (for conversion sync)",
    description: "Closed-won deals in a period with amount, currency, close date and the primary contact's email, phone and ad click IDs (gclid/fbclid/msclkid/li_fat_id/ttclid/rdt_cid if stored as contact properties) — used by conversion-sync to upload offline conversions.",
    inputSchema: { preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), click_id_properties: z.array(z.string()).default(["gclid", "hs_google_click_id", "fbclid", "hs_facebook_click_id", "msclkid", "li_fat_id", "ttclid", "rdt_cid", "fbc", "fbp"]) },
  },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const deals = await search("deals", { filterGroups: [{ filters: [{ propertyName: "closedate", operator: "BETWEEN", value: ms(w.from), highValue: ms(w.to, true) }, { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" }] }], properties: DEFAULT_PROPS.deals }, 10000);
      const currency = optionalEnv("HUBSPOT_CURRENCY", "");
      const out = [];
      for (const d of deals) {
        const p = d.properties as Rec;
        const assoc = (await api(`crm/v4/objects/deals/${d.id}/associations/contacts`, { query: { limit: 1 } }).catch(() => ({ results: [] }))) as { results: { toObjectId: number }[] };
        const cid = assoc.results[0]?.toObjectId;
        let contact: Rec = {};
        if (cid) contact = ((await api(`crm/v3/objects/contacts/${cid}`, { query: { properties: ["email", "phone", "mobilephone", ...a.click_id_properties].join(",") } }).catch(() => ({ properties: {} }))) as { properties: Rec }).properties;
        const ids: Rec = {};
        for (const k of a.click_id_properties) if (contact[k]) ids[k.replace(/^hs_google_click_id$/, "gclid").replace(/^hs_facebook_click_id$/, "fbclid")] = contact[k];
        out.push({ id: d.id, name: p.dealname, amount: Number(p.amount ?? 0), currency: p.deal_currency_code || currency || undefined, closed_at: p.closedate, email: contact.email, phone: contact.phone || contact.mobilephone, contact_id: cid, ...ids });
      }
      return { window: w, count: out.length, deals: out };
    }),
);

server.registerTool(
  "hubspot_meta",
  { title: "Owners, properties, pipelines, forms", description: "List owners, an object's properties (with picklist options), deal/ticket pipelines and stages, or marketing forms.", inputSchema: { what: z.enum(["owners", "properties", "pipelines", "forms"]), object: z.string().default("contacts"), search: z.string().optional() } },
  (a) =>
    run(async () => {
      const q = a.search?.toLowerCase();
      const keep = (x: Rec) => !q || JSON.stringify(x).toLowerCase().includes(q);
      if (a.what === "owners") return (((await api("crm/v3/owners", { query: { limit: 500 } })) as { results: Rec[] }).results).filter(keep).map((o) => ({ id: o.id, email: o.email, name: `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim(), teams: o.teams }));
      if (a.what === "properties") return (((await api(`crm/v3/properties/${a.object}`)) as { results: Rec[] }).results).filter(keep).map((p) => ({ name: p.name, label: p.label, type: p.type, field: p.fieldType, group: p.groupName, options: (p.options as { label: string; value: string }[] | undefined)?.map((o) => `${o.label}=${o.value}`) }));
      if (a.what === "pipelines") return (await api(`crm/v3/pipelines/${a.object === "contacts" ? "deals" : a.object}`)) as Rec;
      return (((await api("marketing/v3/forms", { query: { limit: 100 } })) as { results: Rec[] }).results).filter(keep).map((f) => ({ id: f.id, name: f.name, type: f.formType, created: f.createdAt }));
    }),
);

server.registerTool(
  "hubspot_api",
  { title: "HubSpot API call", description: "Call any HubSpot API endpoint (e.g. crm/v3/objects/…, automation/v4/flows, marketing/v3/emails, cms/v3/pages). Writes need confirm.", inputSchema: { method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method !== "GET" && !/\/search$/.test(a.path) && !a.confirm) throw new Error("Write calls change HubSpot data; set confirm: true");
      return api(a.path.replace(/^\//, ""), { method: a.method, query: a.query, body: a.body });
    }),
);

await startStdio(server, "hubspot");
