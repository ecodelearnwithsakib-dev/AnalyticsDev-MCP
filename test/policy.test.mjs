import assert from "node:assert/strict";
import { test } from "node:test";
import { callBlocked, toolVisible } from "../dist/shared/server.js";
import { call, connect, listAll } from "./helpers.mjs";

const ro = { readOnly: true, allow: [], deny: [] };

test("read-only hides write tools and keeps read tools", () => {
  for (const name of ["meta_create_campaign", "gads_update_budget", "gtm_publish_version", "meta_delete_object", "ga4_create_key_event", "meta_graph_request", "pipedrive_api"]) assert.equal(toolVisible(ro, name), false, name);
  for (const name of ["meta_get_insights", "ga4_run_report", "gads_performance_report", "pipedrive_report", "sf_query", "matomo_overview", "ghl_dashboard"]) assert.equal(toolVisible(ro, name), true, name);
});

test("read-only blocks write actions on multi-action tools", () => {
  assert.match(callBlocked(ro, "pipedrive_deals", { action: "create" }), /Read-only/);
  assert.match(callBlocked(ro, "zoho_crm_records", { action: "delete", confirm: true }), /Read-only/);
  assert.equal(callBlocked(ro, "pipedrive_deals", { action: "list" }), undefined);
  assert.equal(callBlocked(ro, "odoo_records", { action: "search" }), undefined);
});

test("allow and deny globs", () => {
  const p = { readOnly: false, allow: [/^ga4_run_.*$/], deny: [/^ga4_run_realtime_report$/] };
  assert.equal(toolVisible(p, "ga4_run_report"), true);
  assert.equal(toolVisible(p, "ga4_run_realtime_report"), false);
  assert.equal(toolVisible(p, "ga4_list_properties"), false);
});

test("MCP_READ_ONLY applies to a running server", { timeout: 30_000 }, async () => {
  const client = await connect("pipedrive", { MCP_READ_ONLY: "true", PIPEDRIVE_API_TOKEN: "x", PIPEDRIVE_DOMAIN: "x" });
  try {
    const names = (await listAll(client)).map((t) => t.name);
    assert.ok(names.includes("pipedrive_report"));
    assert.ok(!names.includes("pipedrive_api"));
    const r = await call(client, "pipedrive_deals", { action: "create", deal: { title: "x" } });
    assert.ok(r.isError && /Read-only/.test(r.text));
  } finally {
    await client.close();
  }
});

test("MCP_DENY_TOOLS hides tools on a running server", { timeout: 30_000 }, async () => {
  const client = await connect("matomo", { MCP_DENY_TOOLS: "matomo_sites,matomo_users" });
  try {
    const names = (await listAll(client)).map((t) => t.name);
    assert.ok(!names.includes("matomo_sites") && !names.includes("matomo_users"));
    assert.ok(names.includes("matomo_overview"));
  } finally {
    await client.close();
  }
});
