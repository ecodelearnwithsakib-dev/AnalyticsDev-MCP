#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { googleClient, googleRequest, PROFILES } from "../shared/google-auth.js";
import { PRESETS, round, window } from "../shared/hub.js";
import { run, startStdio } from "../shared/server.js";

/** Google Merchant API v1 (the Content API for Shopping successor). */
const getClient = googleClient(PROFILES.merchant);
const BASE = "https://merchantapi.googleapis.com";
type Method = "GET" | "POST" | "PATCH" | "DELETE";
const mc = (method: Method, path: string, data?: unknown, params?: Record<string, unknown>) => googleRequest(getClient, { method, url: `${BASE}/${path.replace(/^\/+/, "")}`, data, params });
const account = (id?: string) => (id ?? requireEnv("MERCHANT_ACCOUNT_ID")).replace(/^accounts\//, "");

type Rec = Record<string, unknown>;
async function listAll(path: string, key: string, params: Rec = {}, max = 5000): Promise<Rec[]> {
  const out: Rec[] = [];
  let pageToken: string | undefined;
  do {
    const res = (await mc("GET", path, undefined, { ...params, pageSize: 1000, pageToken })) as Rec;
    out.push(...((res[key] as Rec[]) ?? []));
    pageToken = res.nextPageToken as string | undefined;
  } while (pageToken && out.length < max);
  return out.slice(0, max);
}

const server = new McpServer(
  { name: "merchant-center", version: "0.1.0" },
  { instructions: "Google Merchant Center via the Merchant API v1: product statuses and disapprovals, account issues, performance reports (MCQL), product inserts/updates (price, availability) and data sources. Money in reports is in the account currency." },
);

const ACC = z.string().optional().describe("Merchant Center account ID; defaults to MERCHANT_ACCOUNT_ID");

server.registerTool(
  "merchant_products",
  {
    title: "Products & their status",
    description:
      "List products with approval status per destination (Shopping ads, free listings), disapproval reasons and item-level issues; filter to only disapproved/limited items, or get one product. Summarises issue counts so you can fix the biggest problems first.",
    inputSchema: { account_id: ACC, only_problems: z.boolean().default(false), product: z.string().optional().describe("Product name (accounts/…/products/…) or offer ID to get one"), limit: z.number().int().min(1).max(20000).default(500) },
  },
  (a) =>
    run(async () => {
      const acc = account(a.account_id);
      if (a.product) {
        const name = a.product.startsWith("accounts/") ? a.product : `accounts/${acc}/products/${encodeURIComponent(a.product)}`;
        return mc("GET", `products/v1/${name}`);
      }
      const items = await listAll(`products/v1/accounts/${acc}/products`, "products", {}, a.limit);
      const issueCounts: Record<string, number> = {};
      const rows = items.map((p) => {
        const status = (p.productStatus ?? {}) as { destinationStatuses?: Rec[]; itemLevelIssues?: Rec[] };
        const issues = (status.itemLevelIssues ?? []).map((i) => `${i.severity}: ${i.description ?? i.code}`);
        for (const i of status.itemLevelIssues ?? []) issueCounts[String(i.description ?? i.code)] = (issueCounts[String(i.description ?? i.code)] ?? 0) + 1;
        const attrs = (p.productAttributes ?? p.attributes ?? {}) as Rec;
        return {
          name: p.name,
          offer_id: p.offerId,
          title: attrs.title,
          price: (attrs.price as Rec)?.amountMicros ? `${Number((attrs.price as Rec).amountMicros) / 1e6} ${(attrs.price as Rec).currencyCode}` : undefined,
          availability: attrs.availability,
          destinations: (status.destinationStatuses ?? []).map((d) => ({ context: d.reportingContext, approved: (d.approvedCountries as string[] | undefined)?.length ?? 0, disapproved: d.disapprovedCountries, pending: d.pendingCountries })),
          issues: issues.length ? issues : undefined,
        };
      });
      const problems = rows.filter((r) => r.issues?.some((i) => /DISAPPROVED|ERROR|CRITICAL/i.test(i)) || r.destinations.some((d) => (d.disapproved as string[] | undefined)?.length));
      return { total: rows.length, with_problems: problems.length, top_issues: Object.entries(issueCounts).sort((x, y) => y[1] - x[1]).slice(0, 15).map(([issue, n]) => ({ issue, products: n })), products: (a.only_problems ? problems : rows).slice(0, a.limit) };
    }),
);

server.registerTool(
  "merchant_account_issues",
  { title: "Account issues", description: "Account-level problems (suspensions, misrepresentation, missing shipping/tax, website claim) with severity, affected countries and how to fix.", inputSchema: { account_id: ACC, language: z.string().default("en") } },
  (a) => run(async () => ((await mc("GET", `accounts/v1/accounts/${account(a.account_id)}/issues`, undefined, { languageCode: a.language, pageSize: 100 })) as Rec).accountIssues ?? []),
);

server.registerTool(
  "merchant_report",
  {
    title: "Performance report",
    description:
      "Shopping/free-listing performance with the Merchant Reports API: clicks, impressions, CTR, conversions and conversion value by product, brand, category, country, marketing method or date; or run your own MCQL query (e.g. price competitiveness, best sellers).",
    inputSchema: {
      account_id: ACC,
      by: z.enum(["offer_id", "brand", "category_l1", "customer_country_code", "marketing_method", "date"]).default("offer_id"),
      preset: z.enum(PRESETS).optional().describe("Default last_30_days"),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().int().min(1).max(5000).default(100),
      mcql: z.string().optional().describe("Custom query, e.g. SELECT offer_id, price_benchmark_price FROM price_competitiveness_product_view"),
    },
  },
  (a) =>
    run(async () => {
      const w = window(a.preset ?? "last_30_days", a.from, a.to);
      const dim = a.by === "offer_id" ? "offer_id, title" : a.by;
      const q = a.mcql ?? `SELECT ${dim}, clicks, impressions, click_through_rate, conversions, conversion_value FROM product_performance_view WHERE date BETWEEN '${w.from}' AND '${w.to}' ORDER BY clicks DESC LIMIT ${a.limit}`;
      const res = (await mc("POST", `reports/v1/accounts/${account(a.account_id)}/reports:search`, { query: q, pageSize: Math.min(a.limit, 1000) })) as { results?: Rec[] };
      const rows = (res.results ?? []).map((r) => {
        const v = (Object.values(r)[0] ?? {}) as Rec;
        const val = v.conversionValue as Rec | undefined;
        return { ...v, conversionValue: val?.amountMicros ? round(Number(val.amountMicros) / 1e6) : v.conversionValue, currency: val?.currencyCode };
      });
      return { window: w, query: q, rows };
    }),
);

const productInput = z.object({
  offer_id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  link: z.string().url().optional(),
  image_link: z.string().url().optional(),
  price: z.number().optional(),
  sale_price: z.number().optional(),
  currency: z.string().length(3).optional(),
  availability: z.enum(["IN_STOCK", "OUT_OF_STOCK", "PREORDER", "BACKORDER"]).optional(),
  brand: z.string().optional(),
  gtin: z.string().optional(),
  condition: z.enum(["NEW", "USED", "REFURBISHED"]).optional(),
  google_product_category: z.string().optional(),
  extra: z.record(z.unknown()).optional().describe("Any other productAttributes fields"),
});

server.registerTool(
  "merchant_update_products",
  {
    title: "Insert or update products",
    description:
      "Insert full products or update only some fields (price, sale price, availability, title…) through a data source (API or supplemental feed). Deletes need confirm. Changes go live after Google reprocesses them (usually minutes).",
    inputSchema: {
      account_id: ACC,
      action: z.enum(["upsert", "update", "delete"]),
      data_source: z.string().optional().describe("Data source name or ID (MERCHANT_DATA_SOURCE); list with merchant_data_sources"),
      content_language: z.string().default("en"),
      feed_label: z.string().optional().describe("e.g. BD or US (MERCHANT_FEED_LABEL)"),
      products: z.array(productInput).min(1).max(500),
      confirm: z.boolean().default(false),
    },
  },
  (a) =>
    run(async () => {
      const acc = account(a.account_id);
      const dsRaw = a.data_source ?? requireEnv("MERCHANT_DATA_SOURCE");
      const ds = dsRaw.startsWith("accounts/") ? dsRaw : `accounts/${acc}/dataSources/${dsRaw}`;
      const label = a.feed_label ?? optionalEnv("MERCHANT_FEED_LABEL", "US");
      if (a.action === "delete" && !a.confirm) throw new Error(`Deleting ${a.products.length} product(s) from Merchant Center; set confirm: true`);
      const results = [];
      for (const p of a.products) {
        const name = `accounts/${acc}/productInputs/${encodeURIComponent(`${a.content_language}~${label}~${p.offer_id}`)}`;
        const money = (v?: number) => (v === undefined ? undefined : { amountMicros: String(Math.round(v * 1e6)), currencyCode: (p.currency ?? optionalEnv("MERCHANT_CURRENCY", "USD")).toUpperCase() });
        const attrs: Rec = { title: p.title, description: p.description, link: p.link, imageLink: p.image_link, price: money(p.price), salePrice: money(p.sale_price), availability: p.availability, brand: p.brand, gtins: p.gtin ? [p.gtin] : undefined, condition: p.condition, googleProductCategory: p.google_product_category, ...p.extra };
        const clean = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined));
        try {
          if (a.action === "delete") await mc("DELETE", `products/v1/${name}`, undefined, { dataSource: ds });
          else if (a.action === "update") await mc("PATCH", `products/v1/${name}`, { productAttributes: clean }, { dataSource: ds, updateMask: Object.keys(clean).map((k) => `product_attributes.${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`).join(",") });
          else await mc("POST", `products/v1/accounts/${acc}/productInputs:insert`, { offerId: p.offer_id, contentLanguage: a.content_language, feedLabel: label, productAttributes: clean }, { dataSource: ds });
          results.push({ offer_id: p.offer_id, ok: true });
        } catch (e) {
          results.push({ offer_id: p.offer_id, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { action: a.action, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) };
    }),
);

server.registerTool(
  "merchant_data_sources",
  { title: "Data sources", description: "List the account's data sources (primary feeds, API sources, supplemental feeds, promotions) with their type, input and schedule.", inputSchema: { account_id: ACC } },
  (a) => run(async () => (await listAll(`datasources/v1/accounts/${account(a.account_id)}/dataSources`, "dataSources")).map((d) => ({ name: d.name, id: d.dataSourceId, display_name: d.displayName, input: d.input, type: Object.keys(d).find((k) => k.endsWith("DataSource")) }))),
);

server.registerTool(
  "merchant_api",
  { title: "Merchant API call", description: "Call any Merchant API v1 path (e.g. accounts/v1/accounts/{id}/shippingSettings, promotions/v1/accounts/{id}/promotions, inventories/v1/…).", inputSchema: { method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"), path: z.string(), body: z.unknown().optional(), params: z.record(z.unknown()).optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method === "DELETE" && !a.confirm) throw new Error("DELETE calls need confirm: true");
      return mc(a.method, a.path.replace("{id}", account()), a.body, a.params);
    }),
);

await startStdio(server, "merchant-center");
