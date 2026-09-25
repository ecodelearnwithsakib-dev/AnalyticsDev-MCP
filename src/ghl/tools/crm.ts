import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { customFields, customFieldValues, dayDate, ghl, locationId, money, PERIOD, period, pipelines, schema, stage, userId, userName } from "../client.js";

type Rec = Record<string, unknown>;

const CONTACT = z
  .object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional().describe("E.164, e.g. +8801712345678"),
    companyName: z.string().optional(),
    website: z.string().optional(),
    address1: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional().describe("2-letter code, e.g. BD"),
    source: z.string().optional(),
    tags: z.array(z.string()).optional(),
    assignedTo: z.string().optional().describe("User name, email or id"),
    dnd: z.boolean().optional(),
    customFields: z.record(z.unknown()).optional().describe("By field name or key, e.g. {\"Budget\": 5000}"),
  })
  .passthrough();

async function contactBody(loc: string, c: z.infer<typeof CONTACT>): Promise<Rec> {
  const { customFields: cf, assignedTo, ...rest } = c;
  const body: Rec = { ...rest };
  if (assignedTo) body.assignedTo = await userId(loc, assignedTo);
  if (cf) body.customFields = await customFieldValues(loc, cf);
  return body;
}

/** Readable contact: custom field ids → names, owner id → name. */
async function readable(loc: string, c: Rec): Promise<Rec> {
  const fields = await customFields(loc).catch(() => []);
  const cf = (c.customFields as { id: string; value?: unknown }[] | undefined)?.map((f) => [fields.find((x) => x.id === f.id)?.name ?? f.id, f.value]);
  const out: Rec = {};
  for (const [k, v] of Object.entries(c)) if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length) && !["customFields", "locationId", "additionalEmails", "attributions"].includes(k)) out[k] = v;
  if (cf?.length) out.customFields = Object.fromEntries(cf);
  if (c.assignedTo) out.assignedTo = await userName(loc, c.assignedTo as string);
  return out;
}

