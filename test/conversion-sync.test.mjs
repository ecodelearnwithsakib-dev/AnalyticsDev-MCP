import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { call, connect, mockApi } from "./helpers.mjs";

test("conversion-sync: Pipedrive won deal → Reddit, test mode, real send once", { timeout: 90_000 }, async () => {
  const H = "b".repeat(40);
  const wonAt = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const api = await mockApi({
    "GET /pd/api/v2/deals": (_r, _b, url) => (url.searchParams.get("status") === "won" ? { success: true, data: [{ id: 77, title: "Acme renewal", value: 900, currency: "USD", status: "won", person_id: 5, won_time: wonAt, stage_id: 1, pipeline_id: 1, owner_id: 1, custom_fields: { [H]: "rdt-click-abc" } }], additional_data: {} } : { success: true, data: [], additional_data: {} }),
    "GET /pd/api/v2/persons/5": { success: true, data: { id: 5, name: "Karim", emails: [{ value: "karim@acme.test", primary: true }], phones: [] } },
    "GET /pd/v1/dealFields": { success: true, data: [{ key: H, name: "Reddit click id", field_type: "varchar" }], additional_data: { pagination: {} } },
    "GET /pd/v1/personFields": { success: true, data: [], additional_data: { pagination: {} } },
    "GET /pd/v1/users": { success: true, data: [{ id: 1, name: "Me", email: "me@x" }] },
    "GET /pd/api/v2/pipelines": { success: true, data: [{ id: 1, name: "Sales" }] },
    "GET /pd/api/v2/stages": { success: true, data: [{ id: 1, name: "Won", pipeline_id: 1 }], additional_data: {} },
    "POST /rd/token": { access_token: "AT", expires_in: 3600 },
    "POST /rd/ads/pixels/px/conversion_events": { ok: true },
  });
  const env = {
    MCP_PROFILE: "test-sync",
    PIPEDRIVE_API_TOKEN: "t", PIPEDRIVE_DOMAIN: "x", PIPEDRIVE_API_BASE: `${api.url}/pd`,
    REDDIT_CLIENT_ID: "c", REDDIT_CLIENT_SECRET: "s", REDDIT_REFRESH_TOKEN: "r", REDDIT_PIXEL_ID: "px", REDDIT_TOKEN_URL: `${api.url}/rd/token`, REDDIT_ADS_API_BASE: `${api.url}/rd/ads`,
    SF_CLIENT_ID: "", GHL_API_TOKEN: "", ZOHO_REFRESH_TOKEN: "", ODOO_URL: "", HUBSPOT_ACCESS_TOKEN: "",
    GOOGLE_ADS_DEVELOPER_TOKEN: "", META_ACCESS_TOKEN: "", MSADS_DEVELOPER_TOKEN: "", OPENAI_ADS_CONVERSIONS_API_KEY: "", LINKEDIN_ACCESS_TOKEN: "",
  };
  const client = await connect("conversion-sync", env);
  const stateFile = new URL("../.state/conversion-sync.test-sync.json", import.meta.url).pathname;
  rmSync(stateFile, { force: true });
  try {
    const preview = await call(client, "sync_preview", { preset: "last_7_days" });
    assert.equal(preview.isError, false, preview.text);
    assert.equal(preview.data.deals, 1);
    assert.deepEqual(preview.data.rows[0].identifiers.sort(), ["email", "rdt_cid"]);
    assert.equal(preview.data.rows[0].destinations.reddit, "will send");

    const refused = await call(client, "sync_run", { test: false });
    assert.ok(refused.isError);

    const testRun = await call(client, "sync_run", { reddit_test_id: "t2_test" });
    assert.equal(testRun.data.results.reddit.sent, 1);
    const sentTest = JSON.parse(api.log.find((l) => l.path.endsWith("conversion_events")).body);
    assert.equal(sentTest.data.test_id, "t2_test");
    assert.equal(sentTest.data.events[0].click_id, "rdt-click-abc");
    assert.equal(sentTest.data.events[0].metadata.conversion_id, "pipedrive-77");

    const real = await call(client, "sync_run", { test: false, confirm: true });
    assert.equal(real.data.results.reddit.sent, 1);
    const again = await call(client, "sync_run", { test: false, confirm: true });
    assert.equal(again.data.results.reddit.note, "nothing new to send");
    const hist = await call(client, "sync_history", {});
    assert.equal(hist.data.totals.reddit.count, 1);
  } finally {
    await client.close();
    api.close();
    rmSync(stateFile, { force: true });
  }
});
