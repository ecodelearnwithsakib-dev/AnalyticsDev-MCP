import assert from "node:assert/strict";
import { test } from "node:test";
import { call, connect, mockApi } from "./helpers.mjs";

const order = (id, day, total, refunded, source, n = 1) => ({
  id: `gid://shopify/Order/${id}`,
  name: `#${id}`,
  createdAt: `${day}T10:00:00Z`,
  currentTotalPriceSet: { shopMoney: { amount: String(total), currencyCode: "USD" } },
  totalRefundedSet: { shopMoney: { amount: String(refunded) } },
  totalDiscountsSet: { shopMoney: { amount: "0" } },
  customer: { id: "c", numberOfOrders: n },
  channelInformation: { channelDefinition: { channelName: "Online Store" } },
  customerJourneySummary: { lastVisit: { source: "google", utmParameters: source ? { source, medium: "cpc" } : null } },
  lineItems: { edges: [{ node: { title: "Shoe", quantity: 1, originalTotalSet: { shopMoney: { amount: String(total + refunded) } } } }] },
});

test("shopify: sales report nets refunds and groups by UTM source", { timeout: 30_000 }, async () => {
  const api = await mockApi({
    "POST /graphql.json": (_r, body) => {
      const q = JSON.parse(body).query;
      if (q.includes("shop {")) return { data: { shop: { currencyCode: "USD", ianaTimezone: "Asia/Dhaka" } } };
      return { data: { orders: { edges: [order(1, "2026-09-01", 100, 0, "facebook"), order(2, "2026-09-02", 50, 25, "google", 3), order(3, "2026-09-02", 30, 0, null)].map((node) => ({ node })), pageInfo: { hasNextPage: false } } } };
    },
  });
  const client = await connect("shopify", { SHOPIFY_STORE: "x", SHOPIFY_ACCESS_TOKEN: "shpat_x", SHOPIFY_API_BASE: api.url });
  try {
    const r = await call(client, "shopify_sales_report", { from: "2026-09-01", to: "2026-09-07" });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual({ orders: r.data.orders, revenue: r.data.revenue, refunds: r.data.refunds, currency: r.data.currency, newC: r.data.new_customers }, { orders: 3, revenue: 180, refunds: 25, currency: "USD", newC: 2 });
    assert.equal(r.data.by_source[0].key, "facebook / cpc");
    assert.equal(r.data.by_day.length, 2);
    assert.equal(api.log[0].headers["x-shopify-access-token"], "shpat_x");
    assert.match(JSON.parse(api.log[1].body).variables.q, /created_at:>=2026-09-01/);
  } finally {
    await client.close();
    api.close();
  }
});

test("woocommerce: sales report uses order attribution and subtracts refunds", { timeout: 30_000 }, async () => {
  const meta = (s, m) => (s ? [{ key: "_wc_order_attribution_utm_source", value: s }, { key: "_wc_order_attribution_utm_medium", value: m }] : [{ key: "_wc_order_attribution_source_type", value: "typein" }]);
  const api = await mockApi({
    "GET /wp-json/wc/v3/orders": [
      200,
      [
        { id: 1, total: "120.00", currency: "BDT", date_created: "2026-09-03T10:00:00", customer_id: 5, billing: {}, refunds: [{ total: "-20.00" }], meta_data: meta("facebook", "paid"), payment_method_title: "bKash", line_items: [{ name: "Tee", quantity: 2, total: "120" }] },
        { id: 2, total: "80.00", currency: "BDT", date_created: "2026-09-04T10:00:00", customer_id: 0, billing: { email: "a@b.c" }, refunds: [], meta_data: meta(), payment_method_title: "COD", line_items: [{ name: "Cap", quantity: 1, total: "80" }] },
      ],
    ],
  });
  const client = await connect("woocommerce", { WOO_URL: api.url, WOO_CONSUMER_KEY: "ck", WOO_CONSUMER_SECRET: "cs" });
  try {
    const r = await call(client, "woo_sales_report", { from: "2026-09-01", to: "2026-09-07" });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual({ orders: r.data.orders, revenue: r.data.revenue, refunds: r.data.refunds, currency: r.data.currency }, { orders: 2, revenue: 180, refunds: 20, currency: "BDT" });
    assert.equal(r.data.by_source[0].key, "facebook / paid");
    assert.equal(r.data.by_source[1].key, "typein");
    assert.equal(api.log[0].query.status, "processing,completed");
    assert.match(api.log[0].headers.authorization, /^Basic /);
  } finally {
    await client.close();
    api.close();
  }
});

