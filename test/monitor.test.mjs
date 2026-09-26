import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { test } from "node:test";
import { call, connect, mockApi } from "./helpers.mjs";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n) => ymd(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - n));

async function setup() {
  const daily = [];
  for (let i = 15; i >= 2; i--) daily.push({ date: daysAgo(i), impressions: 10000, clicks: 200, spend: 100_000_000, key_conversion_total_count: 5, conversion_purchase_total_value: 50000 });
  daily.push({ date: daysAgo(1), impressions: 30000, clicks: 600, spend: 300_000_000, key_conversion_total_count: 0, conversion_purchase_total_value: 0 });
  const api = await mockApi({
    "POST /token": { access_token: "AT", expires_in: 3600 },
    "GET /ads/ad_accounts/t2_acc": { data: { currency: "USD" } },
    "GET /ads/ad_accounts/t2_acc/campaigns": { data: [{ id: "c1", name: "Prospecting" }], pagination: {} },
    "POST /ads/ad_accounts/t2_acc/reports": (_r, body) => {
      const b = JSON.parse(body).data;
      if (b.breakdowns.includes("DATE")) return { data: { metrics: daily.filter((d) => d.date >= b.starts_at.slice(0, 10) && d.date < b.ends_at.slice(0, 10)) }, pagination: {} };
      return { data: { metrics: [{ campaign_id: "c1", impressions: 50000, clicks: 1000, spend: 700_000_000, key_conversion_total_count: 20, conversion_purchase_total_value: 200000 }] }, pagination: {} };
    },
  });
  const env = { REDDIT_CLIENT_ID: "c", REDDIT_CLIENT_SECRET: "s", REDDIT_REFRESH_TOKEN: "r", REDDIT_AD_ACCOUNT_ID: "t2_acc", REDDIT_TOKEN_URL: `${api.url}/token`, REDDIT_ADS_API_BASE: `${api.url}/ads`, META_ACCESS_TOKEN: "", GOOGLE_ADS_DEVELOPER_TOKEN: "", MSADS_DEVELOPER_TOKEN: "", OPENAI_ADS_API_KEY: "", GA4_PROPERTY_ID: "", MCP_PROFILE: "test-mon" };
  return { api, client: await connect("monitor", env) };
}

test("monitor: flags a spend spike with zero conversions", { timeout: 60_000 }, async () => {
  const { api, client } = await setup();
  try {
    const r = await call(client, "monitor_check", { slack_channel: "#alerts" });
    assert.equal(r.isError, false, r.text);
    const metrics = r.data.alerts.map((a) => `${a.severity}:${a.metric}`);
    assert.ok(metrics.includes("high:spend"), metrics.join());
    assert.ok(metrics.includes("critical:conversions"), metrics.join());
    assert.match(r.data.message, /zero conversions/);
    assert.equal(r.data.slack.preview, true);
  } finally {
    await client.close();
    api.close();
  }
});

test("monitor: report markdown and schedule file", { timeout: 60_000 }, async () => {
  const { api, client } = await setup();
  try {
    const r = await call(client, "monitor_report", { preset: "last_7_days" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.data.markdown, /## By platform/);
    assert.match(r.data.markdown, /Prospecting/);
    const s = await call(client, "monitor_schedule", { job: "check", when: "daily 09:15", slack_channel: "#alerts" });
    assert.equal(s.isError, false, s.text);
    assert.ok(existsSync(s.data.written));
    assert.match(s.data.cron_alternative, /^15 9 \* \* \* /);
    rmSync(s.data.written, { force: true });
  } finally {
    await client.close();
    api.close();
  }
});
