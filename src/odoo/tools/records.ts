import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { compact, fieldsOf, odoo, resolveVals, schema, toDomain } from "../client.js";

type Rec = Record<string, unknown>;

const csvCell = (v: unknown) => {
  const s = Array.isArray(v) && v.length === 2 && typeof v[1] === "string" ? v[1] : Array.isArray(v) ? v.join(";") : v === false || v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Default fields: stored, readable, non-binary, skipping noisy technical ones. */
async function defaultFields(model: string): Promise<string[]> {
  const f = await fieldsOf(model);
  const skip = /^(message_|activity_|website_message|__|access_|create_uid|write_uid|write_date|display_name$)/;
  const names = Object.entries(f)
    .filter(([n, x]) => x.store !== false && !["binary", "one2many", "html"].includes(x.type) && !skip.test(n))
    .map(([n]) => n);
  return ["id", "name", "display_name", ...names.filter((n) => !["id", "name"].includes(n))].filter((n) => f[n] || n === "id").slice(0, 25);
}

export function registerRecordTools(server: McpServer): void {
  server.registerTool(
    "odoo_call",
    {
      title: "Call any model method",
      description:
        "Run ANY method on any Odoo model with named parameters — e.g. crm.lead action_set_won on ids, sale.order action_confirm, account.move action_post, res.partner name_search, stock.picking button_validate, ir.actions.report. Works on Odoo 19+ (JSON-2) and older versions (JSON-RPC).",
      inputSchema: {
        model: schema.model,
        method: z.string(),
        ids: z.array(z.number().int()).optional().describe("Records to run the method on (omit for model-level methods)"),
        params: z.record(z.unknown()).optional().describe("Named arguments, e.g. {\"domain\": [...], \"fields\": [...]} or {\"vals_list\": [{...}]}"),
        context: z.record(z.unknown()).optional(),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        if (/^(unlink|action_cancel|button_cancel|action_archive)$/.test(a.method) && !a.confirm) throw new Error(`${a.method} changes or removes data; set confirm: true`);
        return odoo(a.model, a.method, { ...a.params, context: a.context }, a.ids);
      }),
  );

  server.registerTool(
    "odoo_records",
    {
      title: "Search, read, create, update, delete",
      description:
        "Generic CRUD on any model: search (domain or simple conditions, fields, order, limit, offset, archived too), read by ids, count, group (counts and sums per field value, e.g. sale.order by user_id summing amount_total), create (many at once; relations by name, tags created if missing, selections by label, dates like tomorrow), update ids, archive/unarchive, delete (confirm), export_csv (to a local file).",
      inputSchema: {
        action: z.enum(["search", "read", "count", "group", "create", "update", "archive", "unarchive", "delete", "export_csv"]),
        model: schema.model,
        where: schema.where,
        ids: z.array(z.number().int()).optional(),
        fields: schema.fields,
        order: z.string().optional().describe("e.g. \"create_date desc\""),
        limit: z.number().int().min(1).max(20000).default(80),
        offset: z.number().int().min(0).default(0),
        include_archived: z.boolean().default(false),
        values: z.union([z.record(z.unknown()), z.array(z.record(z.unknown()))]).optional().describe("create: one or many records; update: the fields to set"),
        group_by: z.string().optional().describe("group: field name (many2one, selection, char, date)"),
        sum: z.array(z.string()).optional().describe("group: numeric fields to total"),
        file_path: z.string().optional().describe("export_csv: where to write (default ./exports/<model>.csv)"),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const domain = toDomain(a.where);
        const context = a.include_archived ? { active_test: false } : undefined;
        switch (a.action) {
          case "search": {
            const fields = a.fields ?? (await defaultFields(a.model));
            const rows = await odoo<Rec[]>(a.model, "search_read", { domain, fields, order: a.order, limit: a.limit, offset: a.offset, context });
            const total = rows.length === a.limit ? await odoo<number>(a.model, "search_count", { domain, context }) : a.offset + rows.length;
            return { model: a.model, total, returned: rows.length, records: rows.map(compact) };
          }
          case "read":
            if (!a.ids?.length) throw new Error("ids is required");
            return (await odoo<Rec[]>(a.model, "read", { fields: a.fields ?? (await defaultFields(a.model)), context }, a.ids)).map(compact);
          case "count":
            return { model: a.model, count: await odoo<number>(a.model, "search_count", { domain, context }) };
          case "group": {
            if (!a.group_by) throw new Error("group_by is required");
            const rows = await odoo<Rec[]>(a.model, "search_read", { domain, fields: [a.group_by, ...(a.sum ?? [])], limit: 20000, context });
            const groups = new Map<string, Rec & { count: number }>();
            for (const r of rows) {
              const v = r[a.group_by];
              const key = Array.isArray(v) ? String(v[1]) : v === false ? "(none)" : String(v);
              const g = groups.get(key) ?? { [a.group_by]: key, count: 0 };
              g.count++;
              for (const s of a.sum ?? []) g[s] = Math.round(((Number(g[s]) || 0) + (Number(r[s]) || 0)) * 100) / 100;
              groups.set(key, g);
            }
            return { model: a.model, records: rows.length, groups: [...groups.values()].sort((x, y) => y.count - x.count) };
          }
          case "create": {
            const list = Array.isArray(a.values) ? a.values : a.values ? [a.values] : [];
            if (!list.length) throw new Error("values is required");
            const vals = await Promise.all(list.map((v) => resolveVals(a.model, v)));
            const ids = await odoo<number[] | number>(a.model, "create", { vals_list: vals });
            return { created: Array.isArray(ids) ? ids : [ids] };
          }
          case "update": {
            if (!a.ids?.length || !a.values || Array.isArray(a.values)) throw new Error("ids and values (one object) are required");
            await odoo(a.model, "write", { vals: await resolveVals(a.model, a.values) }, a.ids);
            return { updated: a.ids };
          }
          case "archive":
          case "unarchive":
            if (!a.ids?.length) throw new Error("ids is required");
            await odoo(a.model, "write", { vals: { active: a.action === "unarchive" } }, a.ids);
            return { [a.action === "archive" ? "archived" : "restored"]: a.ids };
          case "delete":
            if (!a.ids?.length) throw new Error("ids is required");
            if (!a.confirm) throw new Error(`Deleting ${a.ids.length} ${a.model} record(s) is permanent — prefer archive; set confirm: true to delete`);
            await odoo(a.model, "unlink", {}, a.ids);
            return { deleted: a.ids };
          case "export_csv": {
            const fields = a.fields ?? (await defaultFields(a.model));
            const rows: Rec[] = [];
            for (let offset = 0; ; offset += 2000) {
              const page = await odoo<Rec[]>(a.model, "search_read", { domain, fields, order: a.order ?? "id", limit: 2000, offset, context });
              rows.push(...page);
              if (page.length < 2000 || rows.length >= 200000) break;
            }
            const cols = ["id", ...fields.filter((f) => f !== "id")];
            const path = resolve(a.file_path ?? `./exports/${a.model.replace(/\./g, "_")}.csv`);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n"));
            return { saved: path, rows: rows.length, columns: cols };
          }
        }
      }),
  );

  server.registerTool(
    "odoo_models",
    {
      title: "Models, fields & apps",
      description:
        "Learn the database: find models by name (\"lead\", \"invoice\"), list a model's fields with types, relations, required flags and selection values, list installed apps, and the stages/tags/teams/lost reasons available in CRM.",
      inputSchema: {
        what: z.enum(["models", "fields", "apps", "crm_setup"]),
        model: schema.model.optional(),
        search: z.string().optional(),
      },
    },
    (a) =>
      run(async () => {
        switch (a.what) {
          case "models":
            return odoo("ir.model", "search_read", { domain: a.search ? ["|", ["model", "ilike", a.search], ["name", "ilike", a.search]] : [["transient", "=", false]], fields: ["model", "name"], limit: 200, order: "model" });
          case "fields": {
            if (!a.model) throw new Error("model is required");
            const f = await fieldsOf(a.model);
            return Object.entries(f)
              .filter(([n]) => !a.search || n.includes(a.search) || f[n].string.toLowerCase().includes(a.search.toLowerCase()))
              .map(([name, x]) => ({ name, label: x.string, type: x.type, relation: x.relation, required: x.required || undefined, readonly: x.readonly || undefined, stored: x.store, options: x.selection?.map(([k, l]) => `${k}=${l}`) }));
          }
          case "apps":
            return (await odoo<Rec[]>("ir.module.module", "search_read", { domain: [["state", "=", "installed"], ["application", "=", true]], fields: ["name", "shortdesc", "latest_version"], order: "shortdesc" })).map((m) => ({ technical: m.name, name: m.shortdesc, version: m.latest_version }));
          case "crm_setup": {
            const [stages, teams, tags, reasons] = await Promise.all([
              odoo<Rec[]>("crm.stage", "search_read", { fields: ["name", "sequence", "is_won"], order: "sequence" }),
              odoo<Rec[]>("crm.team", "search_read", { fields: ["name", "user_id", "member_ids"] }),
              odoo<Rec[]>("crm.tag", "search_read", { fields: ["name"] }),
              odoo<Rec[]>("crm.lost.reason", "search_read", { fields: ["name"] }),
            ]);
            return { stages: stages.map(compact), teams: teams.map((t) => ({ id: t.id, name: t.name, leader: (t.user_id as [number, string])?.[1], members: (t.member_ids as number[])?.length })), tags: tags.map((t) => t.name), lost_reasons: reasons.map((r) => r.name) };
          }
        }
      }),
  );
}
