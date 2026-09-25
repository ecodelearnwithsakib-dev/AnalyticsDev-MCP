import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { apiName, compact, dateTime, day, moduleName, schema, writeResults, ymd, zoho } from "../client.js";
import { userId, userName } from "../people.js";

type Rec = Record<string, unknown>;

/** Runs COQL, following LIMIT offset pages up to `max` rows. */
export async function coql(query: string, max = 2000): Promise<Rec[]> {
  const q = query.trim().replace(/;$/, "");
  if (/\blimit\b/i.test(q)) {
    const res = await zoho<{ data?: Rec[] }>("coql", { body: { select_query: q } });
    return res.data ?? [];
  }
  const out: Rec[] = [];
  for (let offset = 0; out.length < max; offset += 2000) {
    const res = await zoho<{ data?: Rec[]; info?: { more_records?: boolean } }>("coql", { body: { select_query: `${q} limit ${offset}, ${Math.min(2000, max - out.length)}` } });
    out.push(...(res.data ?? []));
    if (!res.info?.more_records) break;
  }
  return out;
}

const q = (s: string) => `'${s.replace(/'/g, "\\'")}'`;
const CLOSED = ["Closed Won", "Closed Lost", "Closed-Lost to Competition"];

function range(preset?: string, from?: string, to?: string) {
  if (from) return { from: day(from)!, to: day(to ?? "today")! };
  const now = new Date();
  const d = (y: number, m: number, dd: number) => ymd(new Date(y, m, dd));
  const y = now.getFullYear();
  const m = now.getMonth();
  const qStart = Math.floor(m / 3) * 3;
  switch (preset ?? "this_month") {
    case "last_month":
      return { from: d(y, m - 1, 1), to: d(y, m, 0) };
    case "this_quarter":
      return { from: d(y, qStart, 1), to: d(y, qStart + 3, 0) };
    case "last_quarter":
      return { from: d(y, qStart - 3, 1), to: d(y, qStart, 0) };
    case "this_year":
      return { from: d(y, 0, 1), to: d(y, 11, 31) };
    case "last_30_days":
      return { from: d(y, m, now.getDate() - 29), to: d(y, m, now.getDate()) };
    case "last_90_days":
      return { from: d(y, m, now.getDate() - 89), to: d(y, m, now.getDate()) };
    default:
      return { from: d(y, m, 1), to: d(y, m + 1, 0) };
  }
}
const PRESET = z.enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_30_days", "last_90_days"]).optional();

const num = (v: unknown) => Number(v ?? 0) || 0;
const ownerId = (r: Rec) => (r.Owner as { id?: string })?.id ?? (r["Owner.id"] as string);