export function registerCrmTools(server: McpServer): void {
  server.registerTool(
    "ghl_contacts",
    {
      title: "Contacts",
      description:
        "HighLevel contacts in a sub-account: search (text, tag, source, owner, date added, custom filters), get, create, update, upsert (dedupes by email/phone per your settings), delete (confirm), add/remove tags, notes (list/add), tasks (list/add/complete), add to or remove from a workflow, and find duplicates by email/phone. Custom fields by name; owner by name or email.",
      inputSchema: {
        action: z.enum(["search", "get", "create", "update", "upsert", "delete", "add_tags", "remove_tags", "notes", "add_note", "tasks", "add_task", "complete_task", "add_to_workflow", "remove_from_workflow", "duplicate"]),
        location_id: schema.location_id,
        id: z.string().optional().describe("Contact ID"),
        contact: CONTACT.optional(),
        query: z.string().optional().describe("search: free text (name, email, phone, company)"),
        tag: z.string().optional(),
        source: z.string().optional(),
        owner: z.string().optional(),
        added: PERIOD.describe("search: date added window"),
        filters: z.array(z.record(z.unknown())).optional().describe("search: raw filters, e.g. [{\"field\":\"tags\",\"operator\":\"contains\",\"value\":\"vip\"}]"),
        tags: z.array(z.string()).optional(),
        note: z.string().optional(),
        task: z.object({ title: z.string(), body: z.string().optional(), due: z.string().default("tomorrow"), assignedTo: z.string().optional() }).optional(),
        task_id: z.string().optional(),
        workflow_id: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        limit: z.number().int().min(1).max(10000).default(50),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const loc = locationId(a.location_id);
        const need = () => {
          if (!a.id) throw new Error("id (contact ID) is required");
          return a.id;
        };
        switch (a.action) {
          case "search": {
            const filters: Rec[] = [...(a.filters ?? [])];
            if (a.tag) filters.push({ field: "tags", operator: "contains", value: a.tag });
            if (a.source) filters.push({ field: "source", operator: "eq", value: a.source });
            if (a.owner) filters.push({ field: "assignedTo", operator: "eq", value: await userId(loc, a.owner) });
            if (a.added) {
              const p = period(a.added);
              filters.push({ field: "dateAdded", operator: "range", value: { gte: p.start.toISOString(), lte: p.end.toISOString() } });
            }
            const out: Rec[] = [];
            let total = 0;
            for (let page = 1; out.length < a.limit; page++) {
              const res = await ghl<{ contacts?: Rec[]; total?: number }>("/contacts/search", {
                body: { locationId: loc, page, pageLimit: Math.min(100, a.limit - out.length), query: a.query, filters: filters.length ? filters : undefined, sort: [{ field: "dateAdded", direction: "desc" }] },
              });
              total = res.total ?? total;
              out.push(...(res.contacts ?? []));
              if ((res.contacts?.length ?? 0) < 100 || out.length >= total) break;
            }
            return {
              total,
              returned: out.length,
              contacts: await Promise.all(out.map(async (c) => ({ id: c.id, name: [c.firstNameLowerCase ?? c.firstName, c.lastNameLowerCase ?? c.lastName].filter(Boolean).join(" ") || c.contactName, email: c.email, phone: c.phone, company: c.companyName, tags: c.tags, source: c.source, owner: await userName(loc, c.assignedTo as string), added: c.dateAdded }))),
            };
          }
          case "get": {
            const res = await ghl<{ contact: Rec }>(`/contacts/${need()}`);
            return readable(loc, res.contact);
          }
          case "create":
          case "upsert": {
            if (!a.contact) throw new Error("contact is required");
            const res = await ghl<{ contact?: Rec; new?: boolean }>(a.action === "upsert" ? "/contacts/upsert" : "/contacts/", { body: { locationId: loc, ...(await contactBody(loc, a.contact)) } });
            return { id: res.contact?.id, new: res.new ?? a.action === "create", name: res.contact?.contactName ?? res.contact?.firstName };
          }
          case "update": {
            if (!a.contact) throw new Error("contact is required");
            const res = await ghl<{ contact?: Rec }>(`/contacts/${need()}`, { method: "PUT", body: await contactBody(loc, a.contact) });
            return { updated: res.contact?.id ?? a.id };
          }
          case "delete":
            if (!a.confirm) throw new Error("Deleting a contact removes its conversations, notes and history; set confirm: true");
            await ghl(`/contacts/${need()}`, { method: "DELETE" });
            return { deleted: a.id };
          case "add_tags":
          case "remove_tags":
            if (!a.tags?.length) throw new Error("tags is required");
            await ghl(`/contacts/${need()}/tags`, { method: a.action === "add_tags" ? "POST" : "DELETE", body: { tags: a.tags } });
            return { [a.action === "add_tags" ? "tagged" : "untagged"]: a.id, tags: a.tags };
          case "notes":
            return ((await ghl<{ notes?: Rec[] }>(`/contacts/${need()}/notes`)).notes ?? []).map((n) => ({ id: n.id, body: n.body, added: n.dateAdded, by: n.userId }));
          case "add_note":
            if (!a.note) throw new Error("note is required");
            return (await ghl<{ note?: Rec }>(`/contacts/${need()}/notes`, { body: { body: a.note } })).note;
          case "tasks":
            return ((await ghl<{ tasks?: Rec[] }>(`/contacts/${need()}/tasks`)).tasks ?? []).map((t) => ({ id: t.id, title: t.title, due: t.dueDate, completed: t.completed, assignedTo: t.assignedTo }));
          case "add_task": {
            if (!a.task) throw new Error("task is required");
            const due = dayDate(a.task.due);
            due.setHours(9, 0, 0);
            return (await ghl<{ task?: Rec }>(`/contacts/${need()}/tasks`, { body: { title: a.task.title, body: a.task.body, dueDate: due.toISOString(), completed: false, assignedTo: a.task.assignedTo ? await userId(loc, a.task.assignedTo) : undefined } })).task;
          }
          case "complete_task":
            if (!a.task_id) throw new Error("task_id is required");
            return ghl(`/contacts/${need()}/tasks/${a.task_id}/completed`, { method: "PUT", body: { completed: true } });
          case "add_to_workflow":
          case "remove_from_workflow":
            if (!a.workflow_id) throw new Error("workflow_id is required (see ghl_automation what=workflows)");
            await ghl(`/contacts/${need()}/workflow/${a.workflow_id}`, { method: a.action === "add_to_workflow" ? "POST" : "DELETE", body: {} });
            return { [a.action === "add_to_workflow" ? "enrolled" : "removed"]: a.id, workflow: a.workflow_id };
          case "duplicate": {
            const res = await ghl<{ contact?: Rec }>("/contacts/search/duplicate", { query: { locationId: loc, email: a.email, number: a.phone } });
            return res.contact ? { duplicate: true, contact: await readable(loc, res.contact) } : { duplicate: false };
          }
        }
      }),
  );

  server.registerTool(
    "ghl_opportunities",
    {
      title: "Pipelines & opportunities",
      description:
        "Deals: list pipelines and stages, search opportunities (pipeline, stage, status open/won/lost/abandoned, owner, contact, text), get, create (pipeline and stage by name, value, owner, contact), update, move stage, set status won/lost/abandoned/open, delete (confirm), and a pipeline report (open value by stage, won/lost counts and value, win rate, per owner).",
      inputSchema: {
        action: z.enum(["pipelines", "search", "get", "create", "update", "move", "status", "delete", "report"]),
        location_id: schema.location_id,
        id: z.string().optional(),
        pipeline: z.string().optional().describe("Pipeline name or id"),
        stage: z.string().optional().describe("Stage name or id"),
        status: z.enum(["open", "won", "lost", "abandoned", "all"]).optional(),
        owner: z.string().optional(),
        contact_id: z.string().optional(),
        query: z.string().optional(),
        name: z.string().optional(),
        value: z.number().optional().describe("Monetary value"),
        source: z.string().optional(),
        limit: z.number().int().min(1).max(5000).default(50),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const loc = locationId(a.location_id);
        const search = async (max: number, extra: Rec = {}) => {
          const st = a.pipeline || a.stage ? await stage(loc, a.pipeline, a.stage) : {};
          const out: Rec[] = [];
          for (let page = 1; out.length < max; page++) {
            const res = await ghl<{ opportunities?: Rec[]; meta?: { total?: number } }>("/opportunities/search", {
              query: { location_id: loc, pipeline_id: st.pipelineId, pipeline_stage_id: st.stageId, status: a.status ?? "all", assigned_to: a.owner ? await userId(loc, a.owner) : undefined, contact_id: a.contact_id, q: a.query, limit: Math.min(100, max - out.length), page, ...extra },
            });
            out.push(...(res.opportunities ?? []));
            if ((res.opportunities?.length ?? 0) < 100 || out.length >= (res.meta?.total ?? Infinity)) break;
          }
          return out;
        };
        const stageName = async (o: Rec) => (await pipelines(loc)).flatMap((p) => p.stages.map((s) => ({ ...s, pipeline: p.name }))).find((s) => s.id === o.pipelineStageId);
        const brief = async (o: Rec) => {
          const s = await stageName(o);
          return { id: o.id, name: o.name, value: o.monetaryValue, status: o.status, pipeline: s?.pipeline, stage: s?.name, contact: (o.contact as Rec)?.name ?? o.contactId, owner: await userName(loc, o.assignedTo as string), updated: o.updatedAt, source: o.source || undefined };
        };
        switch (a.action) {
          case "pipelines":
            return (await pipelines(loc)).map((p) => ({ id: p.id, name: p.name, stages: p.stages.map((s) => ({ id: s.id, name: s.name })) }));
          case "search": {
            const rows = await search(a.limit);
            return { count: rows.length, value: money(rows.reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0)), opportunities: await Promise.all(rows.map(brief)) };
          }
          case "get": {
            if (!a.id) throw new Error("id is required");
            const o = (await ghl<{ opportunity: Rec }>(`/opportunities/${a.id}`)).opportunity;
            return { ...(await brief(o)), raw: o };
          }
          case "create": {
            if (!a.name || !a.contact_id) throw new Error("name and contact_id are required");
            const st = await stage(loc, a.pipeline, a.stage ?? (await stage(loc, a.pipeline)).pipeline?.stages[0]?.id);
            const res = await ghl<{ opportunity?: Rec }>("/opportunities/", {
              body: { locationId: loc, pipelineId: st.pipelineId, pipelineStageId: st.stageId, name: a.name, status: "open", contactId: a.contact_id, monetaryValue: a.value, assignedTo: a.owner ? await userId(loc, a.owner) : undefined, source: a.source },
            });
            return { created: res.opportunity?.id, pipeline: st.pipeline?.name, stage: a.stage };
          }
          case "update":
          case "move": {
            if (!a.id) throw new Error("id is required");
            const body: Rec = {};
            if (a.stage || a.pipeline) {
              const st = await stage(loc, a.pipeline, a.stage);
              Object.assign(body, { pipelineId: st.pipelineId, pipelineStageId: st.stageId });
            }
            if (a.name) body.name = a.name;
            if (a.value !== undefined) body.monetaryValue = a.value;
            if (a.owner) body.assignedTo = await userId(loc, a.owner);
            if (a.status && a.status !== "all") body.status = a.status;
            await ghl(`/opportunities/${a.id}`, { method: "PUT", body });
            return { updated: a.id, ...body };
          }
          case "status":
            if (!a.id || !a.status || a.status === "all") throw new Error("id and status (open/won/lost/abandoned) are required");
            await ghl(`/opportunities/${a.id}/status`, { method: "PUT", body: { status: a.status } });
            return { id: a.id, status: a.status };
          case "delete":
            if (!a.id) throw new Error("id is required");
            if (!a.confirm) throw new Error("Deleting an opportunity is permanent; set confirm: true (or mark it lost/abandoned instead)");
            await ghl(`/opportunities/${a.id}`, { method: "DELETE" });
            return { deleted: a.id };
          case "report": {
            const rows = await search(5000);
            const byStage = new Map<string, { stage: string; pipeline?: string; open: number; value: number }>();
            const owners = new Map<string, { owner: string; open: number; open_value: number; won: number; won_value: number; lost: number }>();
            let won = 0, wonV = 0, lost = 0, abandoned = 0;
            for (const o of rows) {
              const v = Number(o.monetaryValue) || 0;
              const oid = (o.assignedTo as string) ?? "(unassigned)";
              const ow = owners.get(oid) ?? { owner: oid, open: 0, open_value: 0, won: 0, won_value: 0, lost: 0 };
              if (o.status === "open") {
                const s = await stageName(o);
                const key = s?.id ?? "?";
                const t = byStage.get(key) ?? { stage: s?.name ?? "?", pipeline: s?.pipeline, open: 0, value: 0 };
                t.open++;
                t.value += v;
                byStage.set(key, t);
                ow.open++;
                ow.open_value += v;
              } else if (o.status === "won") (won++, (wonV += v), ow.won++, (ow.won_value += v));
              else if (o.status === "lost") (lost++, ow.lost++);
              else abandoned++;
              owners.set(oid, ow);
            }
            for (const o of owners.values()) o.owner = (await userName(loc, o.owner === "(unassigned)" ? undefined : o.owner)) ?? "(unassigned)";
            const open = [...byStage.values()];
            return {
              scope: { pipeline: a.pipeline ?? "all", owner: a.owner },
              open: { count: open.reduce((s, x) => s + x.open, 0), value: money(open.reduce((s, x) => s + x.value, 0)), by_stage: open.map((x) => ({ ...x, value: money(x.value) })) },
              won: { count: won, value: money(wonV) },
              lost,
              abandoned,
              win_rate_pct: won + lost ? Math.round((won / (won + lost)) * 1000) / 10 : null,
              by_owner: [...owners.values()].map((x) => ({ ...x, open_value: money(x.open_value), won_value: money(x.won_value) })).sort((x, y) => y.won_value - x.won_value),
            };
          }
        }
      }),
  );
}
