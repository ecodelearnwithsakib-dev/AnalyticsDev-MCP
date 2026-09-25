import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { baseUrl, compact, database, day, detectProtocol, existing, idByName, me, odoo, PERIOD, period, resolveVals, schema, userId, version, ymd, type Domain } from "../client.js";

type Rec = Record<string, unknown>;
const m2o = (v: unknown) => (Array.isArray(v) ? (v[1] as string) : undefined);
const money = (n: number) => Math.round(n * 100) / 100;
const first = (ids: number[] | number) => (Array.isArray(ids) ? ids[0] : ids);

/** Product by internal reference (default_code), barcode or name. */
async function productId(ref: string | number): Promise<number> {
  if (typeof ref === "number") return ref;
  const [byCode] = await odoo<number[]>("product.product", "search", { domain: ["|", ["default_code", "=", ref], ["barcode", "=", ref]], limit: 1 });
  return byCode ?? idByName("product.product", ref);
}

async function partnerId(ref: string | number): Promise<number> {
  if (typeof ref === "number") return ref;
  const [hit] = await odoo<number[]>("res.partner", "search", { domain: ["|", ["email", "=ilike", ref], ["name", "=ilike", ref]], limit: 1 });
  return hit ?? idByName("res.partner", ref);
}

const LINE = z.object({
  product: z.union([z.string(), z.number()]).describe("Product name, internal reference, barcode or id"),
  quantity: z.number().positive().default(1),
  price: z.number().optional().describe("Unit price (default: pricelist price)"),
  discount: z.number().min(0).max(100).optional(),
  description: z.string().optional(),
});

async function lines(items: z.infer<typeof LINE>[], qtyField: "product_uom_qty" | "quantity") {
  return Promise.all(
    items.map(async (l) => [0, 0, { product_id: await productId(l.product), [qtyField]: l.quantity, ...(l.price !== undefined ? { price_unit: l.price } : {}), ...(l.discount ? { discount: l.discount } : {}), ...(l.description ? { name: l.description } : {}) }]),
  );
}

