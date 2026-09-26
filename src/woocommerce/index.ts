#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireEnv } from "../shared/env.js";
import { PRESETS, round, window } from "../shared/hub.js";
import { restClient } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/** WooCommerce REST API v3 with a consumer key/secret (HTTPS basic auth). */
const wc = restClient({
  name: "WooCommerce",
  base: () => `${requireEnv("WOO_URL").replace(/\/+$/, "")}/wp-json/wc/v3`,
  headers: () => ({ Authorization: `Basic ${Buffer.from(`${requireEnv("WOO_CONSUMER_KEY")}:${requireEnv("WOO_CONSUMER_SECRET")}`).toString("base64")}` }),
  hints: { 401: "check WOO_CONSUMER_KEY/SECRET (Read/Write key) and that the site uses HTTPS", 404: "check WOO_URL and that permalinks aren't set to Plain" },
});

type Rec = Record<string, unknown>;
async function all(path: string, query: Rec, max: number): Promise<Rec[]> {
  const out: Rec[] = [];
  for (let page = 1; out.length < max; page++) {
    const r = (await wc(path, { query: { ...(query as Record<string, string>), per_page: 100, page } })) as Rec[];
    out.push(...r);
    if (r.length < 100) break;
  }
  return out.slice(0, max);
}
const meta = (o: Rec, key: string) => ((o.meta_data as { key: string; value: unknown }[]) ?? []).find((m) => m.key === key)?.value as string | undefined;

const server = new McpServer(
  { name: "woocommerce", version: "0.1.0" },
  { instructions: "WooCommerce store via REST API v3: sales report with order attribution (UTM source/medium from WooCommerce's order attribution), orders (status updates and notes need confirm), products (price/stock updates need confirm), customers, coupons and raw API calls." },
);

server.registerTool(
  "woo_store",
  { title: "Store info", description: "Store currency, WooCommerce/WordPress versions, timezone and active plugins count (from system status).", inputSchema: {} },
  () =>
    run(async () => {
      const s = (await wc("system_status")) as Rec;
      const env = (s.environment ?? {}) as Rec;
      const settings = (s.settings ?? {}) as Rec;
      return { url: env.site_url, woocommerce: env.version, wordpress: env.wp_version, currency: settings.currency, currency_symbol: settings.currency_symbol, timezone: (s.environment as Rec)?.default_timezone, active_plugins: ((s.active_plugins as unknown[]) ?? []).length };
    }),
);

server.registerTool(
  "woo_sales_report",
  {
    title: "Sales report",
    description: "Real store sales for a period from paid orders (processing + completed): revenue, orders, AOV, refunds, new vs returning, by day, payment method, order attribution source (utm_source / medium, referral, organic, direct) and top products.",
    inputSchema: { preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), statuses: z.array(z.string()).default(["processing", "completed"]), top: z.number().int().min(1).max(100).default(10), max_orders: z.number().int().min(100).max(50000).default(10000) },
  },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const orders = await all("orders", { after: `${w.from}T00:00:00`, before: `${w.to}T23:59:59`, status: a.statuses.join(",") }, a.max_orders);
      const currency = String(orders[0]?.currency ?? "");
      const bucket = () => ({ orders: 0, revenue: 0 });
      const byDay: Record<string, ReturnType<typeof bucket>> = {};
      const bySource: Record<string, ReturnType<typeof bucket>> = {};
      const byPay: Record<string, ReturnType<typeof bucket>> = {};
      const products: Record<string, { quantity: number; revenue: number }> = {};
      let revenue = 0, refunds = 0, newC = 0;
      const seen = new Set<string>();
      for (const o of orders) {
        const total = Number(o.total ?? 0);
        const refunded = ((o.refunds as { total: string }[]) ?? []).reduce((s, r) => s + Math.abs(Number(r.total ?? 0)), 0);
        revenue += total - refunded;
        refunds += refunded;
        const cust = String(o.customer_id || (o.billing as Rec)?.email || o.id);
        if (!seen.has(cust)) {
          seen.add(cust);
          newC++;
        }
        const day = String(o.date_created).slice(0, 10);
        (byDay[day] ??= bucket()).orders++;
        byDay[day].revenue += total;
        const src = meta(o, "_wc_order_attribution_utm_source") ? `${meta(o, "_wc_order_attribution_utm_source")} / ${meta(o, "_wc_order_attribution_utm_medium") ?? "(none)"}` : meta(o, "_wc_order_attribution_source_type") ?? "(unknown)";
        (bySource[src] ??= bucket()).orders++;
        bySource[src].revenue += total;
        const pay = String(o.payment_method_title || o.payment_method || "unknown");
        (byPay[pay] ??= bucket()).orders++;
        byPay[pay].revenue += total;
        for (const li of (o.line_items as Rec[]) ?? []) {
          const t = String(li.name);
          (products[t] ??= { quantity: 0, revenue: 0 }).quantity += Number(li.quantity ?? 0);
          products[t].revenue += Number(li.total ?? 0);
        }
      }
      const sortMap = (m: Record<string, { revenue: number }>, n?: number) => Object.entries(m).map(([k, v]) => ({ key: k, ...v, revenue: round(v.revenue) })).sort((x, y) => y.revenue - x.revenue).slice(0, n);
      return {
        window: w,
        currency,
        orders: orders.length,
        revenue: round(revenue),
        refunds: round(refunds),
        aov: orders.length ? round(revenue / orders.length) : 0,
        unique_customers: newC,
        by_day: Object.entries(byDay).sort().map(([d, v]) => ({ date: d, orders: v.orders, revenue: round(v.revenue) })),
        by_source: sortMap(bySource, a.top),
        by_payment_method: sortMap(byPay),
        top_products: sortMap(products, a.top),
        note: "Attribution uses WooCommerce order attribution (8.5+). Customers are counted once per email/customer ID within the window.",
      };
    }),
);