test("hubspot: won deals include contact email and click IDs", { timeout: 30_000 }, async () => {
  const api = await mockApi({
    "POST /crm/v3/objects/deals/search": { results: [{ id: "d1", properties: { dealname: "Big", amount: "5000", deal_currency_code: "USD", closedate: "2026-09-02T00:00:00Z" } }] },
    "GET /crm/v4/objects/deals/d1/associations/contacts": { results: [{ toObjectId: 77 }] },
    "GET /crm/v3/objects/contacts/77": { properties: { email: "k@x.com", phone: "+880171", hs_google_click_id: "gclid-1", fbclid: "fb-1" } },
  });
  const client = await connect("hubspot", { HUBSPOT_ACCESS_TOKEN: "pat", HUBSPOT_API_BASE: api.url });
  try {
    const r = await call(client, "hubspot_won_deals", { from: "2026-09-01", to: "2026-09-07" });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.data.deals[0], { id: "d1", name: "Big", amount: 5000, currency: "USD", closed_at: "2026-09-02T00:00:00Z", email: "k@x.com", phone: "+880171", contact_id: 77, gclid: "gclid-1", fbclid: "fb-1" });
    const filters = JSON.parse(api.log[0].body).filterGroups[0].filters;
    assert.ok(filters.some((f) => f.propertyName === "hs_is_closed_won"));
    assert.equal(api.log[0].headers.authorization, "Bearer pat");
  } finally {
    await client.close();
    api.close();
  }
});

test("whatsapp: sends need confirm and airtable writes in batches of 10", { timeout: 30_000 }, async () => {
  const api = await mockApi({
    "POST /v24.0/111/messages": { messages: [{ id: "wamid.1" }] },
    "POST /v0/appX/Leads": (_r, body) => ({ records: JSON.parse(body).records.map((r, i) => ({ id: `rec${i}`, fields: r.fields })) }),
  });
  const wa = await connect("whatsapp", { WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "111" });
  const at = await connect("airtable", { AIRTABLE_TOKEN: "pat", AIRTABLE_BASE_ID: "appX", AIRTABLE_API_BASE: `${api.url}/v0` });
  try {
    const preview = await call(wa, "wa_send", { to: ["+880 1711-000000"], type: "template", template: "order_update", variables: ["Karim"] });
    assert.equal(preview.data.preview, true);
    const w = await call(at, "airtable_write", { table: "Leads", action: "create", records: Array.from({ length: 23 }, (_, i) => ({ fields: { Name: `L${i}` } })) });
    assert.equal(w.isError, false, w.text);
    assert.equal(w.data.count, 23);
    assert.equal(api.log.filter((l) => l.path === "/v0/appX/Leads").length, 3);
    assert.equal(JSON.parse(api.log[0].body).typecast, true);
  } finally {
    await wa.close();
    await at.close();
    api.close();
  }
});

test("playbooks: served as MCP prompts with arguments filled in", { timeout: 30_000 }, async () => {
  const client = await connect("tracking-audit");
  try {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ["pre_launch_tracking_qa", "tracking_health_check"]);
    const r = await client.getPrompt({ name: "tracking_health_check", arguments: { site_url: "https://shop.example" } });
    assert.match(r.messages[0].content.text, /https:\/\/shop\.example/);
    assert.match(r.messages[0].content.text, /audit_full/);
  } finally {
    await client.close();
  }
});

test("cli: runs a server by name and lists servers", { timeout: 30_000 }, async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "t", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("../dist/shared/cli.js", import.meta.url).pathname, "notion"], stderr: "ignore" }));
  try {
    assert.ok((await client.listTools()).tools.some((t) => t.name === "notion_query"));
  } finally {
    await client.close();
  }
});

test("branding: every server reports an Analytics Dev title", { timeout: 30_000 }, async () => {
  for (const dir of ["shopify", "ga4", "stape", "ads-hub"]) {
    const client = await connect(dir);
    try {
      assert.match(client.getServerVersion().title ?? "", /^Analytics Dev · /, dir);
    } finally {
      await client.close();
    }
  }
});