export function registerBusinessTools(server: McpServer): void {
  server.registerTool(
    "odoo_contacts",
    {
      title: "Customers & contacts",
      description:
        "Find customers/contacts by name, email, phone or company; get a 360° view (contact details, open opportunities, quotations/orders, invoiced and unpaid amounts, next activities); create or update contacts (company by name, tags created if missing, salesperson).",
      inputSchema: {
        action: z.enum(["search", "overview", "create", "update"]),
        query: z.string().optional().describe("search: name, email, phone or company"),
        id: z.number().int().optional(),
        values: z.record(z.unknown()).optional().describe("res.partner fields: name, email, phone, mobile, is_company, parent_id (company name), function, street, city, country_id (name), website, category_id ([tags]), user_id (salesperson), comment"),
        companies_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(30),
      },
    },
    (a) =>
      run(async () => {
        switch (a.action) {
          case "search": {
            const domain: Domain = a.companies_only ? [["is_company", "=", true]] : [];
            if (a.query) {
              const cols = await existing("res.partner", ["name", "email", "phone", "mobile", "parent_id"]);
              domain.push(...Array(cols.length - 1).fill("|"), ...cols.map((c) => [c === "parent_id" ? "parent_id.name" : c, "ilike", a.query]));
            }
            const rows = await odoo<Rec[]>("res.partner", "search_read", { domain, fields: await existing("res.partner", ["name", "is_company", "parent_id", "email", "phone", "mobile", "city", "country_id", "user_id", "category_id"]), limit: a.limit, order: "name" });
            return rows.map(compact);
          }
          case "overview": {
            const id = a.id ?? (a.query ? await partnerId(a.query) : undefined);
            if (!id) throw new Error("id or query is required");
            const [p] = await odoo<Rec[]>("res.partner", "read", { fields: await existing("res.partner", ["name", "is_company", "parent_id", "email", "phone", "mobile", "street", "city", "country_id", "website", "function", "user_id", "category_id", "child_ids"]) }, [id]);
            const who: Domain = [["partner_id", "child_of", id]];
            const safe = <T>(pr: Promise<T>, fallback: T) => pr.catch(() => fallback);
            const [opps, orders, invoices, activities] = await Promise.all([
              safe(odoo<Rec[]>("crm.lead", "search_read", { domain: [...who, ["stage_id.is_won", "=", false]], fields: ["name", "stage_id", "expected_revenue", "user_id"], limit: 20 }), [] as Rec[]),
              safe(odoo<Rec[]>("sale.order", "search_read", { domain: who, fields: ["name", "state", "amount_total", "date_order"], order: "date_order desc", limit: 10 }), [] as Rec[]),
              safe(odoo<Rec[]>("account.move", "search_read", { domain: [...who, ["move_type", "=", "out_invoice"], ["state", "=", "posted"]], fields: ["name", "amount_total", "amount_residual", "invoice_date_due", "payment_state"], limit: 500 }), [] as Rec[]),
              safe(odoo<Rec[]>("mail.activity", "search_read", { domain: [["res_model", "=", "res.partner"], ["res_id", "=", id]], fields: ["activity_type_id", "summary", "date_deadline", "user_id"] }), [] as Rec[]),
            ]);
            const today = ymd(new Date());
            return {
              contact: compact(p),
              open_opportunities: opps.map(compact),
              recent_orders: orders.map(compact),
              invoiced_total: money(invoices.reduce((s, i) => s + (Number(i.amount_total) || 0), 0)),
              unpaid: money(invoices.reduce((s, i) => s + (Number(i.amount_residual) || 0), 0)),
              overdue: invoices.filter((i) => Number(i.amount_residual) > 0 && String(i.invoice_date_due) < today).map(compact),
              activities: activities.map(compact),
            };
          }
          case "create": {
            if (!a.values?.name) throw new Error("values.name is required");
            return { created: first(await odoo<number[] | number>("res.partner", "create", { vals_list: [await resolveVals("res.partner", a.values)] })) };
          }
          case "update":
            if (!a.id || !a.values) throw new Error("id and values are required");
            await odoo("res.partner", "write", { vals: await resolveVals("res.partner", a.values) }, [a.id]);
            return { updated: a.id };
        }
      }),
  );

  server.registerTool(
    "odoo_sales",
    {
      title: "Quotations & sales orders",
      description:
        "Sales: list quotations/orders (by state, customer, salesperson, period), read one with its lines, create a quotation (customer, products by name/reference, quantities, prices, discounts, expiry, linked opportunity), confirm it into an order or cancel (confirm), and a sales report by salesperson, customer and product for a period.",
      inputSchema: {
        action: z.enum(["list", "get", "quote", "confirm_order", "cancel", "report"]),
        id: z.number().int().optional(),
        state: z.enum(["quotation", "order", "cancelled", "any"]).default("any"),
        customer: z.union([z.string(), z.number()]).optional(),
        salesperson: z.string().optional(),
        preset: PERIOD,
        from: z.string().optional(),
        to: z.string().optional(),
        lines: z.array(LINE).optional(),
        valid_until: z.string().optional(),
        opportunity_id: z.number().int().optional(),
        note: z.string().optional(),
        limit: z.number().int().min(1).max(1000).default(50),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const window = a.preset || a.from ? period(a.preset, a.from, a.to) : undefined;
        switch (a.action) {
          case "list": {
            const domain: Domain = [];
            if (a.state === "quotation") domain.push(["state", "in", ["draft", "sent"]]);
            if (a.state === "order") domain.push(["state", "=", "sale"]);
            if (a.state === "cancelled") domain.push(["state", "=", "cancel"]);
            if (a.customer) domain.push(["partner_id", "child_of", await partnerId(a.customer)]);
            if (a.salesperson) domain.push(["user_id", "=", await userId(a.salesperson)]);
            if (window) domain.push(["date_order", ">=", `${window.from} 00:00:00`], ["date_order", "<=", `${window.to} 23:59:59`]);
            const rows = await odoo<Rec[]>("sale.order", "search_read", { domain, fields: ["name", "partner_id", "state", "date_order", "validity_date", "user_id", "amount_untaxed", "amount_total", "currency_id", "invoice_status"], order: "date_order desc", limit: a.limit });
            return { count: rows.length, total: money(rows.reduce((s, r) => s + (Number(r.amount_total) || 0), 0)), orders: rows.map(compact) };
          }
          case "get": {
            if (!a.id) throw new Error("id is required");
            const [o] = await odoo<Rec[]>("sale.order", "read", { fields: ["name", "partner_id", "state", "date_order", "validity_date", "user_id", "amount_untaxed", "amount_tax", "amount_total", "invoice_status", "opportunity_id", "note"] }, [a.id]);
            const l = await odoo<Rec[]>("sale.order.line", "search_read", { domain: [["order_id", "=", a.id]], fields: ["product_id", "name", "product_uom_qty", "price_unit", "discount", "price_subtotal", "qty_delivered", "qty_invoiced"] });
            return { ...compact(o), lines: l.map(compact) };
          }
          case "quote": {
            if (!a.customer || !a.lines?.length) throw new Error("customer and lines are required");
            const vals: Rec = { partner_id: await partnerId(a.customer), order_line: await lines(a.lines, "product_uom_qty") };
            if (a.valid_until) vals.validity_date = day(a.valid_until);
            if (a.salesperson) vals.user_id = await userId(a.salesperson);
            if (a.opportunity_id) vals.opportunity_id = a.opportunity_id;
            if (a.note) vals.note = a.note;
            const id = first(await odoo<number[] | number>("sale.order", "create", { vals_list: [vals] }));
            const [o] = await odoo<Rec[]>("sale.order", "read", { fields: ["name", "amount_total", "state"] }, [id]);
            return { created: id, ...compact(o), link: `${baseUrl()}/odoo/sales/${id}` };
          }
          case "confirm_order":
          case "cancel":
            if (!a.id) throw new Error("id is required");
            if (!a.confirm) throw new Error(a.action === "cancel" ? "Cancelling the order is visible to the customer; set confirm: true" : "Confirming turns the quotation into a sales order (reserves stock, may trigger delivery/invoicing); set confirm: true");
            await odoo("sale.order", a.action === "cancel" ? "action_cancel" : "action_confirm", {}, [a.id]);
            return { [a.action === "cancel" ? "cancelled" : "confirmed"]: a.id };
          case "report": {
            const w = window ?? period("this_month");
            const rows = await odoo<Rec[]>("sale.order.line", "search_read", {
              domain: [["order_id.state", "=", "sale"], ["order_id.date_order", ">=", `${w.from} 00:00:00`], ["order_id.date_order", "<=", `${w.to} 23:59:59`], ["display_type", "=", false]],
              fields: ["order_id", "product_id", "product_uom_qty", "price_subtotal", "salesman_id", "order_partner_id"],
              limit: 50000,
            });
            const sum = (key: string) => {
              const m = new Map<string, { revenue: number; qty: number; orders: Set<unknown> }>();
              for (const r of rows) {
                const k = m2o(r[key]) ?? "(none)";
                const t = m.get(k) ?? { revenue: 0, qty: 0, orders: new Set() };
                t.revenue += Number(r.price_subtotal) || 0;
                t.qty += Number(r.product_uom_qty) || 0;
                t.orders.add(m2o(r.order_id));
                m.set(k, t);
              }
              return [...m].map(([name, t]) => ({ name, revenue: money(t.revenue), quantity: t.qty, orders: t.orders.size })).sort((x, y) => y.revenue - x.revenue).slice(0, 25);
            };
            const orders = new Set(rows.map((r) => m2o(r.order_id)));
            const revenue = rows.reduce((s, r) => s + (Number(r.price_subtotal) || 0), 0);
            return { window: w, orders: orders.size, revenue_untaxed: money(revenue), average_order: orders.size ? money(revenue / orders.size) : 0, by_salesperson: sum("salesman_id"), by_customer: sum("order_partner_id"), by_product: sum("product_id") };
          }
        }
      }),
  );

  server.registerTool(
    "odoo_invoices",
    {
      title: "Invoices & receivables",
      description:
        "Accounting: list customer invoices, credit notes or vendor bills (draft/posted, unpaid, overdue, by customer or period), receivables aging per customer (current, 1–30, 31–60, 61–90, 90+ days), read one with lines, create a draft invoice (customer, products, quantities, prices), post it (confirm), or create the invoice for a confirmed sales order.",
      inputSchema: {
        action: z.enum(["list", "aging", "get", "create_draft", "post", "invoice_order"]),
        kind: z.enum(["customer_invoice", "credit_note", "vendor_bill"]).default("customer_invoice"),
        status: z.enum(["draft", "posted", "unpaid", "overdue", "paid", "any"]).default("any"),
        customer: z.union([z.string(), z.number()]).optional(),
        id: z.number().int().optional().describe("Invoice id (get/post) or sales order id (invoice_order)"),
        preset: PERIOD,
        from: z.string().optional(),
        to: z.string().optional(),
        lines: z.array(LINE).optional(),
        due_date: z.string().optional(),
        limit: z.number().int().min(1).max(2000).default(50),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const moveType = { customer_invoice: "out_invoice", credit_note: "out_refund", vendor_bill: "in_invoice" }[a.kind];
        const today = ymd(new Date());
        switch (a.action) {
          case "list": {
            const domain: Domain = [["move_type", "=", moveType]];
            if (a.status === "draft") domain.push(["state", "=", "draft"]);
            if (a.status === "posted") domain.push(["state", "=", "posted"]);
            if (a.status === "unpaid" || a.status === "overdue") domain.push(["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]);
            if (a.status === "overdue") domain.push(["invoice_date_due", "<", today]);
            if (a.status === "paid") domain.push(["payment_state", "in", ["paid", "in_payment"]]);
            if (a.customer) domain.push(["partner_id", "child_of", await partnerId(a.customer)]);
            if (a.preset || a.from) {
              const w = period(a.preset, a.from, a.to);
              domain.push(["invoice_date", ">=", w.from], ["invoice_date", "<=", w.to]);
            }
            const rows = await odoo<Rec[]>("account.move", "search_read", { domain, fields: ["name", "partner_id", "invoice_date", "invoice_date_due", "amount_total", "amount_residual", "payment_state", "state", "currency_id", "invoice_origin"], order: "invoice_date_due asc", limit: a.limit });
            return { count: rows.length, total: money(rows.reduce((s, r) => s + (Number(r.amount_total) || 0), 0)), outstanding: money(rows.reduce((s, r) => s + (Number(r.amount_residual) || 0), 0)), invoices: rows.map(compact) };
          }
          case "aging": {
            const rows = await odoo<Rec[]>("account.move", "search_read", { domain: [["move_type", "=", moveType], ["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]], fields: ["partner_id", "invoice_date_due", "amount_residual"], limit: 50000 });
            const buckets = ["current", "1-30", "31-60", "61-90", "90+"] as const;
            const per = new Map<string, Record<string, number>>();
            for (const r of rows) {
              const days = Math.floor((Date.parse(today) - Date.parse(String(r.invoice_date_due))) / 86_400_000);
              const b = days <= 0 ? "current" : days <= 30 ? "1-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
              const name = m2o(r.partner_id) ?? "(none)";
              const t = per.get(name) ?? Object.fromEntries([...buckets, "total"].map((k) => [k, 0]));
              t[b] += Number(r.amount_residual) || 0;
              t.total += Number(r.amount_residual) || 0;
              per.set(name, t);
            }
            const list = [...per].map(([customer, t]) => ({ customer, ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, money(v)])) }) as Record<string, string | number>).sort((x, y) => Number(y.total) - Number(x.total));
            const totals = Object.fromEntries([...buckets, "total"].map((k) => [k, money(list.reduce((s, r) => s + (Number(r[k]) || 0), 0))]));
            return { as_of: today, totals, customers: list };
          }
          case "get": {
            if (!a.id) throw new Error("id is required");
            const [m] = await odoo<Rec[]>("account.move", "read", { fields: ["name", "move_type", "partner_id", "invoice_date", "invoice_date_due", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "state", "invoice_origin", "ref"] }, [a.id]);
            const l = await odoo<Rec[]>("account.move.line", "search_read", { domain: [["move_id", "=", a.id], ["display_type", "=", "product"]], fields: ["product_id", "name", "quantity", "price_unit", "discount", "price_subtotal"] });
            return { ...compact(m), lines: l.map(compact) };
          }
          case "create_draft": {
            if (!a.customer || !a.lines?.length) throw new Error("customer and lines are required");
            const vals: Rec = { move_type: moveType, partner_id: await partnerId(a.customer), invoice_line_ids: await lines(a.lines, "quantity") };
            if (a.due_date) vals.invoice_date_due = day(a.due_date);
            const id = first(await odoo<number[] | number>("account.move", "create", { vals_list: [vals] }));
            const [m] = await odoo<Rec[]>("account.move", "read", { fields: ["name", "amount_total", "state"] }, [id]);
            return { created: id, ...compact(m), note: "Draft — post it with action post (confirm: true)." };
          }
          case "post":
            if (!a.id) throw new Error("id is required");
            if (!a.confirm) throw new Error("Posting gives the invoice its number and books it in accounting; set confirm: true");
            await odoo("account.move", "action_post", {}, [a.id]);
            return { posted: a.id };
          case "invoice_order": {
            if (!a.id) throw new Error("id (the confirmed sales order) is required");
            if (!a.confirm) throw new Error("This creates a draft invoice from the sales order; set confirm: true");
            const context = { active_model: "sale.order", active_ids: [a.id], active_id: a.id };
            const w = first(await odoo<number[] | number>("sale.advance.payment.inv", "create", { vals_list: [{ advance_payment_method: "delivered" }], context }));
            await odoo("sale.advance.payment.inv", "create_invoices", { context }, [w]);
            const [order] = await odoo<Rec[]>("sale.order", "read", { fields: ["name", "invoice_ids"] }, [a.id]);
            const ids = (order.invoice_ids as number[]) ?? [];
            const created = ids.length ? await odoo<Rec[]>("account.move", "read", { fields: ["name", "state", "amount_total", "invoice_date_due"] }, ids) : [];
            return { order: order.name, invoices: created.map(compact), note: "New invoices are drafts — post with action post." };
          }
        }
      }),
  );

  server.registerTool(
    "odoo_health",
    {
      title: "Connection check",
      description: "Check the connection: Odoo version, API protocol in use (JSON-2 or JSON-RPC), database, your user and company, and which business apps are installed (CRM, Sales, Invoicing…).",
      inputSchema: {},
    },
    () =>
      run(async () => {
        const [v, proto] = await Promise.all([version().catch(() => ({})), detectProtocol()]);
        const user = await me();
        const apps = await odoo<Rec[]>("ir.module.module", "search_read", { domain: [["state", "=", "installed"], ["application", "=", true]], fields: ["shortdesc"] }).catch(() => [] as Rec[]);
        return { url: baseUrl(), version: (v as Rec).server_version, protocol: proto, database: database() ?? "(single database)", user, apps: apps.map((x) => x.shortdesc) };
      }),
  );
}
