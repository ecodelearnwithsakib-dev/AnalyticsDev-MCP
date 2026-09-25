import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { all, confirm, customFieldValues, day, pd, readableCustom, userId, userName, ymd, type Rec } from "../client.js";
import { findOrCreate } from "./deals.js";

const strip = (html: unknown) => String(html ?? "").replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();

export function registerPeopleTools(server: McpServer): void {
  server.registerTool(
    "pipedrive_contacts",
    {
      title: "People & organizations",
      description:
        "Contacts: search people or organizations (name, email, phone), get one with custom fields by name plus their deals, create (emails/phones, organization by name — created if missing, owner, custom fields by name), update, delete (confirm), merge two records (confirm), and list an organization's people.",
      inputSchema: {
        action: z.enum(["search", "get", "create", "update", "delete", "merge", "org_people"]),
        kind: z.enum(["person", "organization"]).default("person"),
        id: z.number().int().optional(),
        merge_into_id: z.number().int().optional().describe("merge: the record that survives"),
        query: z.string().optional(),
        name: z.string().optional(),
        emails: z.array(z.string()).optional(),
        phones: z.array(z.string()).optional(),
        organization: z.union([z.string(), z.number()]).optional(),
        address: z.string().optional().describe("organization address"),
        owner: z.string().optional(),
        custom: z.record(z.unknown()).optional(),
        limit: z.number().int().min(1).max(500).default(30),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        const plural = a.kind === "person" ? "persons" : "organizations";
        const entity = a.kind === "person" ? "person" : "organization";
        const need = () => {
          if (!a.id) throw new Error("id is required");
          return a.id;
        };
        const body = async (): Promise<Rec> => {
          const b: Rec = {};
          if (a.name) b.name = a.name;
          if (a.emails) b.emails = a.emails.map((value, i) => ({ value, primary: i === 0, label: "work" }));
          if (a.phones) b.phones = a.phones.map((value, i) => ({ value, primary: i === 0, label: "work" }));
          if (a.organization !== undefined && a.kind === "person") b.org_id = await findOrCreate("organizations", a.organization, true);
          if (a.address && a.kind === "organization") b.address = { value: a.address };
          if (a.owner) b.owner_id = await userId(a.owner);
          if (a.custom) b.custom_fields = await customFieldValues(entity, a.custom);
          return b;
        };
        switch (a.action) {
          case "search": {
            if (!a.query) throw new Error("query is required");
            const res = await pd<{ data?: { items?: { item: Rec; result_score?: number }[] } }>(`v2/${plural}/search`, { query: { term: a.query, limit: a.limit } });
            return (res.data?.items ?? []).map(({ item }) => ({ id: item.id, name: item.name, emails: item.emails ?? undefined, phones: item.phones ?? undefined, organization: (item.organization as Rec)?.name ?? undefined, owner: (item.owner as Rec)?.id, address: item.address ?? undefined }));
          }
          case "get": {
            const rec = (await pd<{ data: Rec }>(`v2/${plural}/${need()}`)).data;
            const deals = await all("v2/deals", { [a.kind === "person" ? "person_id" : "org_id"]: a.id, status: "open" } as Record<string, number | string>, 20).catch(() => []);
            return {
              id: rec.id,
              name: rec.name,
              emails: (rec.emails as Rec[] | undefined)?.map((e) => e.value),
              phones: (rec.phones as Rec[] | undefined)?.map((e) => e.value),
              org_id: rec.org_id ?? undefined,
              address: (rec.address as Rec)?.value ?? undefined,
              owner: await userName(rec.owner_id),
              added: rec.add_time,
              custom: await readableCustom(entity, rec.custom_fields as Rec),
              open_deals: deals.map((d) => ({ id: d.id, title: d.title, value: d.value, stage_id: d.stage_id })),
            };
          }
          case "create": {
            const b = await body();
            if (!b.name) throw new Error("name is required");
            return { created: ((await pd<{ data: Rec }>(`v2/${plural}`, { body: b })).data ?? {}).id };
          }
          case "update":
            await pd(`v2/${plural}/${need()}`, { method: "PATCH", body: await body() });
            return { updated: a.id };
          case "delete":
            if (!a.confirm) throw new Error(`Deleting this ${a.kind} (recoverable for 30 days); set confirm: true`);
            await pd(`v2/${plural}/${need()}`, { method: "DELETE" });
            return { deleted: a.id };
          case "merge":
            if (!a.merge_into_id) throw new Error("merge_into_id is required");
            if (!a.confirm) throw new Error(`Merging ${a.kind} ${a.id} into ${a.merge_into_id} moves its deals, activities and notes and removes it; set confirm: true`);
            return (await pd<{ data: Rec }>(`v1/${plural}/${need()}/merge`, { method: "PUT", body: { merge_with_id: a.merge_into_id } })).data;
          case "org_people": {
            const rows = await all("v2/persons", { org_id: need() } as Record<string, number>, a.limit);
            return rows.map((p) => ({ id: p.id, name: p.name, emails: (p.emails as Rec[] | undefined)?.map((e) => e.value), phones: (p.phones as Rec[] | undefined)?.map((e) => e.value) }));
          }
        }
      }),
  );

  server.registerTool(
    "pipedrive_activities",
    {
      title: "Activities & notes",
      description:
        "Follow-ups: list activities (mine/someone's/everyone's; overdue, today, upcoming or done; by deal/person/org), schedule one (call, meeting, task, deadline, email, lunch… with date, time, duration, linked deal/person/org), mark done, reschedule/update, delete (confirm); list or add notes on a deal, person, organization or lead.",
      inputSchema: {
        action: z.enum(["list", "create", "done", "update", "delete", "notes", "add_note"]),
        id: z.number().int().optional().describe("Activity id"),
        owner: z.string().optional().describe("Default me; \"all\" for everyone"),
        when: z.enum(["overdue", "today", "upcoming", "done", "all"]).default("all"),
        deal_id: z.number().int().optional(),
        person_id: z.number().int().optional(),
        org_id: z.number().int().optional(),
        lead_id: z.string().optional(),
        type: z.string().default("call").describe("Activity type key: call, meeting, task, deadline, email, lunch"),
        subject: z.string().optional(),
        due: z.string().optional().describe("YYYY-MM-DD, today, tomorrow, +3d, friday"),
        time: z.string().optional().describe("HH:MM (24h, UTC per Pipedrive)"),
        duration: z.string().optional().describe("HH:MM"),
        note: z.string().optional(),
        limit: z.number().int().min(1).max(2000).default(50),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        switch (a.action) {
          case "list": {
            const today = ymd(new Date());
            const query: Record<string, string | number | boolean | undefined> = { deal_id: a.deal_id, person_id: a.person_id, org_id: a.org_id, sort_by: "due_date", sort_direction: "asc" };
            if (a.owner !== "all") query.owner_id = await userId(a.owner ?? "me");
            if (a.when === "done") query.done = true;
            else if (a.when !== "all") query.done = false;
            let rows = await all("v2/activities", query, a.when === "all" ? a.limit : 2000);
            if (a.when === "overdue") rows = rows.filter((r) => String(r.due_date) < today);
            if (a.when === "today") rows = rows.filter((r) => r.due_date === today);
            if (a.when === "upcoming") rows = rows.filter((r) => String(r.due_date) > today);
            return {
              count: rows.length,
              activities: await Promise.all(rows.slice(0, a.limit).map(async (r) => ({ id: r.id, subject: r.subject, type: r.type, due: r.due_date, time: r.due_time || undefined, done: r.done, deal_id: r.deal_id ?? undefined, person_id: (r.participants as Rec[] | undefined)?.[0]?.person_id, org_id: r.org_id ?? undefined, owner: await userName(r.owner_id), note: r.note ? strip(r.note).slice(0, 200) : undefined }))),
            };
          }
          case "create": {
            if (!a.subject) throw new Error("subject is required");
            const body: Rec = { subject: a.subject, type: a.type, due_date: day(a.due ?? "today"), due_time: a.time, duration: a.duration, deal_id: a.deal_id, org_id: a.org_id, lead_id: a.lead_id, note: a.note, owner_id: a.owner && a.owner !== "all" ? await userId(a.owner) : undefined };
            if (a.person_id) body.participants = [{ person_id: a.person_id, primary: true }];
            const res = (await pd<{ data: Rec }>("v2/activities", { body })).data;
            return { created: res.id, due: res.due_date, time: res.due_time || undefined };
          }
          case "done":
          case "update": {
            if (!a.id) throw new Error("id is required");
            const body: Rec = a.action === "done" ? { done: true } : {};
            if (a.subject) body.subject = a.subject;
            if (a.due) body.due_date = day(a.due);
            if (a.time) body.due_time = a.time;
            if (a.duration) body.duration = a.duration;
            if (a.note) body.note = a.note;
            if (a.action === "update" && a.type) body.type = a.type;
            await pd(`v2/activities/${a.id}`, { method: "PATCH", body });
            return { [a.action === "done" ? "done" : "updated"]: a.id };
          }
          case "delete":
            if (!a.id) throw new Error("id is required");
            if (!a.confirm) throw new Error("Deleting an activity; set confirm: true");
            await pd(`v2/activities/${a.id}`, { method: "DELETE" });
            return { deleted: a.id };
          case "notes": {
            const res = await pd<{ data?: Rec[] }>("v1/notes", { query: { deal_id: a.deal_id, person_id: a.person_id, org_id: a.org_id, lead_id: a.lead_id, limit: a.limit, sort: "add_time DESC" } });
            return (res.data ?? []).map((n) => ({ id: n.id, at: n.add_time, by: (n.user as Rec)?.name, text: strip(n.content), pinned: n.pinned_to_deal_flag || n.pinned_to_person_flag || undefined }));
          }
          case "add_note":
            if (!a.note) throw new Error("note is required");
            if (!a.deal_id && !a.person_id && !a.org_id && !a.lead_id) throw new Error("deal_id, person_id, org_id or lead_id is required");
            return { created: ((await pd<{ data: Rec }>("v1/notes", { body: { content: a.note.replace(/\n/g, "<br>"), deal_id: a.deal_id, person_id: a.person_id, org_id: a.org_id, lead_id: a.lead_id } })).data ?? {}).id };
        }
      }),
  );
}
