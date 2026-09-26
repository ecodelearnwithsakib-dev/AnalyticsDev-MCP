#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { PRESETS, round, window } from "../shared/hub.js";
import { restClient } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/** Shopify Admin GraphQL API with an Admin API access token (custom app or Dev Dashboard app). */
const shop = () => requireEnv("SHOPIFY_STORE").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/(\.myshopify\.com)?$/, ".myshopify.com");
const api = restClient({ name: "Shopify", base: () => optionalEnv("SHOPIFY_API_BASE", `https://${shop()}/admin/api/${optionalEnv("SHOPIFY_API_VERSION", "2026-07")}`), headers: () => ({ "X-Shopify-Access-Token": requireEnv("SHOPIFY_ACCESS_TOKEN") }), hints: { 401: "check SHOPIFY_ACCESS_TOKEN", 403: "the app is missing an access scope (e.g. read_orders, read_all_orders for >60 days)" } });

type Rec = Record<string, unknown>;
async function gql<T = Rec>(query: string, variables: Rec = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = (await api("graphql.json", { body: { query, variables } })) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    if (r.errors?.some((e) => e.extensions?.code === "THROTTLED") && attempt < 5) {
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      continue;
    }
    if (r.errors?.length) throw new Error(`Shopify: ${r.errors.map((e) => e.message).join("; ")}`);
    return r.data as T;
  }
}
const money = (m: unknown) => Number(((m as Rec)?.shopMoney as Rec)?.amount ?? 0);

const ORDER_FIELDS = `id name createdAt displayFinancialStatus displayFulfillmentStatus sourceName
  currentTotalPriceSet { shopMoney { amount currencyCode } } totalRefundedSet { shopMoney { amount } } currentSubtotalPriceSet { shopMoney { amount } } totalDiscountsSet { shopMoney { amount } }
  customer { id numberOfOrders } channelInformation { channelDefinition { channelName } }
  customerJourneySummary { firstVisit { source utmParameters { source medium campaign } } lastVisit { source utmParameters { source medium campaign } } }
  lineItems(first: 50) { edges { node { title quantity originalTotalSet { shopMoney { amount } } product { id } } } }`;

