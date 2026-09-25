import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { dayDate, ghl, locationId, PERIOD, period, schema, userId, userName, when } from "../client.js";

type Rec = Record<string, unknown>;
const CHANNELS = ["SMS", "Email", "WhatsApp", "IG", "FB", "Live_Chat", "Custom"] as const;

export function registerEngageTools(server: McpServer): void {
  server.registerTool(
    "ghl_conversations",
    {
      title: "Conversations & messages",
      description:
        "Inbox: list conversations (unread, starred, by contact or text), read a conversation's messages across SMS, email, WhatsApp, Instagram, Facebook and live chat, send a message on any channel (preview unless confirm: true), schedule an SMS/email for later, mark read/unread, and an unread digest.",
      inputSchema: {
        action: z.enum(["list", "read", "send", "mark_read", "mark_unread", "unread_digest"]),
        location_id: schema.location_id,
        conversation_id: z.string().optional(),
        contact_id: z.string().optional(),
        status: z.enum(["all", "read", "unread", "starred"]).default("all"),
        query: z.string().optional(),
        channel: z.enum(CHANNELS).default("SMS"),
        message: z.string().optional(),
        subject: z.string().optional().describe("Email subject"),
        html: z.string().optional().describe("Email HTML body (else message is used)"),
        email_from: z.string().optional(),
        attachments: z.array(z.string().url()).optional(),
        send_at: z.string().optional().describe("Schedule: ISO datetime, +2h, tomorrow 10am"),
        limit: z.number().int().min(1).max(100).default(20),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const loc = locationId(a.location_id);
        const brief = (c: Rec) => ({ id: c.id, contact: c.fullName ?? c.contactName ?? c.email ?? c.phone, contact_id: c.contactId, last_message: c.lastMessageBody, channel: c.lastMessageType, direction: c.lastMessageDirection, at: c.lastMessageDate ? new Date(Number(c.lastMessageDate)).toISOString() : undefined, unread: c.unreadCount, assigned: c.assignedTo });
        switch (a.action) {
          case "list":
          case "unread_digest": {
            const res = await ghl<{ conversations?: Rec[]; total?: number }>("/conversations/search", {
              query: { locationId: loc, contactId: a.contact_id, query: a.query, status: a.action === "unread_digest" ? "unread" : a.status, limit: a.action === "unread_digest" ? 100 : a.limit, sort: "desc", sortBy: "last_message_date" },
            });
            const list = (res.conversations ?? []).map(brief);
            if (a.action === "list") return { total: res.total, conversations: list };
            const byChannel: Record<string, number> = {};
            for (const c of list) byChannel[String(c.channel ?? "unknown").replace(/^TYPE_/, "")] = (byChannel[String(c.channel ?? "unknown").replace(/^TYPE_/, "")] ?? 0) + 1;
            return { unread_conversations: res.total ?? list.length, by_channel: byChannel, oldest_waiting: list.filter((c) => c.direction === "inbound").sort((x, y) => String(x.at).localeCompare(String(y.at))).slice(0, 10), latest: list.slice(0, 10) };
          }
          case "read": {
            let id = a.conversation_id;
            if (!id && a.contact_id) id = (await ghl<{ conversations?: Rec[] }>("/conversations/search", { query: { locationId: loc, contactId: a.contact_id, limit: 1 } })).conversations?.[0]?.id as string;
            if (!id) throw new Error("conversation_id or contact_id is required");
            const res = await ghl<{ messages?: { messages?: Rec[] } }>(`/conversations/${id}/messages`, { query: { limit: a.limit } });
            return {
              conversation_id: id,
              messages: (res.messages?.messages ?? []).reverse().map((m) => ({ at: m.dateAdded, direction: m.direction, channel: String(m.messageType ?? m.type).replace(/^TYPE_/, ""), status: m.status, subject: (m.meta as Rec)?.email ? ((m.meta as { email?: { subject?: string } }).email?.subject) : undefined, text: m.body, attachments: (m.attachments as unknown[])?.length ? m.attachments : undefined })),
            };
          }
          case "send": {
            if (!a.contact_id) throw new Error("contact_id is required");
            if (!a.message && !a.html) throw new Error("message (or html for email) is required");
            const body: Rec = { type: a.channel, contactId: a.contact_id, message: a.message, attachments: a.attachments };
            if (a.channel === "Email") Object.assign(body, { subject: a.subject ?? "(no subject)", html: a.html ?? a.message?.replace(/\n/g, "<br>"), emailFrom: a.email_from });
            if (a.send_at) body.scheduledTimestamp = Math.floor(when(a.send_at).getTime() / 1000);
            if (!a.confirm) return { preview: true, would_send: body, note: "Nothing sent. Pass confirm: true to send to the contact." };
            const res = await ghl<Rec>("/conversations/messages", { body });
            return { sent: !a.send_at, scheduled: a.send_at ? new Date(Number(body.scheduledTimestamp) * 1000).toISOString() : undefined, message_id: res.messageId, conversation_id: res.conversationId };
          }
          case "mark_read":
          case "mark_unread":
            if (!a.conversation_id) throw new Error("conversation_id is required");
            await ghl(`/conversations/${a.conversation_id}`, { method: "PUT", body: { locationId: loc, unreadCount: a.action === "mark_read" ? 0 : 1 } });
            return { [a.action === "mark_read" ? "read" : "unread"]: a.conversation_id };
        }
      }),
  );

  server.registerTool(
    "ghl_calendars",
    {
      title: "Calendars & appointments",
      description:
        "Scheduling: list calendars, find free slots for a calendar over the next days, list appointments (by calendar or user, date window), book an appointment for a contact (start like \"tomorrow 3pm\"), reschedule or change status (confirmed, cancelled, showed, noshow), and delete (confirm).",
      inputSchema: {
        action: z.enum(["calendars", "free_slots", "appointments", "book", "update", "delete"]),
        location_id: schema.location_id,
        calendar_id: z.string().optional(),
        user: z.string().optional().describe("Team member name/email (appointments filter or assignee)"),
        contact_id: z.string().optional(),
        event_id: z.string().optional(),
        start: z.string().optional().describe("ISO datetime, +2h, tomorrow 3pm, friday 10:30am"),
        end: z.string().optional(),
        days: z.number().int().min(1).max(31).default(7),
        from: z.string().optional().describe("Window start (appointments/free_slots): today, tomorrow, YYYY-MM-DD"),
        timezone: z.string().optional().describe("e.g. Asia/Dhaka"),
        title: z.string().optional(),
        status: z.enum(["confirmed", "cancelled", "showed", "noshow", "invalid"]).optional(),
        notes: z.string().optional(),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const loc = locationId(a.location_id);
        const start = dayDate(a.from ?? "today");
        const end = new Date(start.getTime() + a.days * 86_400_000);
        switch (a.action) {
          case "calendars":
            return ((await ghl<{ calendars?: Rec[] }>("/calendars/", { query: { locationId: loc } })).calendars ?? []).map((c) => ({ id: c.id, name: c.name, type: c.calendarType, active: c.isActive, slot_minutes: c.slotDuration, team: (c.teamMembers as unknown[])?.length }));
          case "free_slots": {
            if (!a.calendar_id) throw new Error("calendar_id is required");
            const res = await ghl<Record<string, { slots?: string[] }>>(`/calendars/${a.calendar_id}/free-slots`, { query: { startDate: start.getTime(), endDate: end.getTime(), timezone: a.timezone } });
            return Object.fromEntries(Object.entries(res).filter(([k]) => /^\d{4}-/.test(k)).map(([d, v]) => [d, v.slots ?? []]));
          }
          case "appointments": {
            const query: Record<string, string | number | undefined> = { locationId: loc, startTime: start.getTime(), endTime: end.getTime(), calendarId: a.calendar_id };
            if (!a.calendar_id) query.userId = a.user ? await userId(loc, a.user) : undefined;
            if (!query.calendarId && !query.userId) {
              const cals = (await ghl<{ calendars?: Rec[] }>("/calendars/", { query: { locationId: loc } })).calendars ?? [];
              const all = await Promise.all(cals.map((c) => ghl<{ events?: Rec[] }>("/calendars/events", { query: { ...query, calendarId: c.id as string } }).then((r) => r.events ?? []).catch(() => [])));
              return shape(all.flat());
            }
            return shape((await ghl<{ events?: Rec[] }>("/calendars/events", { query })).events ?? []);
            async function shape(events: Rec[]) {
              return Promise.all(events.sort((x, y) => String(x.startTime).localeCompare(String(y.startTime))).map(async (e) => ({ id: e.id, title: e.title, start: e.startTime, end: e.endTime, status: e.appointmentStatus, contact_id: e.contactId, calendar_id: e.calendarId, assigned: await userName(loc, e.assignedUserId as string) })));
            }
          }
          case "book": {
            if (!a.calendar_id || !a.contact_id || !a.start) throw new Error("calendar_id, contact_id and start are required");
            const s = when(a.start);
            const body: Rec = { calendarId: a.calendar_id, locationId: loc, contactId: a.contact_id, startTime: s.toISOString(), title: a.title, appointmentStatus: a.status ?? "confirmed", assignedUserId: a.user ? await userId(loc, a.user) : undefined, notes: a.notes };
            if (a.end) body.endTime = when(a.end).toISOString();
            const res = await ghl<Rec>("/calendars/events/appointments", { body });
            return { booked: res.id, start: res.startTime ?? body.startTime, end: res.endTime, status: res.appointmentStatus ?? res.status };
          }
          case "update": {
            if (!a.event_id) throw new Error("event_id is required");
            const body: Rec = {};
            if (a.start) body.startTime = when(a.start).toISOString();
            if (a.end) body.endTime = when(a.end).toISOString();
            if (a.status) body.appointmentStatus = a.status;
            if (a.title) body.title = a.title;
            if (a.calendar_id) body.calendarId = a.calendar_id;
            await ghl(`/calendars/events/appointments/${a.event_id}`, { method: "PUT", body });
            return { updated: a.event_id, ...body };
          }
          case "delete":
            if (!a.event_id) throw new Error("event_id is required");
            if (!a.confirm) throw new Error("Deleting removes the appointment (use status cancelled to keep a record); set confirm: true");
            await ghl(`/calendars/events/${a.event_id}`, { method: "DELETE", body: {} });
            return { deleted: a.event_id };
        }
      }),
  );

  server.registerTool(
    "ghl_automation",
    {
      title: "Workflows, campaigns, forms & surveys",
      description: "Automation assets: list workflows (id, status) and campaigns, list forms and surveys, and read form or survey submissions for a period (who submitted what).",
      inputSchema: {
        what: z.enum(["workflows", "campaigns", "forms", "form_submissions", "surveys", "survey_submissions"]),
        location_id: schema.location_id,
        form_id: z.string().optional(),
        survey_id: z.string().optional(),
        preset: PERIOD,
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    (a) =>
      run(async () => {
        const loc = locationId(a.location_id);
        const p = period(a.preset, a.from, a.to);
        const window = { startAt: p.start.toISOString().slice(0, 10), endAt: p.end.toISOString().slice(0, 10) };
        switch (a.what) {
          case "workflows":
            return ((await ghl<{ workflows?: Rec[] }>("/workflows/", { query: { locationId: loc } })).workflows ?? []).map((w) => ({ id: w.id, name: w.name, status: w.status, updated: w.updatedAt }));
          case "campaigns":
            return (await ghl<{ campaigns?: Rec[] }>("/campaigns/", { query: { locationId: loc } })).campaigns ?? [];
          case "forms":
            return ((await ghl<{ forms?: Rec[] }>("/forms/", { query: { locationId: loc, limit: a.limit } })).forms ?? []).map((f) => ({ id: f.id, name: f.name }));
          case "surveys":
            return ((await ghl<{ surveys?: Rec[] }>("/surveys/", { query: { locationId: loc, limit: a.limit } })).surveys ?? []).map((f) => ({ id: f.id, name: f.name }));
          case "form_submissions":
          case "survey_submissions": {
            const path = a.what === "form_submissions" ? "/forms/submissions" : "/surveys/submissions";
            const res = await ghl<{ submissions?: Rec[]; meta?: { total?: number } }>(path, { query: { locationId: loc, formId: a.form_id, surveyId: a.survey_id, limit: a.limit, page: 1, ...window } });
            return { window, total: res.meta?.total, submissions: (res.submissions ?? []).map((s) => ({ id: s.id, contact_id: s.contactId, name: s.name, email: s.email, at: s.createdAt, fields: s.others })) };
          }
        }
      }),
  );
}
