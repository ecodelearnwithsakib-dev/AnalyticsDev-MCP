import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { confirm, describe, fieldName, flat, sf, soql, toApi, type Rec } from "../client.js";

type SaveResult = { id?: string; success: boolean; created?: boolean; errors?: { statusCode?: string; message?: string; fields?: string[] }[] };
const results = (rows: SaveResult[]) => ({
  succeeded: rows.filter((r) => r.success).length,
  failed: rows.filter((r) => !r.success).length,
  results: rows.map((r) => (r.success ? { ok: true, id: r.id, created: r.created } : { ok: false, errors: r.errors?.map((e) => `${e.statusCode}: ${e.message}${e.fields?.length ? ` [${e.fields.join(", ")}]` : ""}`) })),
});

export function registerDataTools(server: McpServer): void {
  server.registerTool(
    "sf_query",
    {
      title: "SOQL query",
      description:
        "Run SOQL on any object (standard or custom): relationship fields (Account.Name, Owner.Email), subqueries, aggregates with GROUP BY, date literals (THIS_QUARTER, LAST_N_DAYS:30). Pages through large results automatically; include_deleted uses queryAll; tooling queries the Tooling API (ApexClass, Flow, ValidationRule…). Rows come back flat and readable.",
      inputSchema: { soql: z.string(), max_rows: z.number().int().min(1).max(50000).default(2000), include_deleted: z.boolean().default(false), tooling: z.boolean().default(false) },
    },
    (a) =>
      run(async () => {
        const res = await soql(a.soql, a.max_rows, a.include_deleted, a.tooling);
        return { total: res.totalSize, returned: res.records.length, records: res.records.map((r) => flat(r)) };
      }),
  );

  server.registerTool(
    "sf_search",
    {
      title: "Search across objects",
      description: "Find anything by text across Accounts, Contacts, Leads, Opportunities, Cases (or objects you choose) — names, emails, phones, and other searchable fields — or run raw SOSL.",
      inputSchema: {
        text: z.string().optional(),
        objects: z.array(z.string()).default(["Account", "Contact", "Lead", "Opportunity", "Case"]),
        sosl: z.string().optional().describe("Raw SOSL, e.g. FIND {acme} IN ALL FIELDS RETURNING Account(Id, Name)"),
        limit: z.number().int().min(1).max(200).default(20),
      },
    },
    (a) =>
      run(async () => {
        if (a.sosl) return ((await sf<{ searchRecords: Rec[] }>("search", { query: { q: a.sosl } })).searchRecords ?? []).map((r) => ({ type: (r.attributes as Rec)?.type, ...flat(r) }));
        if (!a.text) throw new Error("text or sosl is required");
        const url = new URLSearchParams({ q: a.text, overallLimit: String(a.limit) });
        const defaults: Record<string, string> = { Account: "Id,Name,Phone,Website,Owner.Name", Contact: "Id,Name,Email,Phone,Account.Name", Lead: "Id,Name,Company,Email,Status", Opportunity: "Id,Name,StageName,Amount,CloseDate", Case: "Id,CaseNumber,Subject,Status" };
        for (const o of a.objects) {
          url.append("sobject", o);
          if (defaults[o]) url.append(`${o}.fields`, defaults[o]);
        }
        const res = await sf<{ searchRecords: Rec[] }>(`parameterizedSearch?${url.toString()}`);
        return (res.searchRecords ?? []).map((r) => ({ type: (r.attributes as Rec)?.type, ...flat(r) }));
      }),
  );

  server.registerTool(
    "sf_records",
    {
      title: "Create / read / update / delete records",
      description:
        "CRUD on any object: get a record (chosen fields or all), create one or many (up to 200 per call; fields by label or API name, picklists by label, owner by name/email/\"me\", dates like tomorrow), update by Id (one or many), upsert on an external-ID field, delete (confirm), and undelete from the recycle bin. Per-record results show exactly which failed and why.",
      inputSchema: {
        action: z.enum(["get", "create", "update", "upsert", "delete", "undelete"]),
        object: z.string().describe("API name: Account, Contact, Lead, Opportunity, Case, Task, Custom__c…"),
        id: z.string().optional(),
        ids: z.array(z.string()).optional(),
        fields: z.array(z.string()).optional(),
        records: z.array(z.record(z.unknown())).optional().describe("create/update/upsert (update needs Id in each, or pass id with one record)"),
        external_id_field: z.string().optional().describe("upsert: e.g. External_Id__c or Email-based custom field"),
        all_or_none: z.boolean().default(false),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        const obj = (await describe(a.object)).name;
        switch (a.action) {
          case "get": {
            const id = a.id ?? a.ids?.[0];
            if (!id) throw new Error("id is required");
            const fields = a.fields ? await Promise.all(a.fields.map((f) => fieldName(obj, f))) : undefined;
            return flat(await sf<Rec>(`sobjects/${obj}/${id}`, { query: { fields: fields?.join(",") } }));
          }
          case "create":
          case "update":
          case "upsert": {
            if (!a.records?.length) throw new Error("records is required");
            const recs = await Promise.all(a.records.map(async (r, i) => ({ attributes: { type: obj }, ...(await toApi(obj, a.action === "update" && a.id && i === 0 && !r.Id && !r.id ? { ...r, Id: a.id } : r)) })));
            if (a.action === "update" && recs.some((r) => !(r as Rec).Id && !(r as Rec).id)) throw new Error("update: every record needs Id");
            const out: SaveResult[] = [];
            for (let i = 0; i < recs.length; i += 200) {
              const batch = recs.slice(i, i + 200);
              if (a.action === "create") out.push(...(await sf<SaveResult[]>("composite/sobjects", { body: { allOrNone: a.all_or_none, records: batch } })));
              else if (a.action === "update") out.push(...(await sf<SaveResult[]>("composite/sobjects", { method: "PATCH", body: { allOrNone: a.all_or_none, records: batch.map((r) => ({ ...r, Id: (r as Rec).Id ?? (r as Rec).id, id: undefined })) } })));
              else {
                if (!a.external_id_field) throw new Error("external_id_field is required for upsert");
                const ext = await fieldName(obj, a.external_id_field);
                out.push(...(await sf<SaveResult[]>(`composite/sobjects/${obj}/${ext}`, { method: "PATCH", body: { allOrNone: a.all_or_none, records: batch } })));
              }
            }
            return results(out);
          }
          case "delete": {
            const ids = a.ids ?? (a.id ? [a.id] : []);
            if (!ids.length) throw new Error("id or ids is required");
            if (!a.confirm) throw new Error(`Deleting ${ids.length} ${obj} record(s) moves them to the recycle bin (15 days); set confirm: true`);
            const out: SaveResult[] = [];
            for (let i = 0; i < ids.length; i += 200) out.push(...(await sf<SaveResult[]>("composite/sobjects", { method: "DELETE", query: { ids: ids.slice(i, i + 200).join(","), allOrNone: a.all_or_none } })));
            return results(out);
          }
          case "undelete":
            throw new Error("Undelete isn't in the REST API — use the Recycle Bin in Setup, or the Bulk API with operation undelete via sf_api");
        }
      }),
  );

  server.registerTool(
    "sf_describe",
    {
      title: "Objects, fields & picklists",
      description: "Learn the org's data model: list objects (filter by name, custom only), describe an object's fields (type, required, picklist values, lookups, external IDs), record types, and the valid values of one picklist.",
      inputSchema: {
        what: z.enum(["objects", "fields", "picklist", "record_types"]),
        object: z.string().optional(),
        field: z.string().optional(),
        search: z.string().optional(),
        custom_only: z.boolean().default(false),
      },
    },
    (a) =>
      run(async () => {
        if (a.what === "objects") {
          const res = await sf<{ sobjects: Rec[] }>("sobjects");
          return res.sobjects
            .filter((o) => o.queryable && (!a.custom_only || o.custom) && (!a.search || String(o.name).toLowerCase().includes(a.search.toLowerCase()) || String(o.label).toLowerCase().includes(a.search.toLowerCase())))
            .map((o) => ({ name: o.name, label: o.label, custom: o.custom || undefined, key_prefix: o.keyPrefix }));
        }
        if (!a.object) throw new Error("object is required");
        const d = await describe(a.object);
        if (a.what === "record_types") return (d.recordTypeInfos ?? []).filter((r) => r.active).map((r) => ({ name: r.name, id: r.recordTypeId, default: r.master || undefined }));
        if (a.what === "picklist") {
          if (!a.field) throw new Error("field is required");
          const f = d.fields.find((x) => x.name === (d.fields.find((y) => y.name.toLowerCase() === a.field!.toLowerCase() || y.label.toLowerCase() === a.field!.toLowerCase())?.name));
          return f?.picklistValues?.filter((p) => p.active).map((p) => ({ value: p.value, label: p.label })) ?? [];
        }
        return d.fields
          .filter((f) => !a.search || f.name.toLowerCase().includes(a.search.toLowerCase()) || f.label.toLowerCase().includes(a.search.toLowerCase()))
          .map((f) => ({ name: f.name, label: f.label, type: f.type, required: (!f.nillable && f.createable && !f.defaultedOnCreate) || undefined, lookup: f.referenceTo?.length ? f.referenceTo.join("|") : undefined, external_id: f.externalId || undefined, custom: f.custom || undefined, values: f.picklistValues?.filter((p) => p.active).map((p) => p.value) }));
      }),
  );

  server.registerTool(
    "sf_bulk",
    {
      title: "Bulk API 2.0 (big exports & loads)",
      description: "Large data: export any SOQL to a local CSV (millions of rows, Bulk API 2.0 query job), or load a local CSV to insert/update/upsert/delete records (delete needs confirm). Check job status and failed rows.",
      inputSchema: {
        action: z.enum(["export", "load", "status"]),
        soql: z.string().optional(),
        object: z.string().optional(),
        operation: z.enum(["insert", "update", "upsert", "delete"]).optional(),
        external_id_field: z.string().optional(),
        file_path: z.string().optional().describe("export: where to save (default ./exports/<object>.csv); load: the CSV to upload"),
        job_id: z.string().optional(),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        const wait = async (path: string) => {
          for (let i = 0; i < 120; i++) {
            const j = await sf<Rec>(path);
            if (["JobComplete", "Failed", "Aborted"].includes(String(j.state))) return j;
            await new Promise((r) => setTimeout(r, 3000));
          }
          throw new Error("Job still running — check later with action status");
        };
        if (a.action === "export") {
          if (!a.soql) throw new Error("soql is required");
          const job = await sf<{ id: string }>("jobs/query", { body: { operation: "query", query: a.soql } });
          const done = await wait(`jobs/query/${job.id}`);
          if (done.state !== "JobComplete") return done;
          const object = a.soql.match(/\bfrom\s+(\w+)/i)?.[1] ?? "export";
          const path = resolve(a.file_path ?? `./exports/${object}.csv`);
          await mkdir(dirname(path), { recursive: true });
          let locator: string | undefined;
          let rows = 0;
          for (let page = 0; ; page++) {
            const res = await sf<Response>(`jobs/query/${job.id}/results`, { query: { locator, maxRecords: 50000 }, accept: "text/csv", response: true });
            const text = await res.text();
            const lines = text.split("\n");
            await writeFile(path, page === 0 ? text : lines.slice(1).join("\n"), { flag: page === 0 ? "w" : "a" });
            rows += lines.slice(1).filter(Boolean).length;
            locator = res.headers.get("sforce-locator") ?? undefined;
            if (!locator || locator === "null") break;
          }
          return { saved: path, rows, job_id: job.id };
        }
        if (a.action === "load") {
          if (!a.object || !a.operation || !a.file_path) throw new Error("object, operation and file_path are required");
          if (a.operation === "delete" && !a.confirm) throw new Error("Bulk delete removes every Id in the file; set confirm: true");
          const job = await sf<{ id: string }>("jobs/ingest", { body: { object: a.object, operation: a.operation, externalIdFieldName: a.external_id_field, contentType: "CSV", lineEnding: "LF" } });
          await sf(`jobs/ingest/${job.id}/batches`, { method: "PUT", raw: (await readFile(a.file_path, "utf8")).replace(/\r\n/g, "\n") });
          await sf(`jobs/ingest/${job.id}`, { method: "PATCH", body: { state: "UploadComplete" } });
          const done = await wait(`jobs/ingest/${job.id}`);
          const failed = Number(done.numberRecordsFailed) ? await sf<string>(`jobs/ingest/${job.id}/failedResults`, { accept: "text/csv" }) : undefined;
          return { job_id: job.id, state: done.state, processed: done.numberRecordsProcessed, failed: done.numberRecordsFailed, failed_rows_sample: failed?.split("\n").slice(0, 11).join("\n") };
        }
        if (!a.job_id) throw new Error("job_id is required");
        return sf(`jobs/ingest/${a.job_id}`).catch(() => sf(`jobs/query/${a.job_id}`));

      }),
  );

  server.registerTool(
    "sf_api",
    {
      title: "Salesforce REST call",
      description: "Call ANY Salesforce REST endpoint: relative paths go under /services/data/vXX.X/ (e.g. sobjects/Account/describe/layouts, limits, actions/standard, tooling/sobjects, connect/…); absolute paths (/services/apexrest/…) for your Apex REST.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string(),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional(),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        if (a.method === "DELETE" && !a.confirm) throw new Error("DELETE calls need confirm: true");
        return sf(a.path, { method: a.method, query: a.query, body: a.body });
      }),
  );
}
