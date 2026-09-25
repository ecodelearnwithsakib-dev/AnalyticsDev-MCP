import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { apiName, compact, day, fieldList, moduleName, schema, toApi, writeResults, zoho } from "../client.js";
import { userId } from "../people.js";

type Rec = Record<string, unknown>;
type Page = { data?: Rec[]; info?: { more_records?: boolean; next_page_token?: string; count?: number } };

const escape = (v: unknown) => String(v).replace(/([(),\\])/g, "\\$1");

/** {Field: value} / {Field: {op: value}} → Zoho search criteria "((A:equals:x)and(B:greater_than:5))". */
async function criteriaFrom(module: string, where: Record<string, unknown>): Promise<string> {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(where)) {
    const field = await apiName(module, k);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [op, val] of Object.entries(v)) parts.push(`(${field}:${op}:${Array.isArray(val) ? val.map(escape).join(",") : escape(val)})`);
    } else if (Array.isArray(v)) parts.push(`(${field}:in:${v.map(escape).join(",")})`);
    else parts.push(`(${field}:equals:${escape(v)})`);
  }
  return parts.length === 1 ? parts[0] : `(${parts.join("and")})`;
}

/** Owner by name/email/"me", and dates like "tomorrow", inside a record before it is written. */
async function prepare(module: string, record: Rec): Promise<Rec> {
  const out = await toApi(module, record);
  if (typeof out.Owner === "string") out.Owner = { id: await userId(out.Owner) };
  for (const key of ["Closing_Date", "Due_Date", "Date_of_Birth"]) if (typeof out[key] === "string") out[key] = day(out[key] as string);
  return out;
}

const TRIGGERS = z.array(z.enum(["workflow", "approval", "blueprint"])).optional().describe("Automation to run on write (default: all; [] runs none)");