server.registerTool(
  "woo_orders",
  { title: "Orders", description: "List/search orders (status, customer, dates, search text), get one with items and attribution, update status (confirm) or add an order note (customer notes are emailed — confirm).", inputSchema: { action: z.enum(["list", "get", "update_status", "add_note"]).default("list"), id: z.number().int().optional(), status: z.string().optional(), search: z.string().optional(), after: z.string().optional(), note: z.string().optional(), customer_note: z.boolean().default(false), limit: z.number().int().min(1).max(1000).default(50), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.action === "list") return (await all("orders", { status: a.status, search: a.search, after: a.after ? `${a.after}T00:00:00` : undefined }, a.limit)).map((o) => ({ id: o.id, number: o.number, status: o.status, date: o.date_created, total: o.total, currency: o.currency, customer: (o.billing as Rec)?.email, source: meta(o, "_wc_order_attribution_utm_source") ?? meta(o, "_wc_order_attribution_source_type"), items: ((o.line_items as Rec[]) ?? []).map((l) => `${l.quantity}× ${l.name}`) }));
      if (!a.id) throw new Error("id is required");
      if (a.action === "get") return wc(`orders/${a.id}`);
      if (!a.confirm) throw new Error(a.action === "update_status" ? "Changing order status may email the customer and adjust stock; set confirm: true" : "Adding a note; set confirm: true");
      if (a.action === "update_status") return wc(`orders/${a.id}`, { method: "PUT", body: { status: a.status } });
      return wc(`orders/${a.id}/notes`, { body: { note: a.note, customer_note: a.customer_note } });
    }),
);

server.registerTool(
  "woo_products",
  { title: "Products", description: "Search products (name, SKU, status, stock) or update price, sale price and stock quantity (confirm).", inputSchema: { action: z.enum(["list", "update"]).default("list"), search: z.string().optional(), sku: z.string().optional(), stock_status: z.enum(["instock", "outofstock", "onbackorder"]).optional(), id: z.number().int().optional(), regular_price: z.number().optional(), sale_price: z.number().optional(), stock_quantity: z.number().int().optional(), limit: z.number().int().min(1).max(1000).default(50), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.action === "list") return (await all("products", { search: a.search, sku: a.sku, stock_status: a.stock_status }, a.limit)).map((p) => ({ id: p.id, name: p.name, sku: p.sku, status: p.status, price: p.price, regular_price: p.regular_price, sale_price: p.sale_price, stock: p.stock_quantity, stock_status: p.stock_status, total_sales: p.total_sales, permalink: p.permalink }));
      if (!a.id) throw new Error("id is required");
      if (!a.confirm) throw new Error("Changing a live product; set confirm: true");
      return wc(`products/${a.id}`, { method: "PUT", body: { regular_price: a.regular_price !== undefined ? String(a.regular_price) : undefined, sale_price: a.sale_price !== undefined ? String(a.sale_price) : undefined, stock_quantity: a.stock_quantity, manage_stock: a.stock_quantity !== undefined ? true : undefined } });
    }),
);

server.registerTool(
  "woo_customers",
  { title: "Customers", description: "Search customers by name or email with orders count and total spent.", inputSchema: { search: z.string().optional(), limit: z.number().int().min(1).max(1000).default(50) } },
  (a) => run(async () => (await all("customers", { search: a.search, role: "all" }, a.limit)).map((c) => ({ id: c.id, name: `${c.first_name} ${c.last_name}`.trim(), email: c.email, orders: c.orders_count, total_spent: c.total_spent, created: c.date_created }))),
);

server.registerTool(
  "woo_api",
  { title: "WooCommerce API call", description: "Call any WooCommerce REST v3 endpoint (coupons, reports/top_sellers, shipping/zones, taxes, webhooks…). Writes need confirm.", inputSchema: { method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method !== "GET" && !a.confirm) throw new Error("Write calls change the store; set confirm: true");
      return wc(a.path, { method: a.method, query: a.query, body: a.body });
    }),
);

await startStdio(server, "woocommerce");
