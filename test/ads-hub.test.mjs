import assert from "node:assert/strict";
import { test } from "node:test";
import { call, connect, mockApi } from "./helpers.mjs";

/** Reddit (USD, micros) and OpenAI Ads (BDT) mocked; FX fixed so no network is used. */
async function setup() {
  const api = await mockApi({
    "POST /token": { access_token: "AT", expires_in: 3600 },
    "GET /ads/ad_accounts/t2_acc": { data: { id: "t2_acc", currency: "USD" } },
    "GET /ads/ad_accounts/t2_acc/campaigns": { data: [{ id: "c1", name: "Reddit prospecting" }, { id: "c2", name: "Reddit retarget" }], pagination: {} },
    "POST /ads/ad_accounts/t2_acc/reports": {
      data: { metrics: [{ campaign_id: "c1", impressions: 10000, clicks: 200, spend: 120_000_000, key_conversion_total_count: 0 }, { campaign_id: "c2", impressions: 5000, clicks: 100, spend: 50_000_000, key_conversion_total_count: 5, conversion_purchase_total_value: 30000 }] },
      pagination: {},
    },
    "PATCH /ads/campaigns/c1": { data: { id: "c1", configured_status: "PAUSED" } },
    "GET /oai/ad_account": { currency_code: "BDT" },
    "GET /oai/ad_account/insights": { data: [{ campaign_id: "o1", campaign_name: "ChatGPT launch", spend: 12000, impressions: 8000, clicks: 160 }], has_more: false },
    "POST /oai/conversions/insights": { data: [{ entity_id: "o1", conversions: 6 }] },
  });
  const env = {
    REDDIT_CLIENT_ID: "c", REDDIT_CLIENT_SECRET: "s", REDDIT_REFRESH_TOKEN: "r", REDDIT_AD_ACCOUNT_ID: "t2_acc",
    REDDIT_TOKEN_URL: `${api.url}/token`, REDDIT_ADS_API_BASE: `${api.url}/ads`,
    OPENAI_ADS_API_KEY: "k", OPENAI_ADS_API_BASE: `${api.url}/oai`,
    FX_RATES: "USD:BDT=120",
    META_ACCESS_TOKEN: "", GOOGLE_ADS_DEVELOPER_TOKEN: "", MSADS_DEVELOPER_TOKEN: "",
  };
  return { api, client: await connect("ads-hub", env) };
}

test("ads-hub: blended report in one currency", { timeout: 60_000 }, async () => {
  const { api, client } = await setup();
  try {
    const r = await call(client, "ads_report", { currency: "BDT", compare: false });
    assert.equal(r.isError, false, r.text);
    const { blended, platforms, top_campaigns } = r.data;
    assert.equal(blended.spend, 170 * 120 + 12000); // Reddit $170 → 20,400 BDT, + OpenAI 12,000 BDT
    assert.equal(blended.conversions, 11);
    assert.deepEqual(platforms.map((p) => p.platform).sort(), ["openai", "reddit"]);
    assert.equal(top_campaigns[0].name, "Reddit prospecting");
    assert.equal(top_campaigns.find((c) => c.name === "Reddit retarget").value, 300 * 120);
  } finally {
    await client.close();
    api.close();
  }
});

test("ads-hub: rules dry-run, then pause with confirm", { timeout: 60_000 }, async () => {
  const { api, client } = await setup();
  try {
    const rules = [{ name: "No conversions", when: [{ metric: "spend", op: ">", value: 1000 }, { metric: "conversions", op: "==", value: 0 }], action: "pause" }];
    const dry = await call(client, "ads_rules", { rules, currency: "BDT" });
    assert.equal(dry.data.dry_run, true);
    assert.deepEqual(dry.data.would_pause, ["reddit: Reddit prospecting", "openai: ChatGPT launch"].filter((x) => dry.data.would_pause.includes(x)));
    assert.ok(!api.log.some((l) => l.method === "PATCH"));
    const refused = await call(client, "ads_rules", { rules, currency: "BDT", apply: true, platforms: ["reddit"] });
    assert.ok(refused.isError);
    const done = await call(client, "ads_rules", { rules, currency: "BDT", apply: true, confirm: true, platforms: ["reddit"] });
    assert.equal(done.isError, false, done.text);
    assert.ok(api.log.some((l) => l.method === "PATCH" && l.path === "/ads/campaigns/c1"));
  } finally {
    await client.close();
    api.close();
  }
});

test("ads-hub: pacing against a monthly budget", { timeout: 60_000 }, async () => {
  const { api, client } = await setup();
  try {
    const r = await call(client, "ads_pacing", { currency: "BDT", budgets: { reddit: 100000, openai: 50000 } });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.data.platforms.every((p) => ["on pace", "over pace", "under pace"].includes(p.status)));
    assert.equal(r.data.total.budget, 150000);
  } finally {
    await client.close();
    api.close();
  }
});
