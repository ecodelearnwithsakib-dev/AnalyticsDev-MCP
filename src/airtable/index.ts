#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { restClient } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/** Airtable Web API with a personal access token (scopes: data.records:read/write, schema.bases:read/write). */
const api = restClient({ name: "Airtable", base: () => optionalEnv("AIRTABLE_API_BASE", "https://api.airtable.com/v0"), headers: () => ({ Authorization: `Bearer ${requireEnv("AIRTABLE_TOKEN")}` }), hints: { 401: "check AIRTABLE_TOKEN", 403: "the token lacks a scope or access to this base", 404: "unknown base/table — check airtable_bases" } });
const base = (id?: string) => id ?? requireEnv("AIRTABLE_BASE_ID");

type Rec = Record<string, unknown>;
const BASE = z.string().optional().describe("Base ID appXXXX (default AIRTABLE_BASE_ID)");
const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const server = new McpServer(
  { name: "airtable", version: "0.1.0" },
  { instructions: "Airtable: bases and table schemas, list/search records with formulas and views, create/update/upsert records in batches of 10 (typecast on), delete records (confirm), create tables/fields and raw API. Use airtable_schema first to learn field names." },
);

server.registerTool(
  "airtable_bases",
  { title: "Bases", description: "Bases the token can access, with permission level.", inputSchema: {} },
  () => run(async () => ((await api("meta/bases")) as { bases: Rec[] }).bases),
);

server.registerTool(
  "airtable_schema",
  { title: "Tables & fields", description: "Tables in a base with fields (name, type, options such as select choices) and views.", inputSchema: { base_id: BASE, table: z.string().optional() } },
  (a) =>
    run(async () => {
      const t = ((await api(`meta/bases/${base(a.base_id)}/tables`)) as { tables: Rec[] }).tables.filter((x) => !a.table || x.name === a.table || x.id === a.table);
      return t.map((x) => ({ id: x.id, name: x.name, primary: x.primaryFieldId, fields: (x.fields as Rec[]).map((f) => ({ id: f.id, name: f.name, type: f.type, choices: ((f.options as Rec)?.choices as Rec[])?.map((c) => c.name) })), views: (x.views as Rec[]).map((v) => `${v.name} (${v.type})`) }));
    }),
);

server.registerTool(
  "airtable_records",
  { title: "List / search records", description: "List records from a table with an optional formula filter (e.g. AND({Status}='Open', {Amount}>100)), view, sort, chosen fields — or get one by record ID.", inputSchema: { base_id: BASE, table: z.string(), id: z.string().optional(), formula: z.string().optional(), view: z.string().optional(), fields: z.array(z.string()).optional(), sort: z.array(z.string()).optional().describe("Field names, prefix with - for descending"), limit: z.number().int().min(1).max(10000).default(100) } },
  (a) =>
    run(async () => {
      const path = `${base(a.base_id)}/${encodeURIComponent(a.table)}`;
      if (a.id) {
        const r = (await api(`${path}/${a.id}`)) as Rec;
        return { id: r.id, created: r.createdTime, ...(r.fields as Rec) };
      }
      const out: Rec[] = [];
      let offset: string | undefined;
      do {
        const r = (await api(`${path}/listRecords`, { body: { filterByFormula: a.formula, view: a.view, fields: a.fields, sort: a.sort?.map((s) => ({ field: s.replace(/^-/, ""), direction: s.startsWith("-") ? "desc" : "asc" })), pageSize: Math.min(100, a.limit - out.length), offset } })) as { records: Rec[]; offset?: string };
        out.push(...r.records.map((x) => ({ id: x.id, ...(x.fields as Rec) })));
        offset = r.offset;
      } while (offset && out.length < a.limit);
      return out;
    }),
);

server.registerTool(
  "airtable_write",
  {
    title: "Create / update / upsert / delete",
    description: "Create, update (by record id) or upsert (merge on fields) records — any number, sent in batches of 10 with typecast so select options and linked records by name work. Delete needs confirm.",
    inputSchema: { base_id: BASE, table: z.string(), action: z.enum(["create", "update", "upsert", "delete"]), records: z.array(z.object({ id: z.string().optional(), fields: z.record(z.unknown()).optional() })).min(1).max(1000), merge_on: z.array(z.string()).optional(), replace: z.boolean().default(false).describe("PUT instead of PATCH (clears unspecified fields)"), confirm: z.boolean().default(false) },
  },
  (a) =>
    run(async () => {
      const path = `${base(a.base_id)}/${encodeURIComponent(a.table)}`;
      const out: Rec[] = [];
      if (a.action === "delete") {
        if (!a.confirm) throw new Error("Deleting records (they go to the base's trash for 7 days); set confirm: true");
        for (const c of chunks(a.records, 10)) out.push(...((await api(path, { method: "DELETE", query: { "records[]": c.map((r) => r.id!) } })) as { records: Rec[] }).records);
        return out;
      }
      if (a.action === "upsert" && !a.merge_on?.length) throw new Error("merge_on (1–3 field names) is required for upsert");
      for (const c of chunks(a.records, 10)) {
        const body: Rec = { typecast: true, records: c.map((r) => (a.action === "create" ? { fields: r.fields } : a.action === "update" ? { id: r.id, fields: r.fields } : { fields: r.fields })) };
        if (a.action === "upsert") body.performUpsert = { fieldsToMergeOn: a.merge_on };
        const r = (await api(path, { method: a.action === "create" ? "POST" : a.replace ? "PUT" : "PATCH", body })) as { records: Rec[]; createdRecords?: string[]; updatedRecords?: string[] };
        out.push(...r.records.map((x) => ({ id: x.id, ...(x.fields as Rec) })));
      }
      return { count: out.length, records: out.slice(0, 50) };
    }),
);

server.registerTool(
  "airtable_schema_write",
  { title: "Create table / field", description: "Create a table (with fields) or add a field to a table (e.g. {name:'Status', type:'singleSelect', options:{choices:[{name:'Open'}]}}). Needs confirm.", inputSchema: { base_id: BASE, action: z.enum(["create_table", "create_field"]), table: z.string().optional(), name: z.string(), fields: z.array(z.record(z.unknown())).optional(), field: z.record(z.unknown()).optional(), description: z.string().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (!a.confirm) throw new Error("Changes the base schema; set confirm: true");
      if (a.action === "create_table") return api(`meta/bases/${base(a.base_id)}/tables`, { body: { name: a.name, description: a.description, fields: a.fields ?? [{ name: "Name", type: "singleLineText" }] } });
      if (!a.table) throw new Error("table is required");
      return api(`meta/bases/${base(a.base_id)}/tables/${encodeURIComponent(a.table)}/fields`, { body: { name: a.name, description: a.description, ...a.field } });
    }),
);

server.registerTool(
  "airtable_api",
  { title: "Airtable API call", description: "Call any Airtable Web API endpoint (comments, webhooks, meta/whoami…). Writes need confirm.", inputSchema: { method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method !== "GET" && !/listRecords$/.test(a.path) && !a.confirm) throw new Error("Write calls change Airtable; set confirm: true");
      return api(a.path.replace(/^\/?(v0\/)?/, ""), { method: a.method, query: a.query, body: a.body });
    }),
);

await startStdio(server, "airtable");
