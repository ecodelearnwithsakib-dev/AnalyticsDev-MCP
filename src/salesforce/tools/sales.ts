import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { apiVersion, confirm, dateTime, day, describe, esc, flat, instanceUrl, me, money, PERIOD, sf, soql, toApi, userId, type Rec } from "../client.js";

const num = (v: unknown) => Number(v ?? 0) || 0;

export function registerSalesTools(server: McpServer): void {
  server.registerTool(
    "sf_pipeline",
    {
      title: "Opportunity pipeline report",
      description:
        "Sales numbers from Opportunities: open pipeline by stage (count, amount, expected revenue), closed won/lost in a period (count, amount, win rate, average deal), per-owner totals, opportunities past their close date, and open deals with no activity in N days. Filters: owner, record type, Type, lead source.",
      inputSchema: {
        period: PERIOD.describe("Close-date window for won/lost, default THIS_QUARTER"),
        owner: z.string().optional(),
        where: z.string().optional().describe("Extra SOQL condition, e.g. Type = 'New Business'"),
        stale_days: z.number().int().min(1).max(365).default(30),
      },
    },
    (a) =>
      run(async () => {
        const window = a.period ?? "THIS_QUARTER";
        const extra = [a.owner ? `OwnerId = '${await userId(a.owner)}'` : "", a.where ? `(${a.where})` : ""].filter(Boolean).map((c) => ` AND ${c}`).join("");
        const [byStage, closed, byOwner, overdue, stale] = await Promise.all([
          soql(`SELECT StageName, COUNT(Id) n, SUM(Amount) amount, SUM(ExpectedRevenue) expected FROM Opportunity WHERE IsClosed = false${extra} GROUP BY StageName`),
          soql(`SELECT IsWon, COUNT(Id) n, SUM(Amount) amount FROM Opportunity WHERE IsClosed = true AND CloseDate = ${window}${extra} GROUP BY IsWon`),
          soql(`SELECT Owner.Name owner, IsClosed, IsWon, COUNT(Id) n, SUM(Amount) amount FROM Opportunity WHERE (IsClosed = false OR CloseDate = ${window})${extra} GROUP BY Owner.Name, IsClosed, IsWon`),
          soql(`SELECT Id, Name, Account.Name, Owner.Name, StageName, Amount, CloseDate FROM Opportunity WHERE IsClosed = false AND CloseDate < TODAY${extra} ORDER BY CloseDate LIMIT 50`, 50),
          soql(`SELECT Id, Name, Account.Name, Owner.Name, StageName, Amount, LastActivityDate FROM Opportunity WHERE IsClosed = false AND (LastActivityDate < LAST_N_DAYS:${a.stale_days} OR LastActivityDate = null)${extra} ORDER BY Amount DESC NULLS LAST LIMIT 50`, 50),
        ]);
        const stages = await describe("Opportunity").then((d) => d.fields.find((f) => f.name === "StageName")?.picklistValues?.map((p) => p.value) ?? []).catch(() => [] as string[]);
        const won = closed.records.find((r) => r.IsWon === true);
        const lost = closed.records.find((r) => r.IsWon === false);
        const owners = new Map<string, Rec>();
        for (const r of byOwner.records) {
          const k = String(r.owner ?? "(none)");
          const o = (owners.get(k) ?? { owner: k, open: 0, open_amount: 0, won: 0, won_amount: 0, lost: 0 }) as Record<string, number | string>;
          if (!r.IsClosed) ((o.open = num(o.open) + num(r.n)), (o.open_amount = money(num(o.open_amount) + num(r.amount))));
          else if (r.IsWon) ((o.won = num(o.won) + num(r.n)), (o.won_amount = money(num(o.won_amount) + num(r.amount))));
          else o.lost = num(o.lost) + num(r.n);
          owners.set(k, o);
        }
        const open = byStage.records.map((r) => ({ stage: r.StageName, deals: num(r.n), amount: money(num(r.amount)), expected: money(num(r.expected)) })).sort((x, y) => stages.indexOf(String(x.stage)) - stages.indexOf(String(y.stage)));
        return {
          window,
          open_pipeline: { deals: open.reduce((s, x) => s + x.deals, 0), amount: money(open.reduce((s, x) => s + x.amount, 0)), expected: money(open.reduce((s, x) => s + x.expected, 0)), by_stage: open },
          won: { deals: num(won?.n), amount: money(num(won?.amount)), average: num(won?.n) ? money(num(won?.amount) / num(won?.n)) : 0 },
          lost: { deals: num(lost?.n), amount: money(num(lost?.amount)) },
          win_rate_pct: num(won?.n) + num(lost?.n) ? Math.round((num(won?.n) / (num(won?.n) + num(lost?.n))) * 1000) / 10 : null,
          by_owner: [...owners.values()].sort((x, y) => num(y.won_amount) - num(x.won_amount)),
          past_close_date: overdue.records.map((r) => flat(r)),
          no_recent_activity: stale.records.map((r) => flat(r)),
        };
      }),
  );

  server.registerTool(
    "sf_leads",
    {
      title: "Leads",
      description:
        "Lead work: list (status, source, owner, created period, unread/unassigned), breakdown by status/source/owner for a period with conversion rate, create (fields by label, picklists by label, owner by name), update status or owner in bulk, and convert a lead to Account + Contact (+ Opportunity) using the org's convertLead action.",
      inputSchema: {
        action: z.enum(["list", "breakdown", "create", "update", "convert"]),
        status: z.string().optional(),
        source: z.string().optional(),
        owner: z.string().optional(),
        created: PERIOD,
        text: z.string().optional().describe("Match name, company or email"),
        group_by: z.enum(["Status", "LeadSource", "Owner.Name", "Industry", "Rating"]).default("LeadSource"),
        ids: z.array(z.string()).optional(),
        values: z.record(z.unknown()).optional(),
        account_id: z.string().optional().describe("convert: attach to this existing Account"),
        create_opportunity: z.boolean().default(true),
        opportunity_name: z.string().optional(),
        converted_status: z.string().optional().describe("convert: a converted Lead Status (default: the org's converted status)"),
        limit: z.number().int().min(1).max(5000).default(100),
      },
    },
    (a) =>
      run(async () => {
        const conds: string[] = [];
        if (a.status) conds.push(`Status = '${esc(a.status)}'`);
        if (a.source) conds.push(`LeadSource = '${esc(a.source)}'`);
        if (a.owner) conds.push(`OwnerId = '${await userId(a.owner)}'`);
        if (a.created) conds.push(`CreatedDate = ${a.created}`);
        if (a.text) conds.push(`(Name LIKE '%${esc(a.text)}%' OR Company LIKE '%${esc(a.text)}%' OR Email LIKE '%${esc(a.text)}%')`);
        switch (a.action) {
          case "list": {
            const res = await soql(`SELECT Id, Name, Company, Email, Phone, Status, LeadSource, Rating, Owner.Name, CreatedDate, IsUnreadByOwner FROM Lead WHERE IsConverted = false${conds.map((c) => ` AND ${c}`).join("")} ORDER BY CreatedDate DESC LIMIT ${a.limit}`, a.limit);
            return { total: res.totalSize, leads: res.records.map((r) => flat(r)) };
          }
          case "breakdown": {
            const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
            const res = await soql(`SELECT ${a.group_by} g, COUNT(Id) n, COUNT_DISTINCT(ConvertedOpportunityId) opps FROM Lead${where} GROUP BY ${a.group_by} ORDER BY COUNT(Id) DESC`);
            const conv = await soql(`SELECT ${a.group_by} g, COUNT(Id) n FROM Lead WHERE IsConverted = true${conds.map((c) => ` AND ${c}`).join("")} GROUP BY ${a.group_by}`);
            return res.records.map((r) => {
              const c = num(conv.records.find((x) => x.g === r.g)?.n);
              return { [a.group_by]: r.g ?? "(none)", leads: num(r.n), converted: c, conversion_pct: num(r.n) ? Math.round((c / num(r.n)) * 1000) / 10 : 0, opportunities: num(r.opps) };
            });
          }
          case "create": {
            if (!a.values) throw new Error("values is required (LastName and Company at least)");
            return sf("sobjects/Lead", { body: await toApi("Lead", a.values) });
          }
          case "update": {
            if (!a.ids?.length || !a.values) throw new Error("ids and values are required");
            const vals = await toApi("Lead", a.values);
            return sf("composite/sobjects", { method: "PATCH", body: { allOrNone: false, records: a.ids.map((Id) => ({ attributes: { type: "Lead" }, Id, ...vals })) } });
          }
          case "convert": {
            if (!a.ids?.length) throw new Error("ids is required");
            const status = a.converted_status ?? String((await soql("SELECT MasterLabel FROM LeadStatus WHERE IsConverted = true LIMIT 1", 1)).records[0]?.MasterLabel ?? "Qualified");
            const inputs = a.ids.map((leadId) => ({ leadId, convertedStatus: status, accountId: a.account_id, createOpportunity: a.create_opportunity, opportunityName: a.opportunity_name, ownerId: undefined as string | undefined }));
            if (a.owner) {
              const o = await userId(a.owner);
              for (const i of inputs) i.ownerId = o;
            }
            return sf("actions/standard/convertLead", { body: { inputs } });
          }
        }
      }),
  );

  server.registerTool(
    "sf_activities",
    {
      title: "Tasks, calls & events",
      description:
        "Follow-ups: my (or someone's) open/overdue/today tasks, upcoming events, create a task linked to a lead/contact (WhoId) and/or account/opportunity/case (WhatId), log a completed call, schedule an event, and complete tasks.",
      inputSchema: {
        action: z.enum(["tasks", "overdue", "today", "events", "create_task", "log_call", "create_event", "complete"]),
        owner: z.string().optional().describe("Default me; \"all\" for everyone"),
        who_id: z.string().optional().describe("Lead or Contact Id"),
        what_id: z.string().optional().describe("Account, Opportunity, Case… Id"),
        subject: z.string().optional(),
        due: z.string().optional().describe("Task date: today, tomorrow, +3d, friday, YYYY-MM-DD"),
        start: z.string().optional().describe("Event start: ISO, tomorrow 3pm, +2h"),
        minutes: z.number().int().min(1).max(1440).default(30),
        priority: z.enum(["High", "Normal", "Low"]).default("Normal"),
        description: z.string().optional(),
        task_ids: z.array(z.string()).optional(),
        days: z.number().int().min(1).max(60).default(7),
        limit: z.number().int().min(1).max(2000).default(100),
      },
    },
    (a) =>
      run(async () => {
        const ownerCond = a.owner === "all" ? "" : ` AND OwnerId = '${await userId(a.owner ?? "me")}'`;
        const ownerId = a.owner && a.owner !== "all" ? await userId(a.owner) : undefined;
        const links = { WhoId: a.who_id, WhatId: a.what_id };
        switch (a.action) {
          case "tasks":
          case "overdue":
          case "today": {
            const when = a.action === "overdue" ? " AND ActivityDate < TODAY" : a.action === "today" ? " AND ActivityDate = TODAY" : "";
            const res = await soql(`SELECT Id, Subject, ActivityDate, Status, Priority, Who.Name, What.Name, Owner.Name FROM Task WHERE IsClosed = false${when}${ownerCond} ORDER BY ActivityDate ASC NULLS LAST LIMIT ${a.limit}`, a.limit);
            return { count: res.totalSize, tasks: res.records.map((r) => flat(r)) };
          }
          case "events": {
            const res = await soql(`SELECT Id, Subject, StartDateTime, EndDateTime, Location, Who.Name, What.Name, Owner.Name FROM Event WHERE (StartDateTime = TODAY OR StartDateTime = NEXT_N_DAYS:${a.days})${ownerCond} ORDER BY StartDateTime LIMIT ${a.limit}`, a.limit);
            return { count: res.totalSize, events: res.records.map((r) => flat(r)) };
          }
          case "create_task":
            if (!a.subject) throw new Error("subject is required");
            return sf("sobjects/Task", { body: { Subject: a.subject, ActivityDate: day(a.due ?? "tomorrow"), Priority: a.priority, Status: "Not Started", Description: a.description, OwnerId: ownerId, ...links } });
          case "log_call":
            return sf("sobjects/Task", { body: { Subject: a.subject ?? "Call", TaskSubtype: "Call", Status: "Completed", ActivityDate: day("today"), CallDurationInSeconds: a.minutes * 60, Description: a.description, OwnerId: ownerId, ...links } });
          case "create_event": {
            if (!a.subject || !a.start) throw new Error("subject and start are required");
            const start = dateTime(a.start);
            return sf("sobjects/Event", { body: { Subject: a.subject, StartDateTime: start, EndDateTime: new Date(Date.parse(start) + a.minutes * 60_000).toISOString(), Description: a.description, OwnerId: ownerId, ...links } });
          }
          case "complete":
            if (!a.task_ids?.length) throw new Error("task_ids is required");
            return sf("composite/sobjects", { method: "PATCH", body: { allOrNone: false, records: a.task_ids.map((Id) => ({ attributes: { type: "Task" }, Id, Status: "Completed" })) } });
        }
      }),
  );

  server.registerTool(
    "sf_reports",
    {
      title: "Reports & dashboards",
      description: "Salesforce reports: find reports by name or folder, run one (optionally with filters) and get grand totals, groupings and the first rows in readable form, list dashboards and refresh/read a dashboard's components.",
      inputSchema: {
        action: z.enum(["find", "run", "dashboards", "dashboard"]),
        name: z.string().optional(),
        id: z.string().optional(),
        filters: z.array(z.object({ column: z.string(), operator: z.string().default("equals"), value: z.string() })).optional().describe("Extra report filters (column API names from the report)"),
        rows: z.number().int().min(0).max(2000).default(25),
      },
    },
    (a) =>
      run(async () => {
        switch (a.action) {
          case "find": {
            const where = a.name ? ` WHERE Name LIKE '%${esc(a.name)}%' OR FolderName LIKE '%${esc(a.name)}%'` : "";
            return (await soql(`SELECT Id, Name, FolderName, Format, LastRunDate FROM Report${where} ORDER BY LastRunDate DESC NULLS LAST LIMIT 50`, 50)).records.map((r) => flat(r));
          }
          case "run": {
            let id = a.id;
            if (!id && a.name) id = String((await soql(`SELECT Id FROM Report WHERE Name = '${esc(a.name)}' LIMIT 1`, 1)).records[0]?.Id ?? "");
            if (!id) throw new Error("id or exact report name is required");
            const body = a.filters ? { reportMetadata: { reportFilters: [...(((await sf<{ reportMetadata: { reportFilters: unknown[] } }>(`analytics/reports/${id}/describe`)).reportMetadata.reportFilters) ?? []), ...a.filters] } } : undefined;
            const r = await sf<Rec>(`analytics/reports/${id}`, { method: body ? "POST" : "GET", query: { includeDetails: a.rows > 0 }, body });
            const meta = r.reportMetadata as Rec;
            const ext = r.reportExtendedMetadata as { detailColumnInfo?: Record<string, { label: string }>; aggregateColumnInfo?: Record<string, { label: string }> };
            const facts = r.factMap as Record<string, { aggregates?: { label: string }[]; rows?: { dataCells: { label: string }[] }[] }>;
            const aggLabels = Object.values(ext.aggregateColumnInfo ?? {}).map((c) => c.label);
            const cols = ((meta.detailColumns as string[]) ?? []).map((c) => ext.detailColumnInfo?.[c]?.label ?? c);
            const groupings = ((r.groupingsDown as { groupings?: { key: string; label: string }[] })?.groupings ?? []).map((g) => ({ group: g.label, ...Object.fromEntries((facts[`${g.key}!T`]?.aggregates ?? []).map((x, i) => [aggLabels[i] ?? `agg${i}`, x.label])) }));
            return {
              report: meta.name,
              grand_total: Object.fromEntries((facts["T!T"]?.aggregates ?? []).map((x, i) => [aggLabels[i] ?? `agg${i}`, x.label])),
              groupings: groupings.length ? groupings : undefined,
              rows: (facts["T!T"]?.rows ?? []).slice(0, a.rows).map((row) => Object.fromEntries(row.dataCells.map((c, i) => [cols[i] ?? i, c.label]))),
              link: `${await instanceUrl()}/lightning/r/Report/${id}/view`,
            };
          }
          case "dashboards":
            return (await soql(`SELECT Id, Title, FolderName, LastReferencedDate FROM Dashboard${a.name ? ` WHERE Title LIKE '%${esc(a.name)}%'` : ""} ORDER BY LastReferencedDate DESC NULLS LAST LIMIT 50`, 50)).records.map((r) => flat(r));
          case "dashboard": {
            if (!a.id) throw new Error("id is required");
            const d = await sf<{ componentData?: { componentId: string; reportResult?: { factMap?: Record<string, { aggregates?: { label: string }[] }>; reportMetadata?: { name?: string } } }[] }>(`analytics/dashboards/${a.id}`);
            return (d.componentData ?? []).map((c) => ({ component: c.componentId, report: c.reportResult?.reportMetadata?.name, total: c.reportResult?.factMap?.["T!T"]?.aggregates?.map((x) => x.label) }));
          }
        }
      }),
  );

  server.registerTool(
    "sf_actions",
    {
      title: "Flows & invocable actions",
      description:
        "Automation: list autolaunched flows and custom/standard invocable actions, see an action's inputs, and run one (e.g. an autolaunched Flow, Apex invocable, chatterPost, emailSimple — email needs confirm). Great for triggering the org's own business logic.",
      inputSchema: {
        action: z.enum(["list", "describe", "run"]),
        kind: z.enum(["flow", "apex", "standard"]).default("flow"),
        name: z.string().optional().describe("Flow API name, Apex action name, or standard action (chatterPost, emailSimple, convertLead…)"),
        inputs: z.array(z.record(z.unknown())).optional(),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        const base = a.kind === "standard" ? "actions/standard" : `actions/custom/${a.kind}`;
        if (a.action === "list") return ((await sf<{ actions?: Rec[] }>(base)).actions ?? []).map((x) => ({ name: x.name, label: x.label, type: x.type }));
        if (!a.name) throw new Error("name is required");
        if (a.action === "describe") {
          const d = await sf<{ inputs?: Rec[]; outputs?: Rec[]; label?: string }>(`${base}/${a.name}`);
          return { label: d.label, inputs: d.inputs?.map((i) => ({ name: i.name, type: i.type, required: i.required, description: i.description })), outputs: d.outputs?.map((o) => ({ name: o.name, type: o.type })) };
        }
        if (/email/i.test(a.name) && !a.confirm) throw new Error("This action sends email; set confirm: true");
        return sf(`${base}/${a.name}`, { body: { inputs: a.inputs ?? [{}] } });
      }),
  );

  server.registerTool(
    "sf_org",
    {
      title: "Org, users & limits",
      description: "Org overview and admin: who am I, organization info (edition, instance, sandbox), users (active, profile, role, last login), API and storage limits, and a connection check.",
      inputSchema: { what: z.enum(["health", "users", "limits"]), search: z.string().optional(), limit: z.number().int().min(1).max(2000).default(100) },
    },
    (a) =>
      run(async () => {
        switch (a.what) {
          case "health": {
            const [u, org] = await Promise.all([me(), soql("SELECT Name, OrganizationType, InstanceName, IsSandbox, DefaultLocaleSidKey, TimeZoneSidKey FROM Organization", 1)]);
            return { instance_url: await instanceUrl(), api_version: apiVersion(), you: u, org: flat(org.records[0] ?? {}) };
          }
          case "users": {
            const where = a.search ? ` AND (Name LIKE '%${esc(a.search)}%' OR Email LIKE '%${esc(a.search)}%')` : "";
            return (await soql(`SELECT Id, Name, Email, Username, Profile.Name, UserRole.Name, LastLoginDate FROM User WHERE IsActive = true AND UserType = 'Standard'${where} ORDER BY Name LIMIT ${a.limit}`, a.limit)).records.map((r) => flat(r));
          }
          case "limits": {
            const l = await sf<Record<string, { Max: number; Remaining: number }>>("limits");
            const pick = ["DailyApiRequests", "DailyBulkV2QueryJobs", "DailyBulkApiBatches", "DataStorageMB", "FileStorageMB", "SingleEmail", "MassEmail", "DailyAsyncApexExecutions", "HourlyPublishedPlatformEvents"];
            return Object.fromEntries(pick.filter((k) => l[k]).map((k) => [k, { used: l[k].Max - l[k].Remaining, max: l[k].Max, pct: l[k].Max ? Math.round(((l[k].Max - l[k].Remaining) / l[k].Max) * 1000) / 10 : 0 }]));
          }
        }
      }),
  );
}
