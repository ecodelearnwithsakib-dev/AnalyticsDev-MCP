import assert from "node:assert/strict";
import { test } from "node:test";
import { call, connect, mockApi } from "./helpers.mjs";

test("pipedrive: create deal resolves stage, owner, org, person and custom field", { timeout: 30_000 }, async () => {
  const H = "a".repeat(40);
  const api = await mockApi({
    "GET /v1/users/me": { success: true, data: { id: 1, name: "Me", email: "me@x.com" } },
    "GET /v1/users": { success: true, data: [{ id: 1, name: "Me", email: "me@x.com" }, { id: 2, name: "Rahima Khan", email: "r@x.com" }] },
    "GET /api/v2/pipelines": { success: true, data: [{ id: 1, name: "Sales" }] },
    "GET /api/v2/stages": { success: true, data: [{ id: 11, name: "Qualified", pipeline_id: 1 }], additional_data: {} },
    "GET /v1/dealFields": { success: true, data: [{ key: H, name: "Lead Source", field_type: "enum", options: [{ id: 5, label: "Facebook" }] }], additional_data: { pagination: {} } },
    "GET /api/v2/organizations/search": { success: true, data: { items: [] } },
    "POST /api/v2/organizations": { success: true, data: { id: 300 } },
    "GET /api/v2/persons/search": { success: true, data: { items: [{ item: { id: 200 } }] } },
    "POST /api/v2/deals": (_r, body) => ({ success: true, data: { id: 900, ...JSON.parse(body), status: "open" } }),
  });
  const client = await connect("pipedrive", { PIPEDRIVE_API_TOKEN: "tok", PIPEDRIVE_DOMAIN: "x", PIPEDRIVE_API_BASE: api.url });
  try {
    const r = await call(client, "pipedrive_deals", { action: "create", deal: { title: "T", value: 10, person: "Karim", organization: "Acme", owner: "rahima", stage: "qualified", custom: { "Lead Source": "facebook" } } });
    assert.equal(r.isError, false, r.text);
    const sent = JSON.parse(api.log.find((l) => l.method === "POST" && l.path === "/api/v2/deals").body);
    assert.deepEqual({ stage: sent.stage_id, owner: sent.owner_id, org: sent.org_id, person: sent.person_id, src: sent.custom_fields[H] }, { stage: 11, owner: 2, org: 300, person: 200, src: 5 });
    assert.equal(api.log[0].headers["x-api-token"], "tok");
  } finally {
    await client.close();
    api.close();
  }
});

test("ghl: messages need confirm and use the conversations API version", { timeout: 30_000 }, async () => {
  const api = await mockApi({ "POST /conversations/messages": { messageId: "m1", conversationId: "c1" } });
  const client = await connect("ghl", { GHL_API_TOKEN: "pit-x", GHL_LOCATION_ID: "L", GHL_API_BASE: api.url });
  try {
    const preview = await call(client, "ghl_conversations", { action: "send", contact_id: "c", message: "hi" });
    assert.equal(preview.data.preview, true);
    assert.equal(api.log.length, 0);
    const sent = await call(client, "ghl_conversations", { action: "send", contact_id: "c", message: "hi", confirm: true });
    assert.equal(sent.data.message_id, "m1");
    assert.equal(api.log[0].headers.version, "2021-04-15");
  } finally {
    await client.close();
    api.close();
  }
});

test("reddit: conversions are hashed and need test_id or confirm", { timeout: 30_000 }, async () => {
  const api = await mockApi({ "POST /token": { access_token: "AT", expires_in: 3600 }, "POST /ads/pixels/px/conversion_events": { ok: true } });
  const client = await connect("reddit", { REDDIT_CLIENT_ID: "c", REDDIT_CLIENT_SECRET: "s", REDDIT_REFRESH_TOKEN: "r", REDDIT_PIXEL_ID: "px", REDDIT_TOKEN_URL: `${api.url}/token`, REDDIT_ADS_API_BASE: `${api.url}/ads` });
  try {
    const blocked = await call(client, "reddit_ads_conversions", { events: [{ type: "PURCHASE", email: "A@B.com" }] });
    assert.ok(blocked.isError);
    const ok = await call(client, "reddit_ads_conversions", { test_id: "t", events: [{ type: "PURCHASE", email: " A@B.com " }] });
    assert.equal(ok.isError, false, ok.text);
    const ev = JSON.parse(api.log.find((l) => l.path.endsWith("conversion_events")).body).data.events[0];
    assert.match(ev.user.email, /^[0-9a-f]{64}$/);
  } finally {
    await client.close();
    api.close();
  }
});

test("matomo: overview compares with the previous period", { timeout: 30_000 }, async () => {
  let n = 0;
  const api = await mockApi({
    "POST /index.php": (_r, body) => {
      const p = new URLSearchParams(body);
      if (p.get("method") === "VisitsSummary.get") return { nb_visits: n++ === 0 ? 150 : 100, nb_uniq_visitors: 90 };
      return {};
    },
  });
  const client = await connect("matomo", { MATOMO_URL: api.url, MATOMO_TOKEN: "t", MATOMO_SITE_ID: "1" });
  try {
    const r = await call(client, "matomo_overview", { preset: "last_7_days" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.kpis.nb_visits, 150);
    assert.equal(r.data.change_pct.nb_visits, 50);
    assert.ok(!api.log[0].query.token_auth, "token must not be in the URL");
  } finally {
    await client.close();
    api.close();
  }
});