export function registerRecordTools(server: McpServer): void {
  server.registerTool(
    "zoho_crm_api",
    {
      title: "Zoho CRM API call",
      description: "Call ANY Zoho CRM REST endpoint. Paths are relative to /crm/v8 (e.g. \"Deals/123/actions/blueprint\", \"settings/layouts\") or absolute (\"/crm/bulk/v8/read\").",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string(),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional(),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        if (a.method === "DELETE" && !a.confirm) throw new Error("DELETE calls need confirm: true");
        return zoho(a.path, { method: a.method, query: a.query, body: a.body });
      }),
  );

  server.registerTool(
    "zoho_crm_records",
    {
      title: "Records: list / get / create / update / upsert / delete",
      description:
        "Work with records in any module. list (sorted, paged past 2,000 with page tokens, optional custom view), get one, create up to 100 (fields by label or API name, owner by name/email/\"me\", dates like tomorrow), update (by id), upsert (dedupe on fields such as Email), mass_update (same change on many ids, dry run first), delete (confirm), deleted (recycle bin). Automations (workflow/approval/blueprint) run unless triggers: [] is set.",
      inputSchema: {
        action: z.enum(["list", "get", "create", "update", "upsert", "mass_update", "delete", "deleted"]),
        module: schema.module,
        id: z.string().optional(),
        ids: z.array(z.string()).optional(),
        records: z.array(z.record(z.unknown())).optional().describe("create/update/upsert: records; update needs id in each (or pass id with one record)"),
        changes: z.record(z.unknown()).optional().describe("mass_update: the fields to set on every id"),
        duplicate_check_fields: z.array(z.string()).optional().describe("upsert: e.g. [\"Email\"]"),
        fields: schema.fields,
        sort_by: z.enum(["id", "Created_Time", "Modified_Time"]).optional(),
        sort_order: z.enum(["asc", "desc"]).default("desc"),
        custom_view_id: z.string().optional(),
        limit: z.number().int().min(1).max(10000).default(100),
        triggers: TRIGGERS,
        dry_run: z.boolean().default(false),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const module = await moduleName(a.module);
        const trigger = a.triggers;
        switch (a.action) {
          case "list": {
            const out: Rec[] = [];
            let page = 1;
            let token: string | undefined;
            const f = await fieldList(module, a.fields);
            while (out.length < a.limit) {
              const res = await zoho<Page>(module, { query: { fields: f, per_page: Math.min(200, a.limit - out.length), ...(token ? { page_token: token } : { page }), sort_by: a.sort_by, sort_order: a.sort_by ? a.sort_order : undefined, cvid: a.custom_view_id } });
              out.push(...(res.data ?? []));
              if (!res.info?.more_records) break;
              token = res.info.next_page_token;
              page++;
            }
            return { module, count: out.length, records: out.map(compact) };
          }
          case "get": {
            const id = a.id ?? a.ids?.[0];
            if (!id) throw new Error("id is required");
            const res = await zoho<Page>(`${module}/${id}`, { query: { fields: a.fields?.length ? await fieldList(module, a.fields) : undefined } });
            return compact(res.data?.[0] ?? {});
          }
          case "create":
          case "update":
          case "upsert": {
            if (!a.records?.length) throw new Error("records is required");
            const data = await Promise.all(a.records.map((r, i) => prepare(module, a.action === "update" && a.id && i === 0 && !r.id ? { ...r, id: a.id } : r)));
            if (a.action === "update" && data.some((r) => !r.id)) throw new Error("update: every record needs an id");
            const out = [];
            for (let i = 0; i < data.length; i += 100) {
              const body: Rec = { data: data.slice(i, i + 100), trigger };
              if (a.action === "upsert") body.duplicate_check_fields = await Promise.all((a.duplicate_check_fields ?? []).map((f) => apiName(module, f)));
              out.push(writeResults(await zoho(a.action === "upsert" ? `${module}/upsert` : module, { method: a.action === "update" ? "PUT" : "POST", body })));
            }
            return out.length === 1 ? out[0] : out;
          }
          case "mass_update": {
            const ids = a.ids ?? (a.id ? [a.id] : []);
            if (!ids.length || !a.changes) throw new Error("ids and changes are required");
            const change = await prepare(module, a.changes);
            if (a.dry_run || !a.confirm) return { dry_run: true, module, would_update: ids.length, set: change, note: "Pass confirm: true (and dry_run: false) to apply." };
            const out = [];
            for (let i = 0; i < ids.length; i += 100) out.push(writeResults(await zoho(module, { method: "PUT", body: { data: ids.slice(i, i + 100).map((id) => ({ id, ...change })), trigger } })));
            return out;
          }
          case "delete": {
            const ids = a.ids ?? (a.id ? [a.id] : []);
            if (!ids.length) throw new Error("id or ids is required");
            if (!a.confirm) throw new Error(`Deleting ${ids.length} ${module} record(s) moves them to the recycle bin; set confirm: true`);
            const out = [];
            for (let i = 0; i < ids.length; i += 100) out.push(writeResults(await zoho(module, { method: "DELETE", query: { ids: ids.slice(i, i + 100), wf_trigger: trigger?.includes("workflow") ?? true } })));
            return out;
          }
          case "deleted": {
            const res = await zoho<Page>(`${module}/deleted`, { query: { type: "all", per_page: Math.min(200, a.limit) } });
            return res.data ?? [];
          }
        }
      }),
  );

  server.registerTool(
    "zoho_crm_search",
    {
      title: "Search records",
      description:
        "Find records: by email, phone or keyword, by simple conditions ({\"Lead Source\": \"Facebook\", \"Annual_Revenue\": {\"greater_than\": 100000}, \"Stage\": [\"Qualification\",\"Negotiation\"]}) or raw criteria like ((Last_Name:starts_with:Kh)and(City:equals:Dhaka)). Returns up to 2,000 matches. For joins, aggregates or date math use zoho_crm_query (COQL).",
      inputSchema: {
        module: schema.module,
        email: z.string().optional(),
        phone: z.string().optional(),
        word: z.string().optional().describe("Keyword across all text fields"),
        where: z.record(z.unknown()).optional().describe("Operators: equals, not_equal, starts_with, in, not_in, greater_than, greater_equal, less_than, less_equal, between"),
        criteria: z.string().optional(),
        fields: schema.fields,
        limit: z.number().int().min(1).max(2000).default(100),
      },
    },
    (a) =>
      run(async () => {
        const module = await moduleName(a.module);
        const criteria = a.criteria ?? (a.where ? await criteriaFrom(module, a.where) : undefined);
        if (!criteria && !a.email && !a.phone && !a.word) throw new Error("Give email, phone, word, where or criteria");
        const out: Rec[] = [];
        for (let page = 1; out.length < a.limit; page++) {
          const res = await zoho<Page>(`${module}/search`, {
            query: { criteria, email: a.email, phone: a.phone, word: a.word, fields: a.fields?.length ? await fieldList(module, a.fields) : undefined, page, per_page: Math.min(200, a.limit) },
          });
          out.push(...(res.data ?? []));
          if (!res.info?.more_records) break;
        }
        return { module, criteria, count: out.length, records: out.slice(0, a.limit).map(compact) };
      }),
  );

  server.registerTool(
    "zoho_crm_related",
    {
      title: "Notes, related lists, attachments, tags, timeline",
      description:
        "Everything around one record: notes (list/add), any related list (e.g. an Account's Contacts or Deals, a Deal's Contact_Roles, Products), attachments (list, upload a local file), tags (add/remove on many records), and the timeline (who changed what, when).",
      inputSchema: {
        action: z.enum(["notes", "add_note", "related", "attachments", "attach_file", "add_tags", "remove_tags", "timeline"]),
        module: schema.module,
        id: z.string().optional(),
        ids: z.array(z.string()).optional().describe("add_tags/remove_tags: records"),
        related_list: z.string().optional().describe("related: API name such as Contacts, Deals, Activities, Products, Contact_Roles, Emails"),
        title: z.string().optional(),
        content: z.string().optional(),
        file_path: z.string().optional(),
        tags: z.array(z.string()).optional(),
        fields: schema.fields,
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    (a) =>
      run(async () => {
        const module = await moduleName(a.module);
        const id = a.id ?? a.ids?.[0];
        const need = () => {
          if (!id) throw new Error("id is required");
          return id;
        };
        switch (a.action) {
          case "notes": {
            const res = await zoho<Page>(`${module}/${need()}/Notes`, { query: { fields: "Note_Title,Note_Content,Owner,Created_Time,Modified_Time", per_page: a.limit } });
            return (res.data ?? []).map(compact);
          }
          case "add_note":
            if (!a.content) throw new Error("content is required");
            return writeResults(await zoho("Notes", { body: { data: [{ Note_Title: a.title ?? "", Note_Content: a.content, Parent_Id: { module: { api_name: module }, id: need() } }] } }));
          case "related": {
            if (!a.related_list) throw new Error("related_list is required");
            const relModule = await moduleName(a.related_list);
            const f = a.fields?.length ? await fieldList(relModule, a.fields) : await fieldList(relModule).catch(() => "id");
            const res = await zoho<Page>(`${module}/${need()}/${a.related_list}`, { query: { fields: f, per_page: a.limit } });
            return { related_list: a.related_list, count: res.data?.length ?? 0, records: (res.data ?? []).map(compact) };
          }
          case "attachments": {
            const res = await zoho<Page>(`${module}/${need()}/Attachments`, { query: { fields: "id,File_Name,Size,Created_Time,Owner", per_page: a.limit } });
            return (res.data ?? []).map(compact);
          }
          case "attach_file": {
            if (!a.file_path) throw new Error("file_path is required");
            const form = new FormData();
            form.append("file", new Blob([await readFile(a.file_path)]), basename(a.file_path));
            return writeResults(await zoho(`${module}/${need()}/Attachments`, { method: "POST", raw: form }));
          }
          case "add_tags":
          case "remove_tags": {
            const ids = a.ids ?? (a.id ? [a.id] : []);
            if (!ids.length || !a.tags?.length) throw new Error("ids and tags are required");
            return zoho(`${module}/actions/${a.action}`, { method: "POST", body: { tags: a.tags.map((name) => ({ name })), ids } });
          }
          case "timeline": {
            const res = await zoho<{ __timeline?: Rec[] }>(`${module}/${need()}/__timeline`, { query: { per_page: a.limit, sort_by: "audited_time" } });
            return (res.__timeline ?? []).map((t) => ({
              at: t.audited_time,
              action: t.action,
              by: (t.done_by as { name?: string })?.name,
              source: t.source,
              changes: (t.field_history as { api_name?: string; _value?: { old?: unknown; new?: unknown } }[] | undefined)?.map((f) => ({ field: f.api_name, from: f._value?.old, to: f._value?.new })),
            }));
          }
        }
      }),
  );

  server.registerTool(
    "zoho_crm_convert_lead",
    {
      title: "Convert lead",
      description: "Convert a lead into a Contact + Account (or attach to existing ones), optionally creating a Deal (name, stage, amount, closing date, pipeline) and assigning an owner.",
      inputSchema: {
        lead_id: z.string(),
        account_id: z.string().optional().describe("Attach to this existing Account"),
        contact_id: z.string().optional().describe("Merge into this existing Contact"),
        owner: z.string().optional().describe("Name, email or \"me\""),
        deal: z
          .object({ name: z.string(), stage: z.string().default("Qualification"), amount: z.number().optional(), closing_date: z.string().optional(), pipeline: z.string().optional() })
          .optional(),
        overwrite: z.boolean().default(false),
        notify: z.boolean().default(false),
      },
    },
    (a) =>
      run(async () => {
        const row: Rec = { overwrite: a.overwrite, notify_lead_owner: a.notify, notify_new_entity_owner: a.notify };
        if (a.account_id) row.Accounts = { id: a.account_id };
        if (a.contact_id) row.Contacts = { id: a.contact_id };
        if (a.owner) row.assign_to = { id: await userId(a.owner) };
        if (a.deal) row.Deals = { Deal_Name: a.deal.name, Stage: a.deal.stage, Amount: a.deal.amount, Closing_Date: day(a.deal.closing_date ?? "+30d"), Pipeline: a.deal.pipeline };
        const res = await zoho<{ data?: { details?: Rec; code?: string; message?: string }[] }>(`Leads/${a.lead_id}/actions/convert`, { body: { data: [row] } });
        const r = res.data?.[0];
        return r?.details ? { converted: true, ...r.details } : r;
      }),
  );
}
