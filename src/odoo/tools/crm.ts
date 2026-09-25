import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { compact, day, existing, idByName, odoo, PERIOD, period, resolveVals, schema, userId, ymd, type Domain } from "../client.js";

type Rec = Record<string, unknown>;
const LEAD_FIELDS = ["name", "type", "partner_id", "partner_name", "contact_name", "email_from", "phone", "stage_id", "user_id", "team_id", "tag_ids", "expected_revenue", "probability", "date_deadline", "priority", "source_id", "activity_date_deadline", "create_date", "active"];
const m2o = (v: unknown) => (Array.isArray(v) ? (v[1] as string) : undefined);
const money = (n: number) => Math.round(n * 100) / 100;
const first = (ids: number[] | number) => (Array.isArray(ids) ? ids[0] : ids);
const strip = (html?: unknown) => (typeof html === "string" ? html.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim() : html);

/** Replace tag ids with names in lead rows. */
async function withTags(rows: Rec[]): Promise<Rec[]> {
  const ids = [...new Set(rows.flatMap((r) => (Array.isArray(r.tag_ids) ? (r.tag_ids as number[]) : [])))];
  if (!ids.length) return rows;
  const names = new Map((await odoo<Rec[]>("crm.tag", "read", { fields: ["name"] }, ids)).map((t) => [t.id as number, t.name as string]));
  return rows.map((r) => (Array.isArray(r.tag_ids) ? { ...r, tag_ids: (r.tag_ids as number[]).map((i) => names.get(i) ?? i) } : r));
}

/** Wizards (convert, merge) need the active records in the context. */
async function wizard(model: string, vals: Rec, method: string, active: number[]) {
  const context = { active_model: "crm.lead", active_id: active[0], active_ids: active };
  const created = await odoo<number[] | number>(model, "create", { vals_list: [vals], context });
  const id = Array.isArray(created) ? created[0] : created;
  return odoo(model, method, { context }, [id]);
}