async function orders(search: string, max: number): Promise<Rec[]> {
  const out: Rec[] = [];
  let after: string | null = null;
  do {
    const d: { orders: { edges: { node: Rec }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await gql(`query($q:String,$after:String){ orders(first:100, query:$q, after:$after, sortKey:CREATED_AT) { edges { node { ${ORDER_FIELDS} } } pageInfo { hasNextPage endCursor } } }`, { q: search, after });
    out.push(...d.orders.edges.map((e) => e.node));
    after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (after && out.length < max);
  return out.slice(0, max);
}

const server = new McpServer(
  { name: "shopify", version: "0.1.0" },
  { instructions: "Shopify store via the Admin GraphQL API: shop info, true sales (revenue net of refunds, orders, AOV, new vs returning, by day/channel/UTM source/product), orders, products and inventory, customers, discount codes, and raw GraphQL. Mutations need confirm. Orders older than 60 days need the read_all_orders scope." },
);

server.registerTool(
  "shopify_shop",
  { title: "Shop info", description: "Store name, domain, currency, timezone, plan and contact email.", inputSchema: {} },
  () => run(async () => (await gql<{ shop: Rec }>("{ shop { name myshopifyDomain primaryDomain { url } currencyCode ianaTimezone plan { displayName } email } }")).shop),
);

server.registerTool(
  "shopify_sales_report",
  {
    title: "Sales report",
    description: "Real store sales for a period: gross and net revenue (after refunds), orders, AOV, discounts, new vs returning customers, and breakdowns by day, sales channel, first/last-visit UTM source/medium/campaign and top products — the ground truth to compare ad platforms against.",
    inputSchema: { preset: z.enum(PRESETS).optional(), from: z.string().optional(), to: z.string().optional(), attribution: z.enum(["last_visit", "first_visit"]).default("last_visit"), top: z.number().int().min(1).max(100).default(10), max_orders: z.number().int().min(100).max(50000).default(10000) },
  },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const tz = (await gql<{ shop: { currencyCode: string; ianaTimezone: string } }>("{ shop { currencyCode ianaTimezone } }")).shop;
      const list = await orders(`created_at:>=${w.from} created_at:<=${w.to}T23:59:59 -status:cancelled -test:true`, a.max_orders);
      const byDay: Record<string, { orders: number; revenue: number }> = {};
      const byChannel: Record<string, { orders: number; revenue: number }> = {};
      const bySource: Record<string, { orders: number; revenue: number }> = {};
      const products: Record<string, { quantity: number; revenue: number }> = {};
      let gross = 0, refunds = 0, discounts = 0, newC = 0;
      for (const o of list) {
        const total = money(o.currentTotalPriceSet);
        const refunded = money(o.totalRefundedSet);
        gross += total + refunded;
        refunds += refunded;
        discounts += money(o.totalDiscountsSet);
        if (Number((o.customer as Rec)?.numberOfOrders ?? 1) <= 1) newC++;
        const day = String(o.createdAt).slice(0, 10);
        (byDay[day] ??= { orders: 0, revenue: 0 }).orders++;
        byDay[day].revenue += total;
        const ch = String(((o.channelInformation as Rec)?.channelDefinition as Rec)?.channelName ?? o.sourceName ?? "unknown");
        (byChannel[ch] ??= { orders: 0, revenue: 0 }).orders++;
        byChannel[ch].revenue += total;
        const visit = ((o.customerJourneySummary as Rec)?.[a.attribution === "first_visit" ? "firstVisit" : "lastVisit"] ?? {}) as Rec;
        const utm = (visit.utmParameters ?? {}) as Rec;
        const src = utm.source ? `${utm.source} / ${utm.medium ?? "(none)"}` : String(visit.source ?? "(direct / unknown)");
        (bySource[src] ??= { orders: 0, revenue: 0 }).orders++;
        bySource[src].revenue += total;
        for (const e of ((o.lineItems as Rec)?.edges as { node: Rec }[]) ?? []) {
          const t = String(e.node.title);
          (products[t] ??= { quantity: 0, revenue: 0 }).quantity += Number(e.node.quantity ?? 0);
          products[t].revenue += money(e.node.originalTotalSet);
        }
      }
      const net = gross - refunds;
      const sortMap = (m: Record<string, { revenue: number }>, n?: number) => Object.entries(m).map(([k, v]) => ({ key: k, ...v, revenue: round(v.revenue) })).sort((x, y) => y.revenue - x.revenue).slice(0, n);
      return {
        window: w,
        currency: tz.currencyCode,
        timezone: tz.ianaTimezone,
        orders: list.length,
        revenue: round(net),
        gross_revenue: round(gross),
        refunds: round(refunds),
        discounts: round(discounts),
        aov: list.length ? round(net / list.length) : 0,
        new_customers: newC,
        returning_customers: list.length - newC,
        by_day: Object.entries(byDay).sort().map(([d, v]) => ({ date: d, orders: v.orders, revenue: round(v.revenue) })),
        by_channel: sortMap(byChannel),
        by_source: sortMap(bySource, a.top),
        top_products: sortMap(products, a.top),
        truncated: list.length >= a.max_orders || undefined,
      };
    }),
);

server.registerTool(
  "shopify_orders",
  { title: "Orders", description: "Search orders with Shopify search syntax (e.g. \"financial_status:paid created_at:>=2026-09-01\", \"email:karim@x.com\", \"tag:wholesale\") or get one by name/ID with line items, attribution and status.", inputSchema: { query: z.string().optional(), order: z.string().optional().describe("#1001 or gid://shopify/Order/…"), limit: z.number().int().min(1).max(1000).default(50) } },
  (a) =>
    run(async () => {
      const list = await orders(a.order ? (a.order.startsWith("gid://") ? `id:${a.order.split("/").pop()}` : `name:${a.order.replace(/^#?/, "#")}`) : a.query ?? "", a.limit);
      return list.map((o) => ({ id: o.id, name: o.name, created: o.createdAt, financial: o.displayFinancialStatus, fulfillment: o.displayFulfillmentStatus, total: money(o.currentTotalPriceSet), currency: ((o.currentTotalPriceSet as Rec)?.shopMoney as Rec)?.currencyCode, refunded: money(o.totalRefundedSet), channel: ((o.channelInformation as Rec)?.channelDefinition as Rec)?.channelName, last_visit: (o.customerJourneySummary as Rec)?.lastVisit, items: (((o.lineItems as Rec)?.edges as { node: Rec }[]) ?? []).map((e) => `${e.node.quantity}× ${e.node.title}`) }));
    }),
);

server.registerTool(
  "shopify_products",
  {
    title: "Products & inventory",
    description: "Search products (title, status, vendor, type, tags) with variants, prices, SKUs and inventory; update variant prices (confirm) or set available inventory at a location (confirm).",
    inputSchema: {
      action: z.enum(["search", "update_prices", "set_inventory"]).default("search"),
      query: z.string().optional().describe("Shopify product search, e.g. \"status:active vendor:Acme\""),
      limit: z.number().int().min(1).max(250).default(50),
      product_id: z.string().optional(),
      variants: z.array(z.object({ id: z.string(), price: z.number().optional(), compare_at_price: z.number().optional() })).optional(),
      inventory: z.array(z.object({ inventory_item_id: z.string(), location_id: z.string(), quantity: z.number().int() })).optional(),
      confirm: z.boolean().default(false),
    },
  },
  (a) =>
    run(async () => {
      if (a.action === "search") {
        const d = await gql<{ products: { edges: { node: Rec }[] } }>(`query($q:String,$n:Int){ products(first:$n, query:$q) { edges { node { id title status vendor productType tags totalInventory onlineStoreUrl variants(first:50) { edges { node { id title sku price compareAtPrice inventoryQuantity inventoryItem { id } } } } } } } }`, { q: a.query, n: a.limit });
        return d.products.edges.map((e) => ({ ...e.node, variants: ((e.node.variants as Rec).edges as { node: Rec }[]).map((v) => v.node) }));
      }
      if (!a.confirm) throw new Error("Changing live prices/inventory; set confirm: true");
      if (a.action === "update_prices") {
        if (!a.product_id || !a.variants?.length) throw new Error("product_id and variants are required");
        return gql(`mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$p, variants:$v) { productVariants { id price compareAtPrice } userErrors { field message } } }`, { p: a.product_id, v: a.variants.map((v) => ({ id: v.id, price: v.price !== undefined ? String(v.price) : undefined, compareAtPrice: v.compare_at_price !== undefined ? String(v.compare_at_price) : undefined })) });
      }
      if (!a.inventory?.length) throw new Error("inventory is required");
      return gql(`mutation($i:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$i) { inventoryAdjustmentGroup { reason } userErrors { field message } } }`, { i: { name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: a.inventory.map((q) => ({ inventoryItemId: q.inventory_item_id, locationId: q.location_id, quantity: q.quantity })) } });
    }),
);

server.registerTool(
  "shopify_customers",
  { title: "Customers", description: "Search customers (email, name, tag, orders_count:>2, total_spent:>500) with orders count, amount spent, marketing consent and tags.", inputSchema: { query: z.string(), limit: z.number().int().min(1).max(250).default(50) } },
  (a) =>
    run(async () => {
      const d = await gql<{ customers: { edges: { node: Rec }[] } }>(`query($q:String,$n:Int){ customers(first:$n, query:$q) { edges { node { id displayName email phone numberOfOrders amountSpent { amount currencyCode } tags createdAt emailMarketingConsent { marketingState } } } } }`, { q: a.query, n: a.limit });
      return d.customers.edges.map((e) => e.node);
    }),
);

server.registerTool(
  "shopify_discounts",
  { title: "Discount codes", description: "Create a percentage or fixed-amount discount code (with start/end dates, usage limit, minimum subtotal) — needs confirm.", inputSchema: { code: z.string(), percent: z.number().min(1).max(100).optional(), amount: z.number().optional(), starts: z.string().optional(), ends: z.string().optional(), usage_limit: z.number().int().optional(), once_per_customer: z.boolean().default(true), min_subtotal: z.number().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (!a.percent && !a.amount) throw new Error("percent or amount is required");
      if (!a.confirm) return { preview: true, code: a.code, value: a.percent ? `${a.percent}%` : a.amount, note: "Pass confirm: true to create" };
      return gql(`mutation($d:DiscountCodeBasicInput!){ discountCodeBasicCreate(basicCodeDiscount:$d) { codeDiscountNode { id } userErrors { field message } } }`, {
        d: {
          title: a.code,
          code: a.code,
          startsAt: a.starts ? new Date(a.starts).toISOString() : new Date().toISOString(),
          endsAt: a.ends ? new Date(a.ends).toISOString() : undefined,
          usageLimit: a.usage_limit,
          appliesOncePerCustomer: a.once_per_customer,
          customerSelection: { all: true },
          customerGets: { items: { all: true }, value: a.percent ? { percentage: a.percent / 100 } : { discountAmount: { amount: String(a.amount), appliesOnEachItem: false } } },
          minimumRequirement: a.min_subtotal ? { subtotal: { greaterThanOrEqualToSubtotal: String(a.min_subtotal) } } : undefined,
        },
      });
    }),
);

server.registerTool(
  "shopify_graphql",
  { title: "Shopify GraphQL", description: "Run any Admin GraphQL query or mutation (mutations need confirm).", inputSchema: { query: z.string(), variables: z.record(z.unknown()).optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (/^\s*mutation/i.test(a.query) && !a.confirm) throw new Error("Mutations change the store; set confirm: true");
      return gql(a.query, a.variables);
    }),
);

await startStdio(server, "shopify");
