import assert from "node:assert/strict";
import { test } from "node:test";
import { SERVERS } from "../dist/shared/servers.js";
import { connect, listAll } from "./helpers.mjs";

const seen = new Map();

for (const s of SERVERS) {
  test(`${s.name}: starts and lists well-formed tools`, { timeout: 30_000 }, async () => {
    const client = await connect(s.dir);
    try {
      const tools = await listAll(client);
      assert.ok(tools.length > 0, "no tools");
      const names = new Set();
      for (const t of tools) {
        assert.match(t.name, /^[a-z0-9_]{3,64}$/, `bad tool name ${t.name}`);
        assert.ok(!names.has(t.name), `duplicate tool ${t.name}`);
        names.add(t.name);
        assert.equal(t.inputSchema?.type, "object", `${t.name} input schema must be an object`);
        assert.ok((t.description ?? "").length >= 20, `${t.name} needs a real description`);
        const owner = seen.get(t.name);
        assert.ok(!owner || owner === s.name, `${t.name} defined by both ${owner} and ${s.name}`);
        seen.set(t.name, s.name);
      }
    } finally {
      await client.close();
    }
  });
}