export function registerCrmTools(server: McpServer): void {
  server.registerTool(
    "odoo_crm_leads",
    {
      title: "CRM leads & opportunities",
      description:
        "Work the CRM: list leads/opportunities (open, won or lost; by stage, salesperson, team, tag, text, created period), create (customer by name/email linked or created, expected revenue, probability, closing date, tags created if missing, salesperson), update, move to a stage, mark won, mark lost with a reason, restore, convert a lead into an opportunity, find duplicates, merge duplicates (confirm).",
      inputSchema: {
        action: z.enum(["list", "get", "create", "update", "set_stage", "won", "lost", "restore", "convert", "duplicates", "merge"]),
        ids: z.array(z.number().int()).optional(),
        type: z.enum(["lead", "opportunity", "any"]).default("any"),
        status: z.enum(["open", "won", "lost", "all"]).default("open"),
        stage: z.string().optional(),
        salesperson: z.string().optional().describe("Name, email/login or \"me\""),
        team: z.string().optional(),
        tag: z.string().optional(),
        text: z.string().optional().describe("Search in title, contact, company and email"),
        created: PERIOD,
        where: schema.where.describe("Extra domain conditions"),
        values: z.record(z.unknown()).optional().describe("create/update: crm.lead fields, e.g. {name, partner_name, contact_name, email_from, phone, expected_revenue, probability, date_deadline, tag_ids: [\"Facebook\"], user_id: \"Rahima\", description}"),
        customer: z.string().optional().describe("create/convert: existing customer name or email to link"),
        create_customer: z.boolean().default(false).describe("create/convert: create the customer if not found"),
        lost_reason: z.string().optional(),
        limit: z.number().int().min(1).max(5000).default(50),
        order: z.string().default("create_date desc"),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const needIds = () => {
          if (!a.ids?.length) throw new Error("ids is required");
          return a.ids;
        };
        const partner = async (): Promise<number | undefined> => {
          if (!a.customer) return undefined;
          const found = await odoo<number[]>("res.partner", "search", { domain: ["|", ["email", "=ilike", a.customer], ["name", "=ilike", a.customer]], limit: 1 });
          if (found[0]) return found[0];
          if (!a.create_customer) return idByName("res.partner", a.customer);
          const created = await odoo<number[] | number>("res.partner", "create", { vals_list: [a.customer.includes("@") ? { name: a.customer.split("@")[0], email: a.customer } : { name: a.customer }] });
          return Array.isArray(created) ? created[0] : created;
        };
        switch (a.action) {
          case "list": {
            const domain: Domain = [];
            if (a.type !== "any") domain.push(["type", "=", a.type]);
            if (a.status === "open") domain.push(["active", "=", true], ["stage_id.is_won", "=", false]);
            if (a.status === "won") domain.push(["stage_id.is_won", "=", true]);
            if (a.status === "lost") domain.push(["active", "=", false], ["probability", "=", 0]);
            if (a.stage) domain.push(["stage_id.name", "ilike", a.stage]);
            if (a.salesperson) domain.push(["user_id", "=", await userId(a.salesperson)]);
            if (a.team) domain.push(["team_id.name", "ilike", a.team]);
            if (a.tag) domain.push(["tag_ids.name", "ilike", a.tag]);
            if (a.text) domain.push("|", "|", "|", ["name", "ilike", a.text], ["contact_name", "ilike", a.text], ["partner_name", "ilike", a.text], ["email_from", "ilike", a.text]);
            if (a.created) {
              const p = period(a.created);
              domain.push(["create_date", ">=", `${p.from} 00:00:00`], ["create_date", "<=", `${p.to} 23:59:59`]);
            }
            if (Array.isArray(a.where)) domain.push(...a.where);
            else if (a.where) for (const [k, v] of Object.entries(a.where)) domain.push([k, Array.isArray(v) ? "in" : "=", v]);
            const context = a.status === "lost" || a.status === "all" ? { active_test: false } : undefined;
            const rows = await odoo<Rec[]>("crm.lead", "search_read", { domain, fields: LEAD_FIELDS, limit: a.limit, order: a.order, context });
            const total = await odoo<number>("crm.lead", "search_count", { domain, context });
            return { total, returned: rows.length, expected_revenue: money(rows.reduce((s, r) => s + (Number(r.expected_revenue) || 0), 0)), records: (await withTags(rows)).map(compact) };
          }
          case "get": {
            const [rec] = await odoo<Rec[]>("crm.lead", "read", { fields: await existing("crm.lead", [...LEAD_FIELDS, "description", "lost_reason_id", "date_closed", "campaign_id", "medium_id", "street", "city", "country_id", "website", "function", "mobile"]), context: { active_test: false } }, needIds().slice(0, 1));
            return { ...compact((await withTags([rec]))[0]), description: strip(rec?.description) };
          }
          case "create": {
            if (!a.values?.name) throw new Error("values.name (the lead title) is required");
            const vals = await resolveVals("crm.lead", { type: a.type === "any" ? "opportunity" : a.type, ...a.values });
            const pid = await partner();
            if (pid) vals.partner_id = pid;
            const ids = await odoo<number[] | number>("crm.lead", "create", { vals_list: [vals] });
            return { created: Array.isArray(ids) ? ids[0] : ids };
          }
          case "update":
            if (!a.values) throw new Error("values is required");
            await odoo("crm.lead", "write", { vals: await resolveVals("crm.lead", a.values) }, needIds());
            return { updated: a.ids };
          case "set_stage": {
            if (!a.stage) throw new Error("stage is required");
            const stageId = await idByName("crm.stage", a.stage);
            await odoo("crm.lead", "write", { vals: { stage_id: stageId } }, needIds());
            return { moved: a.ids, stage: a.stage };
          }
          case "won":
            await odoo("crm.lead", "action_set_won", {}, needIds());
            return { won: a.ids };
          case "lost": {
            const params: Rec = {};
            if (a.lost_reason) params.lost_reason_id = await idByName("crm.lost.reason", a.lost_reason);
            await odoo("crm.lead", "action_set_lost", params, needIds());
            return { lost: a.ids, reason: a.lost_reason };
          }
          case "restore":
            await odoo("crm.lead", "write", { vals: { active: true }, context: { active_test: false } }, needIds());
            return { restored: a.ids };
          case "convert": {
            // Same effect as the convert wizard, which changed shape across versions (single → mass-only in 20).
            const ids = needIds();
            let pid = await partner();
            if (!pid && a.create_customer) {
              const [lead] = await odoo<Rec[]>("crm.lead", "read", { fields: ["partner_name", "contact_name", "email_from", "phone"] }, ids.slice(0, 1));
              const company = lead.partner_name ? first(await odoo<number[] | number>("res.partner", "create", { vals_list: [{ name: lead.partner_name, is_company: true }] })) : undefined;
              pid = lead.contact_name || !company
                ? first(await odoo<number[] | number>("res.partner", "create", { vals_list: [{ name: lead.contact_name || lead.email_from || "Customer", email: lead.email_from || false, phone: lead.phone || false, parent_id: company ?? false }] }))
                : company;
            }
            const vals: Rec = { type: "opportunity" };
            if ((await existing("crm.lead", ["date_conversion"])).length) vals.date_conversion = new Date().toISOString().slice(0, 19).replace("T", " ");
            if (pid) vals.partner_id = pid;
            if (a.salesperson) vals.user_id = await userId(a.salesperson);
            if (a.team) vals.team_id = await idByName("crm.team", a.team);
            await odoo("crm.lead", "write", { vals }, ids);
            return { converted: ids, customer_id: pid };
          }
          case "duplicates": {
            const [rec] = await odoo<Rec[]>("crm.lead", "read", { fields: ["email_from", "phone", "partner_id", "partner_name"] }, needIds().slice(0, 1));
            const ors: Domain[] = [];
            if (rec.email_from) ors.push(["email_from", "=ilike", rec.email_from]);
            if (rec.phone) ors.push(["phone", "=", rec.phone]);
            if (Array.isArray(rec.partner_id)) ors.push(["partner_id", "=", rec.partner_id[0]]);
            if (rec.partner_name) ors.push(["partner_name", "=ilike", rec.partner_name]);
            if (!ors.length) return { duplicates: [] };
            const domain: Domain = [["id", "!=", a.ids![0]], ...Array(ors.length - 1).fill("|"), ...ors];
            return { duplicates: (await withTags(await odoo<Rec[]>("crm.lead", "search_read", { domain, fields: LEAD_FIELDS, limit: 50, context: { active_test: false } }))).map(compact) };
          }
          case "merge": {
            if (needIds().length < 2) throw new Error("Give at least two ids to merge");
            if (!a.confirm) throw new Error(`Merging ${a.ids!.length} records into one keeps the oldest and deletes the others; set confirm: true`);
            const vals: Rec = { opportunity_ids: [[6, 0, a.ids]] };
            if (a.salesperson) vals.user_id = await userId(a.salesperson);
            return { merged: a.ids, result: await wizard("crm.merge.opportunity", vals, "action_merge", a.ids!) };
          }
        }
      }),
  );

  server.registerTool(
    "odoo_crm_pipeline",
    {
      title: "Pipeline & sales report",
      description:
        "CRM numbers: open pipeline by stage (count, expected and probability-weighted revenue) and by salesperson, won and lost in a period with win rate, lost reasons, new leads by source, opportunities past their expected closing date, and opportunities with no next activity.",
      inputSchema: {
        preset: PERIOD.describe("Window for won/lost/new, default this_month"),
        from: z.string().optional(),
        to: z.string().optional(),
        team: z.string().optional(),
        salesperson: z.string().optional(),
      },
    },
    (a) =>
      run(async () => {
        const p = period(a.preset, a.from, a.to);
        const scope: Domain = [];
        if (a.team) scope.push(["team_id.name", "ilike", a.team]);
        if (a.salesperson) scope.push(["user_id", "=", await userId(a.salesperson)]);
        const from = `${p.from} 00:00:00`;
        const to = `${p.to} 23:59:59`;
        const fields = ["name", "stage_id", "user_id", "expected_revenue", "probability", "date_deadline", "activity_date_deadline", "partner_id", "source_id", "lost_reason_id"];
        const [open, won, lost, fresh, stages] = await Promise.all([
          odoo<Rec[]>("crm.lead", "search_read", { domain: [...scope, ["type", "=", "opportunity"], ["active", "=", true], ["stage_id.is_won", "=", false]], fields, limit: 20000 }),
          odoo<Rec[]>("crm.lead", "search_read", { domain: [...scope, ["stage_id.is_won", "=", true], ["date_closed", ">=", from], ["date_closed", "<=", to]], fields, limit: 20000 }),
          odoo<Rec[]>("crm.lead", "search_read", { domain: [...scope, ["active", "=", false], ["probability", "=", 0], ["write_date", ">=", from], ["write_date", "<=", to]], fields, limit: 20000, context: { active_test: false } }),
          odoo<Rec[]>("crm.lead", "search_read", { domain: [...scope, ["create_date", ">=", from], ["create_date", "<=", to]], fields: ["source_id", "type"], limit: 20000, context: { active_test: false } }),
          odoo<Rec[]>("crm.stage", "search_read", { fields: ["name", "sequence"], order: "sequence" }),
        ]);
        const order = new Map(stages.map((s, i) => [s.name as string, i]));
        const tally = <T extends Rec>(rows: Rec[], key: (r: Rec) => string, init: () => T, add: (t: T, r: Rec) => void) => {
          const m = new Map<string, T>();
          for (const r of rows) {
            const k = key(r);
            const t = m.get(k) ?? init();
            add(t, r);
            m.set(k, t);
          }
          return m;
        };
        const byStage = tally(open, (r) => m2o(r.stage_id) ?? "(none)", () => ({ deals: 0, expected: 0, weighted: 0 }), (t, r) => {
          t.deals++;
          t.expected += Number(r.expected_revenue) || 0;
          t.weighted += ((Number(r.expected_revenue) || 0) * (Number(r.probability) || 0)) / 100;
        });
        const people = new Map<string, { salesperson: string; open: number; open_expected: number; won: number; won_revenue: number; lost: number }>();
        const person = (r: Rec) => {
          const n = m2o(r.user_id) ?? "(unassigned)";
          if (!people.has(n)) people.set(n, { salesperson: n, open: 0, open_expected: 0, won: 0, won_revenue: 0, lost: 0 });
          return people.get(n)!;
        };
        for (const r of open) (person(r).open++, (person(r).open_expected += Number(r.expected_revenue) || 0));
        for (const r of won) (person(r).won++, (person(r).won_revenue += Number(r.expected_revenue) || 0));
        for (const r of lost) person(r).lost++;
        const count = (rows: Rec[], f: string) => Object.fromEntries([...tally(rows, (r) => m2o(r[f]) ?? "(none)", () => ({ n: 0 }), (t) => t.n++)].sort((x, y) => y[1].n - x[1].n).map(([k, v]) => [k, v.n]));
        const today = ymd(new Date());
        return {
          window: p,
          open_pipeline: {
            deals: open.length,
            expected: money(open.reduce((s, r) => s + (Number(r.expected_revenue) || 0), 0)),
            weighted: money([...byStage.values()].reduce((s, x) => s + x.weighted, 0)),
            by_stage: [...byStage].sort((x, y) => (order.get(x[0]) ?? 99) - (order.get(y[0]) ?? 99)).map(([stage, v]) => ({ stage, deals: v.deals, expected: money(v.expected), weighted: money(v.weighted) })),
          },
          won: { deals: won.length, revenue: money(won.reduce((s, r) => s + (Number(r.expected_revenue) || 0), 0)) },
          lost: { deals: lost.length, reasons: count(lost, "lost_reason_id") },
          win_rate_pct: won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 1000) / 10 : null,
          by_salesperson: [...people.values()].map((x) => ({ ...x, open_expected: money(x.open_expected), won_revenue: money(x.won_revenue) })).sort((x, y) => y.won_revenue - x.won_revenue),
          new_in_window: { total: fresh.length, by_source: count(fresh, "source_id") },
          past_closing_date: open.filter((r) => r.date_deadline && String(r.date_deadline) < today).map((r) => ({ id: r.id, name: r.name, customer: m2o(r.partner_id), salesperson: m2o(r.user_id), expected: r.expected_revenue, closing: r.date_deadline, stage: m2o(r.stage_id) })),
          no_next_activity: open.filter((r) => !r.activity_date_deadline).length,
        };
      }),
  );

  server.registerTool(
    "odoo_activities",
    {
      title: "Activities & chatter",
      description:
        "Follow-ups on any record (leads, contacts, orders, invoices, tasks…): list activities (mine/someone's/all; overdue, today or upcoming), schedule one (Call, Meeting, Email, To-Do… with deadline and assignee), mark done with feedback, read a record's chatter history, log an internal note, or send a message to the record's followers/customer (confirm).",
      inputSchema: {
        action: z.enum(["list", "schedule", "done", "history", "note", "message"]),
        model: z.string().default("crm.lead"),
        id: z.number().int().optional().describe("The record (res_id)"),
        activity_ids: z.array(z.number().int()).optional(),
        user: z.string().optional().describe("list: whose (default me; \"all\" for everyone); schedule: assignee"),
        when: z.enum(["overdue", "today", "upcoming", "all"]).default("all"),
        type: z.string().default("To-Do").describe("Activity type name: Call, Meeting, Email, To-Do, Upload Document…"),
        summary: z.string().optional(),
        note: z.string().optional().describe("Activity note, feedback, chatter note or message body"),
        deadline: z.string().optional().describe("YYYY-MM-DD, today, tomorrow, +3d, friday"),
        limit: z.number().int().min(1).max(500).default(50),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const needId = () => {
          if (!a.id) throw new Error("id (the record) is required");
          return a.id;
        };
        switch (a.action) {
          case "list": {
            const domain: Domain = [];
            if (a.user !== "all") domain.push(["user_id", "=", await userId(a.user ?? "me")]);
            const today = ymd(new Date());
            if (a.when === "overdue") domain.push(["date_deadline", "<", today]);
            if (a.when === "today") domain.push(["date_deadline", "=", today]);
            if (a.when === "upcoming") domain.push(["date_deadline", ">", today]);
            if (a.id) domain.push(["res_model", "=", a.model], ["res_id", "=", a.id]);
            const rows = await odoo<Rec[]>("mail.activity", "search_read", { domain, fields: ["activity_type_id", "summary", "note", "date_deadline", "user_id", "res_model", "res_id", "res_name"], order: "date_deadline asc", limit: a.limit });
            return { count: rows.length, activities: rows.map((r) => ({ ...compact(r), note: strip(r.note) })) };
          }
          case "schedule": {
            const [modelId] = await odoo<number[]>("ir.model", "search", { domain: [["model", "=", a.model]], limit: 1 });
            if (!modelId) throw new Error(`Unknown model ${a.model}`);
            const vals: Rec = {
              res_model_id: modelId,
              res_id: needId(),
              activity_type_id: await idByName("mail.activity.type", a.type),
              summary: a.summary,
              note: a.note,
              date_deadline: day(a.deadline ?? "tomorrow"),
              user_id: await userId(a.user && a.user !== "all" ? a.user : "me"),
            };
            const ids = await odoo<number[] | number>("mail.activity", "create", { vals_list: [vals] });
            return { scheduled: Array.isArray(ids) ? ids[0] : ids, due: vals.date_deadline };
          }
          case "done":
            if (!a.activity_ids?.length) throw new Error("activity_ids is required");
            await odoo("mail.activity", "action_feedback", { feedback: a.note ?? "" }, a.activity_ids);
            return { done: a.activity_ids };
          case "history": {
            const rows = await odoo<Rec[]>("mail.message", "search_read", { domain: [["model", "=", a.model], ["res_id", "=", needId()]], fields: await existing("mail.message", ["date", "author_id", "body", "message_type", "subtype_id", "tracking_value_ids"]), order: "date desc", limit: a.limit });
            return rows.map((r) => ({ date: r.date, by: m2o(r.author_id), type: m2o(r.subtype_id) ?? r.message_type, text: strip(r.body) || undefined, field_changes: (r.tracking_value_ids as number[])?.length || undefined }));
          }
          case "note":
          case "message": {
            if (!a.note) throw new Error("note (the text) is required");
            if (a.action === "message" && !a.confirm) throw new Error("A message is emailed to the record's followers (often the customer); set confirm: true to send, or use note for an internal note");
            const id = await odoo(a.model, "message_post", { body: a.note, message_type: "comment", subtype_xmlid: a.action === "note" ? "mail.mt_note" : "mail.mt_comment" }, [needId()]);
            return { posted: Array.isArray(id) ? id[0] : id, kind: a.action };
          }
        }
      }),
  );
}
