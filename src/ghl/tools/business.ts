import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { customFields, ghl, locationId, money, PERIOD, period, pipelines, schema, users } from "../client.js";

type Rec = Record<string, unknown>;

export function registerBusinessTools(server: McpServer): void {
  server.registerTool(
    "ghl_payments",
    {
      title: "Invoices, payments & products",
      description:
        "Money in a sub-account: invoices (list by status, get, send to the contact with confirm, record a manual payment with confirm), payment transactions and orders for a period with totals, subscriptions, and products with prices.",
      inputSchema: {
        what: z.enum(["invoices", "invoice", "send_invoice", "record_payment", "transactions", "orders", "subscriptions", "products"]),
        location_id: schema.location_id,
        id: z.string().optional().describe("Invoice ID"),
        status: z.enum(["draft", "sent", "payment_processing", "paid", "void", "partially_paid"]).optional(),
        preset: PERIOD,
        from: z.string().optional(),
        to: z.string().optional(),
        amount: z.number().optional().describe("record_payment amount"),
        mode: z.enum(["cash", "card", "cheque", "bank_transfer", "other"]).default("cash"),
        send_via: z.enum(["sms_and_email", "send_email", "send_sms"]).default("sms_and_email"),
        user_id: z.string().optional().describe("Sender user id for send_invoice (see ghl_location what=users)"),
        limit: z.number().int().min(1).max(100).default(50),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const loc = locationId(a.location_id);
        const alt = { altId: loc, altType: "location" };
        const p = a.preset || a.from ? period(a.preset, a.from, a.to) : undefined;
        switch (a.what) {
          case "invoices": {
            const res = await ghl<{ invoices?: Rec[]; total?: number }>("/invoices/", { query: { ...alt, limit: a.limit, offset: 0, status: a.status, startAt: p?.start.toISOString().slice(0, 10), endAt: p?.end.toISOString().slice(0, 10) } });
            const list = res.invoices ?? [];
            return {
              total: res.total,
              amount: money(list.reduce((s, i) => s + (Number(i.total) || 0), 0)),
              due: money(list.reduce((s, i) => s + (Number(i.amountDue) || 0), 0)),
              invoices: list.map((i) => ({ id: i._id ?? i.id, number: i.invoiceNumber, name: i.name, contact: (i.contactDetails as Rec)?.name, status: i.status, total: i.total, due: i.amountDue, currency: i.currency, issued: i.issueDate, due_date: i.dueDate })),
            };
          }
          case "invoice":
            if (!a.id) throw new Error("id is required");
            return ghl(`/invoices/${a.id}`, { query: alt });
          case "send_invoice":
            if (!a.id || !a.user_id) throw new Error("id and user_id are required");
            if (!a.confirm) throw new Error(`This sends the invoice to the customer by ${a.send_via.replace(/_/g, " ")}; set confirm: true`);
            return ghl(`/invoices/${a.id}/send`, { body: { ...alt, userId: a.user_id, action: a.send_via, liveMode: true } });
          case "record_payment":
            if (!a.id || !a.amount) throw new Error("id and amount are required");
            if (!a.confirm) throw new Error(`This records a ${a.amount} ${a.mode} payment on the invoice; set confirm: true`);
            return ghl(`/invoices/${a.id}/record-payment`, { body: { ...alt, mode: a.mode, amount: a.amount, notes: "Recorded via MCP" } });
          case "transactions":
          case "orders":
          case "subscriptions": {
            const path = { transactions: "/payments/transactions", orders: "/payments/orders", subscriptions: "/payments/subscriptions" }[a.what];
            const res = await ghl<{ data?: Rec[]; totalCount?: number }>(path, { query: { ...alt, limit: a.limit, offset: 0, startAt: p?.start.toISOString(), endAt: p?.end.toISOString() } });
            const rows = res.data ?? [];
            const amt = (r: Rec) => Number(r.amount ?? r.amountTotal ?? (r.recurringProduct as Rec)?.price ?? 0) || 0;
            const succeeded = rows.filter((r) => ["succeeded", "completed", "active", "paid"].includes(String(r.status)));
            return { total: res.totalCount ?? rows.length, gross: money(succeeded.reduce((s, r) => s + amt(r), 0)), [a.what]: rows.map((r) => ({ id: r._id ?? r.id, contact: r.contactName ?? (r.contactSnapshot as Rec)?.firstName, amount: amt(r), currency: r.currency, status: r.status, source: r.entitySourceName ?? r.entitySourceType, at: r.createdAt })) };
          }
          case "products": {
            const res = await ghl<{ products?: Rec[] }>("/products/", { query: { locationId: loc, limit: a.limit } });
            const out = [];
            for (const pr of res.products ?? []) {
              const prices = await ghl<{ prices?: Rec[] }>(`/products/${pr._id}/price`, { query: { locationId: loc } }).then((r) => r.prices ?? []).catch(() => []);
              out.push({ id: pr._id, name: pr.name, type: pr.productType, prices: prices.map((x) => ({ id: x._id, name: x.name, amount: x.amount, currency: x.currency, type: x.type, interval: (x.recurring as Rec)?.interval })) });
            }
            return out;
          }
        }
      }),
  );

  server.registerTool(
    "ghl_location",
    {
      title: "Sub-account setup",
      description:
        "Sub-account setup: location details, team users and roles, custom fields (names, keys, types, options) and create one, custom values (list/update), tags (list/create/delete with confirm), and all sub-accounts under the agency (agency token only).",
      inputSchema: {
        what: z.enum(["info", "users", "custom_fields", "create_custom_field", "custom_values", "update_custom_value", "tags", "create_tag", "delete_tag", "sub_accounts"]),
        location_id: schema.location_id,
        name: z.string().optional(),
        data_type: z.enum(["TEXT", "LARGE_TEXT", "NUMERICAL", "PHONE", "MONETORY", "CHECKBOX", "SINGLE_OPTIONS", "MULTIPLE_OPTIONS", "DATE", "EMAIL"]).optional(),
        options: z.array(z.string()).optional(),
        id: z.string().optional(),
        value: z.string().optional(),
        company_id: z.string().optional().describe("sub_accounts: agency company id"),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const loc = locationId(a.location_id);
        switch (a.what) {
          case "info": {
            const l = (await ghl<{ location?: Rec }>(`/locations/${loc}`)).location ?? {};
            return { id: l.id, name: l.name, email: l.email, phone: l.phone, website: l.website, address: [l.address, l.city, l.state, l.country].filter(Boolean).join(", "), timezone: l.timezone, company_id: l.companyId };
          }
          case "users":
            return (await users(loc)).map((u) => ({ id: u.id, name: u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim(), email: u.email, role: u.roles?.role }));
          case "custom_fields":
            return (await customFields(loc)).map((f) => ({ id: f.id, name: f.name, key: f.fieldKey, type: f.dataType, options: f.picklistOptions?.length ? f.picklistOptions : undefined, model: f.model }));
          case "create_custom_field":
            if (!a.name || !a.data_type) throw new Error("name and data_type are required");
            return ghl(`/locations/${loc}/customFields`, { body: { name: a.name, dataType: a.data_type, options: a.options, model: "contact" } });
          case "custom_values":
            return (await ghl<{ customValues?: Rec[] }>(`/locations/${loc}/customValues`)).customValues ?? [];
          case "update_custom_value":
            if (!a.id || a.value === undefined) throw new Error("id and value are required");
            return ghl(`/locations/${loc}/customValues/${a.id}`, { method: "PUT", body: { name: a.name, value: a.value } });
          case "tags":
            return ((await ghl<{ tags?: Rec[] }>(`/locations/${loc}/tags`)).tags ?? []).map((t) => ({ id: t.id, name: t.name }));
          case "create_tag":
            if (!a.name) throw new Error("name is required");
            return ghl(`/locations/${loc}/tags`, { body: { name: a.name } });
          case "delete_tag":
            if (!a.id) throw new Error("id is required");
            if (!a.confirm) throw new Error("Deleting a tag removes it from every contact; set confirm: true");
            return ghl(`/locations/${loc}/tags/${a.id}`, { method: "DELETE" });
          case "sub_accounts": {
            if (!a.company_id) throw new Error("company_id is required (see what=info → company_id)");
            const res = await ghl<{ locations?: Rec[] }>("/locations/search", { query: { companyId: a.company_id, limit: 100 } });
            return (res.locations ?? []).map((l) => ({ id: l.id, name: l.name, email: l.email, city: l.city }));
          }
        }
      }),
  );

  server.registerTool(
    "ghl_dashboard",
    {
      title: "Sub-account dashboard",
      description: "One-shot health of a sub-account for a period: new contacts (by source and tag), opportunities won/lost/open with value per pipeline, appointments booked by status, unread conversations, and revenue from payments.",
      inputSchema: { location_id: schema.location_id, preset: PERIOD.describe("Default last_30_days"), from: z.string().optional(), to: z.string().optional() },
    },
    (a) =>
      run(async () => {
        const loc = locationId(a.location_id);
        const p = period(a.preset, a.from, a.to);
        const safe = <T>(pr: Promise<T>, fallback: T) => pr.catch((e: Error) => ({ error: e.message, ...fallback }) as T);
        const contacts = safe(
          (async () => {
            const res = await ghl<{ contacts?: Rec[]; total?: number }>("/contacts/search", { body: { locationId: loc, page: 1, pageLimit: 100, filters: [{ field: "dateAdded", operator: "range", value: { gte: p.start.toISOString(), lte: p.end.toISOString() } }] } });
            const bySource: Record<string, number> = {};
            for (const c of res.contacts ?? []) bySource[String(c.source || "(none)")] = (bySource[String(c.source || "(none)")] ?? 0) + 1;
            return { new: res.total ?? 0, by_source_sample: bySource };
          })(),
          {} as Rec,
        );
        const opps = safe(
          (async () => {
            const pls = await pipelines(loc);
            const out: Rec[] = [];
            for (const pl of pls) {
              const res = await ghl<{ opportunities?: Rec[]; meta?: { total?: number } }>("/opportunities/search", { query: { location_id: loc, pipeline_id: pl.id, status: "all", limit: 100, date: p.start.toISOString().slice(0, 10) } });
              const rows = (res.opportunities ?? []).filter((o) => new Date(String(o.updatedAt ?? o.createdAt)) >= p.start);
              const sum = (s: string) => money(rows.filter((o) => o.status === s).reduce((t, o) => t + (Number(o.monetaryValue) || 0), 0));
              out.push({ pipeline: pl.name, open: rows.filter((o) => o.status === "open").length, open_value: sum("open"), won: rows.filter((o) => o.status === "won").length, won_value: sum("won"), lost: rows.filter((o) => o.status === "lost").length });
            }
            return out;
          })(),
          [] as Rec[],
        );
        const appts = safe(
          (async () => {
            const cals = (await ghl<{ calendars?: Rec[] }>("/calendars/", { query: { locationId: loc } })).calendars ?? [];
            const events = (await Promise.all(cals.map((c) => ghl<{ events?: Rec[] }>("/calendars/events", { query: { locationId: loc, calendarId: c.id as string, startTime: p.start.getTime(), endTime: p.end.getTime() } }).then((r) => r.events ?? []).catch(() => [])))).flat();
            const byStatus: Record<string, number> = {};
            for (const e of events) byStatus[String(e.appointmentStatus)] = (byStatus[String(e.appointmentStatus)] ?? 0) + 1;
            return { total: events.length, by_status: byStatus };
          })(),
          {} as Rec,
        );
        const unread = safe(ghl<{ total?: number }>("/conversations/search", { query: { locationId: loc, status: "unread", limit: 1 } }).then((r) => ({ unread_conversations: r.total })), {} as Rec);
        const revenue = safe(
          ghl<{ data?: Rec[]; totalCount?: number }>("/payments/transactions", { query: { altId: loc, altType: "location", limit: 100, startAt: p.start.toISOString(), endAt: p.end.toISOString() } }).then((r) => ({
            transactions: r.totalCount ?? r.data?.length,
            gross: money((r.data ?? []).filter((t) => t.status === "succeeded").reduce((s, t) => s + (Number(t.amount) || 0), 0)),
          })),
          {} as Rec,
        );
        const [c, o, ap, u, rv] = await Promise.all([contacts, opps, appts, unread, revenue]);
        return { window: { from: p.start.toISOString().slice(0, 10), to: p.end.toISOString().slice(0, 10) }, contacts: c, opportunities: o, appointments: ap, inbox: u, payments: rv };
      }),
  );

  server.registerTool(
    "ghl_api",
    {
      title: "HighLevel API call",
      description: "Call ANY HighLevel API v2 endpoint (https://services.leadconnectorhq.com) — e.g. /blogs, /social-media-posting, /funnels, /emails/builder, /medias, /associations, /objects (custom objects), /courses. The Version header is set automatically.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string().describe("e.g. /locations/{locationId}/customValues"),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional(),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        if (a.method === "DELETE" && !a.confirm) throw new Error("DELETE calls need confirm: true");
        return ghl(a.path.replace("{locationId}", locationId()), { method: a.method, query: a.query, body: a.body });
      }),
  );

  server.registerTool(
    "ghl_health",
    {
      title: "Connection check",
      description: "Check the token and sub-account: location name and timezone, team size, pipelines, custom fields, and which API areas the Private Integration's scopes allow.",
      inputSchema: { location_id: schema.location_id },
    },
    (a) =>
      run(async () => {
        const loc = locationId(a.location_id);
        const probe = async (name: string, fn: () => Promise<unknown>) => fn().then(() => [name, "ok"] as const, (e: Error) => [name, e.message.replace(/^HighLevel /, "")] as const);
        const l = (await ghl<{ location?: Rec }>(`/locations/${loc}`)).location ?? {};
        const scopes = Object.fromEntries(
          await Promise.all([
            probe("contacts", () => ghl("/contacts/search", { body: { locationId: loc, page: 1, pageLimit: 1 } })),
            probe("opportunities", () => pipelines(loc)),
            probe("conversations", () => ghl("/conversations/search", { query: { locationId: loc, limit: 1 } })),
            probe("calendars", () => ghl("/calendars/", { query: { locationId: loc } })),
            probe("workflows", () => ghl("/workflows/", { query: { locationId: loc } })),
            probe("users", () => users(loc)),
            probe("custom_fields", () => customFields(loc)),
            probe("invoices", () => ghl("/invoices/", { query: { altId: loc, altType: "location", limit: 1, offset: 0 } })),
            probe("payments", () => ghl("/payments/transactions", { query: { altId: loc, altType: "location", limit: 1 } })),
          ]),
        );
        return { location: { id: loc, name: l.name, timezone: l.timezone }, scopes };
      }),
  );
}