export function registerInsightTools(server: McpServer): void {
  server.registerTool(
    "zoho_crm_query",
    {
      title: "COQL query",
      description:
        "Run a COQL (SQL-like) query: select fields from a module with where (required), joins through lookups (Account_Name.Industry, Owner.email), order by, group by with COUNT/SUM/AVG/MIN/MAX. Example: select Stage, SUM(Amount), COUNT(id) from Deals where Closing_Date between '2026-07-01' and '2026-09-30' group by Stage. Pages beyond 2,000 rows automatically (max_rows).",
      inputSchema: { query: z.string(), max_rows: z.number().int().min(1).max(100000).default(2000) },
    },
    (a) =>
      run(async () => {
        const rows = await coql(a.query, a.max_rows);
        return { count: rows.length, rows: rows.map(compact) };
      }),
  );

  server.registerTool(
    "zoho_crm_pipeline",
    {
      title: "Sales pipeline report",
      description:
        "Deals at a glance for a period: open pipeline by stage (count, amount, weighted by probability), won and lost (count, amount, win rate), per-owner totals, and deals past their closing date that are still open. Optional pipeline and owner filters.",
      inputSchema: {
        preset: PRESET.describe("Closing-date window, default this_month"),
        from: z.string().optional(),
        to: z.string().optional(),
        pipeline: z.string().optional(),
        owner: z.string().optional().describe("Name, email or \"me\""),
      },
    },
    (a) =>
      run(async () => {
        const r = range(a.preset, a.from, a.to);
        const extra = [a.pipeline ? `Pipeline = ${q(a.pipeline)}` : "", a.owner ? `Owner = ${q(await userId(a.owner))}` : ""].filter(Boolean).map((c) => ` and ${c}`).join("");
        const closedList = CLOSED.map(q).join(", ");
        const [inWindow, overdue] = await Promise.all([
          coql(`select Deal_Name, Stage, Amount, Probability, Owner, Closing_Date from Deals where Closing_Date between '${r.from}' and '${r.to}'${extra}`, 20000),
          coql(`select Deal_Name, Stage, Amount, Owner, Closing_Date, Account_Name from Deals where Closing_Date < '${ymd(new Date())}' and Stage not in (${closedList})${extra} order by Closing_Date desc`, 200),
        ]);
        const byStage = new Map<string, { stage: string; deals: number; amount: number; weighted: number }>();
        const byOwner = new Map<string, { owner: string; open: number; won: number; lost: number; won_amount: number }>();
        let won = 0, lost = 0, wonAmt = 0, lostAmt = 0;
        for (const d of inWindow) {
          const stage = String(d.Stage);
          const amount = num(d.Amount);
          const o = ownerId(d) ?? "unknown";
          const ow = byOwner.get(o) ?? { owner: o, open: 0, won: 0, lost: 0, won_amount: 0 };
          if (stage === "Closed Won") (won++, (wonAmt += amount), ow.won++, (ow.won_amount += amount));
          else if (stage.startsWith("Closed")) (lost++, (lostAmt += amount), ow.lost++);
          else {
            const s = byStage.get(stage) ?? { stage, deals: 0, amount: 0, weighted: 0 };
            s.deals++;
            s.amount += amount;
            s.weighted += (amount * num(d.Probability)) / 100;
            byStage.set(stage, s);
            ow.open++;
          }
          byOwner.set(o, ow);
        }
        for (const o of byOwner.values()) o.owner = (await userName(o.owner)) ?? o.owner;
        const open = [...byStage.values()];
        return {
          window: r,
          open_pipeline: { deals: open.reduce((s, x) => s + x.deals, 0), amount: open.reduce((s, x) => s + x.amount, 0), weighted: Math.round(open.reduce((s, x) => s + x.weighted, 0)), by_stage: open.sort((x, y) => y.amount - x.amount) },
          won: { deals: won, amount: wonAmt },
          lost: { deals: lost, amount: lostAmt },
          win_rate_pct: won + lost ? Math.round((won / (won + lost)) * 1000) / 10 : null,
          by_owner: [...byOwner.values()].sort((x, y) => y.won_amount - x.won_amount),
          overdue_open_deals: await Promise.all(overdue.map(async (d) => ({ ...compact(d), Owner: await userName(ownerId(d)) }))),
        };
      }),
  );

  server.registerTool(
    "zoho_crm_breakdown",
    {
      title: "Count / sum by any field",
      description:
        "Group any module by a field and count (or sum a number field): leads by Lead_Source or Lead_Status, contacts by Owner, deals by Type, cases by Priority — optionally only records created in a date window.",
      inputSchema: {
        module: schema.module,
        group_by: z.string().describe("Field label or API name"),
        sum_field: z.string().optional().describe("e.g. Amount"),
        preset: PRESET.describe("Created_Time window (omit for all time)"),
        from: z.string().optional(),
        to: z.string().optional(),
        where: z.string().optional().describe("Extra COQL condition, e.g. Lead_Status != 'Junk Lead'"),
      },
    },
    (a) =>
      run(async () => {
        const module = await moduleName(a.module);
        const g = await apiName(module, a.group_by);
        const s = a.sum_field ? await apiName(module, a.sum_field) : undefined;
        const conds: string[] = [];
        if (a.preset || a.from) {
          const r = range(a.preset, a.from, a.to);
          conds.push(`Created_Time between '${dateTime(`${r.from}T00:00:00`)}' and '${dateTime(`${r.to}T23:59:00`)}'`);
        }
        if (a.where) conds.push(`(${a.where})`);
        if (!conds.length) conds.push("id is not null");
        const rows = await coql(`select ${g}, COUNT(id)${s ? `, SUM(${s})` : ""} from ${module} where ${conds.join(" and ")} group by ${g}`, 2000);
        const out = await Promise.all(
          rows.map(async (r) => {
            let key = r[g] as unknown;
            if (key && typeof key === "object") key = (key as { name?: string; id?: string }).name ?? (g === "Owner" ? await userName((key as { id?: string }).id) : (key as { id?: string }).id);
            return { [g]: key ?? "(empty)", count: num(r["COUNT(id)"]), ...(s ? { [`sum_${s}`]: num(r[`SUM(${s})`]) } : {}) };
          }),
        );
        const total = out.reduce((t, x) => t + x.count, 0);
        return { module, group_by: g, total, rows: out.sort((x, y) => y.count - x.count).map((x) => ({ ...x, pct: total ? Math.round((x.count / total) * 1000) / 10 : 0 })) };
      }),
  );

  server.registerTool(
    "zoho_crm_activities",
    {
      title: "Tasks, calls & meetings",
      description:
        "Follow-ups: list open or overdue tasks and upcoming meetings (for you, someone, or everyone), create a task linked to a lead/contact/account/deal, log a call, schedule a meeting with participants, or mark tasks completed.",
      inputSchema: {
        action: z.enum(["overdue_tasks", "open_tasks", "upcoming_meetings", "create_task", "log_call", "create_meeting", "complete_tasks"]),
        owner: z.string().optional().describe("Filter/assign: name, email or \"me\" (lists default to everyone)"),
        related_module: z.string().optional().describe("Leads, Contacts, Accounts, Deals, …"),
        related_id: z.string().optional(),
        subject: z.string().optional(),
        due: z.string().optional().describe("Task due date: YYYY-MM-DD, today, tomorrow, +3d, friday"),
        priority: z.enum(["Highest", "High", "Normal", "Low", "Lowest"]).optional(),
        description: z.string().optional(),
        start: z.string().optional().describe("Call/meeting start: ISO datetime or +2h"),
        end: z.string().optional(),
        duration_minutes: z.number().int().min(0).default(5),
        call_type: z.enum(["Outbound", "Inbound", "Missed"]).default("Outbound"),
        participants: z.array(z.string()).optional().describe("Meeting attendee emails"),
        task_ids: z.array(z.string()).optional(),
        days: z.number().int().min(1).max(90).default(7).describe("upcoming_meetings window"),
      },
    },
    (a) =>
      run(async () => {
        const owner = a.owner ? await userId(a.owner) : undefined;
        const ownerCond = owner ? ` and Owner = '${owner}'` : "";
        const link = async (): Promise<Record<string, unknown>> => {
          if (!a.related_module || !a.related_id) return {};
          const m = await moduleName(a.related_module);
          return m === "Contacts" ? { Who_Id: { id: a.related_id } } : { What_Id: { id: a.related_id }, $se_module: m };
        };
        const withNames = (rows: Rec[]) => Promise.all(rows.map(async (r) => ({ ...compact(r), Owner: await userName(ownerId(r)) })));
        switch (a.action) {
          case "overdue_tasks":
          case "open_tasks": {
            const due = a.action === "overdue_tasks" ? ` and Due_Date < '${ymd(new Date())}'` : "";
            const rows = await coql(`select Subject, Due_Date, Status, Priority, Owner, What_Id, Who_Id from Tasks where Status != 'Completed'${due}${ownerCond} order by Due_Date asc`, 500);
            return { count: rows.length, tasks: await withNames(rows) };
          }
          case "upcoming_meetings": {
            const now = dateTime(new Date().toISOString());
            const until = dateTime(new Date(Date.now() + a.days * 86_400_000).toISOString());
            const rows = await coql(`select Event_Title, Start_DateTime, End_DateTime, Venue, Owner, What_Id, Who_Id from Events where Start_DateTime between '${now}' and '${until}'${ownerCond} order by Start_DateTime asc`, 500);
            return { count: rows.length, meetings: await withNames(rows) };
          }
          case "create_task":
            if (!a.subject) throw new Error("subject is required");
            return writeResults(await zoho("Tasks", { body: { data: [{ Subject: a.subject, Due_Date: day(a.due ?? "tomorrow"), Priority: a.priority ?? "Normal", Status: "Not Started", Description: a.description, Owner: owner ? { id: owner } : undefined, ...(await link()) }] } }));
          case "log_call": {
            const mins = a.duration_minutes;
            return writeResults(
              await zoho("Calls", {
                body: { data: [{ Subject: a.subject ?? `${a.call_type} call`, Call_Type: a.call_type, Call_Start_Time: dateTime(a.start ?? new Date().toISOString()), Call_Duration: `${String(Math.floor(mins)).padStart(2, "0")}:00`, Description: a.description, Owner: owner ? { id: owner } : undefined, ...(await link()) }] },
              }),
            );
          }
          case "create_meeting": {
            if (!a.subject || !a.start) throw new Error("subject and start are required");
            const start = dateTime(a.start);
            const end = a.end ? dateTime(a.end) : dateTime(new Date(new Date(start).getTime() + 30 * 60_000).toISOString());
            return writeResults(
              await zoho("Events", {
                body: { data: [{ Event_Title: a.subject, Start_DateTime: start, End_DateTime: end, Description: a.description, Participants: a.participants?.map((p) => ({ type: "email", participant: p })), Owner: owner ? { id: owner } : undefined, ...(await link()) }] },
              }),
            );
          }
          case "complete_tasks":
            if (!a.task_ids?.length) throw new Error("task_ids is required");
            return writeResults(await zoho("Tasks", { method: "PUT", body: { data: a.task_ids.map((id) => ({ id, Status: "Completed" })) } }));
        }
      }),
  );
}
