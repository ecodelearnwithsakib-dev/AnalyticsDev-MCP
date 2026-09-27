#!/usr/bin/env node
// Exports the playbooks (src/shared/playbooks.ts) as Agent Skills: skills/<name>/SKILL.md.
// Run after `npm run build`. Copy a folder to ~/.claude/skills/ (Claude Code) or upload it in Claude's settings.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { PLAYBOOKS } = await import(resolve(root, "dist/shared/playbooks.js"));
for (const p of PLAYBOOKS) {
  const name = p.name.replace(/_/g, "-");
  const dir = resolve(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  const args = p.args.length ? `## Inputs\n\n${p.args.map((a) => `- **${a.name}**${a.required ? " (required)" : ""} — ${a.description}`).join("\n")}\n\nAsk for required inputs that the user has not given.\n\n` : "";
  const body = `---
name: ${name}
description: ${p.description} Uses the Analytics Dev MCP servers (${p.servers.join(", ")}).
---

# ${p.title}

${args}## Servers

Needs these Analytics Dev MCP servers connected (skip steps whose server is missing and say so): ${p.servers.map((s) => `\`${s}\``).join(", ")}.

## Steps

${p.steps({})}
`;
  writeFileSync(resolve(dir, "SKILL.md"), body);
  console.log(`skills/${name}/SKILL.md`);
}
