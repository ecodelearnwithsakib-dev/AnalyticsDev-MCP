import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const run = (...args) => execFileSync(process.execPath, [new URL("../dist/shared/print-config.js", import.meta.url).pathname, ...args], { encoding: "utf8" });
const jsonPart = (out) => JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));

test("config: cursor JSON has absolute paths and no secrets", () => {
  const cfg = jsonPart(run("cursor", "ga4,meta"));
  assert.deepEqual(Object.keys(cfg.mcpServers), ["ga4", "meta"]);
  assert.ok(cfg.mcpServers.ga4.args[0].endsWith("/dist/ga4/index.js"));
  assert.ok(!JSON.stringify(cfg).match(/TOKEN|SECRET/));
});

test("config: --profile and --read-only add env and suffix names", () => {
  const cfg = jsonPart(run("cursor", "ga4", "--profile", "acme", "--read-only"));
  assert.deepEqual(cfg.mcpServers["ga4-acme-ro"].env, { MCP_PROFILE: "acme", MCP_READ_ONLY: "true" });
});

test("config: every client renders", () => {
  for (const c of ["claude-code", "claude-desktop", "cursor", "vscode", "windsurf", "codex", "gemini", "zed", "cline", "continue", "jetbrains", "lmstudio", "amazonq", "kiro", "goose", "opencode", "antigravity", "warp", "trae", "augment", "roo", "kilo", "devin", "copilot-agent", "remote"]) {
    assert.ok(run(c, "ga4").length > 50, c);
  }
});
