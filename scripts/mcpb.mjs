#!/usr/bin/env node
// Builds Claude Desktop Extensions (.mcpb): one bundle per server with its settings form
// generated from .env.example (secrets marked sensitive, so Claude Desktop stores them in the OS keychain).
//
//   npm run build && npm run mcpb                 every single-platform server
//   npm run mcpb -- shopify,ga4                   only these
//
// Output: build/mcpb/<server>.mcpb — double-click to install in Claude Desktop, or Settings → Extensions →
// Advanced → Install Extension. No network access is needed: production dependencies are copied from
// node_modules and the bundle is zipped with the system `zip` command.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const { SERVERS } = await import(resolve(root, "dist/shared/servers.js"));
const CROSS = new Set(["ads-hub", "tracking-audit", "conversion-sync", "monitor"]);
const GOOGLE = new Set(["ga4", "gtm", "bigquery", "looker-studio", "google-ads", "microsoft-ads", "search-console", "merchant-center", "youtube-analytics", "google-sheets"]);

const wanted = (process.argv[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const list = wanted.length ? wanted.map((n) => SERVERS.find((s) => s.name === n) ?? (() => { throw new Error(`Unknown server ${n}`); })()) : SERVERS.filter((s) => !CROSS.has(s.name));
for (const s of list) if (CROSS.has(s.name)) throw new Error(`${s.name} starts the other servers as child processes — install it locally instead of as an extension`);

/** Settings for a server from its .env.example section: comments above a key become its description. */
function settings(dir) {
  const lines = readFileSync(resolve(root, ".env.example"), "utf8").split("\n");
  const out = [];
  let inside = false;
  let notes = [];
  const collect = (d, keep = () => true) => {
    for (const line of lines) {
      if (line.startsWith("# ----------")) {
        inside = line.includes(`(src/${d})`) || (d === "google" && line.includes("Service account"));
        notes = [];
        continue;
      }
      if (!inside) continue;
      if (line.startsWith("#")) notes.push(line.replace(/^#\s?/, ""));
      else if (/^[A-Z0-9_]+=/.test(line)) {
        const [key, ...v] = line.split("=");
        if (keep(key)) out.push({ key, def: v.join("=").trim(), note: notes.join(" ").trim() });
        notes = [];
      } else notes = [];
    }
  };
  collect(dir);
  if (GOOGLE.has(dir)) {
    if (dir !== "ga4") collect("ga4", (k) => /OAUTH_CLIENT|^GOOGLE_/.test(k));
    collect("google");
  }
  const seen = new Set();
  return out.filter((x) => !seen.has(x.key) && seen.add(x.key));
}
const title = (k) => k.toLowerCase().split("_").map((w) => (["id", "api", "url", "oauth", "ads", "mcp", "capi", "gtm", "sgtm"].includes(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ");
const sensitive = (k) => /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE|_KEY$|CREDENTIALS/.test(k) && !/_ID$/.test(k);

async function tools(s) {
  const client = new Client({ name: "mcpb", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(root, "dist", s.dir, "index.js")], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", MCP_HOME: resolve(root, "build", "empty-home") }, stderr: "ignore" }));
  const out = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    out.push(...page.tools.map((t) => ({ name: t.name, description: (t.description ?? "").split(/(?<=\.)\s/)[0].slice(0, 200) })));
    cursor = page.nextCursor;
  } while (cursor);
  await client.close();
  return out;
}

const prodDeps = execFileSync("npm", ["ls", "--omit=dev", "--parseable", "--all"], { cwd: root, encoding: "utf8" }).split("\n").filter((p) => p.includes("/node_modules/")).map((p) => p.slice(p.indexOf("node_modules/"))); // npm can redact parts of absolute paths
const outDir = resolve(root, "build", "mcpb");
mkdirSync(outDir, { recursive: true });
mkdirSync(resolve(root, "build", "empty-home"), { recursive: true });

for (const s of list) {
  const stage = resolve(root, "build", "stage", s.name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(resolve(root, "dist", "shared"), resolve(stage, "dist", "shared"), { recursive: true });
  cpSync(resolve(root, "dist", s.dir), resolve(stage, "dist", s.dir), { recursive: true });
  for (const f of ["LICENSE", "PRIVACY.md", "TERMS.md"]) cpSync(resolve(root, f), resolve(stage, f));
  for (const p of prodDeps) cpSync(resolve(root, p), resolve(stage, p), { recursive: true });
  writeFileSync(resolve(stage, "package.json"), JSON.stringify({ name: `analyticsdev-${s.name}`, version: pkg.version, type: "module", private: true }, null, 2));

  const cfg = settings(s.dir);
  const user_config = Object.fromEntries(
    cfg.map((c) => [c.key, { type: c.key === "GOOGLE_APPLICATION_CREDENTIALS" ? "file" : "string", title: title(c.key), description: (c.note || c.key).slice(0, 400), sensitive: c.key !== "GOOGLE_APPLICATION_CREDENTIALS" && sensitive(c.key), required: false, ...(c.def && !sensitive(c.key) && !/example|your-/.test(c.def) ? { default: c.def } : {}) }]),
  );
  const manifest = {
    manifest_version: "0.2",
    name: `analyticsdev-${s.name}`,
    display_name: `Analytics Dev · ${s.title}`,
    version: pkg.version,
    description: `${s.title} tools for Claude from Analytics Dev MCP.`,
    long_description: `Fill in the settings for ${s.title}. Secrets are stored in your OS keychain by Claude Desktop. Values that normally come from a browser sign-in (npm run auth:…) must be created once with the repository on a computer and pasted here. Setup guide: ${pkg.homepage}`,
    author: { name: "Sakib Hossain (Analytics Dev)", url: "https://github.com/ecodelearnwithsakib-dev" },
    repository: { type: "git", url: pkg.repository.url.replace(/^git\+/, "") },
    homepage: pkg.homepage,
    license: pkg.license,
    keywords: ["marketing", "analytics", s.name],
    server: {
      type: "node",
      entry_point: `dist/${s.dir}/index.js`,
      mcp_config: { command: "node", args: [`\${__dirname}/dist/${s.dir}/index.js`], env: { MCP_HOME: "${HOME}/.analyticsdev-mcp", ...Object.fromEntries(cfg.map((c) => [c.key, `\${user_config.${c.key}}`])) } },
    },
    tools: await tools(s),
    user_config,
    compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=20.0.0" } },
  };
  writeFileSync(resolve(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
  const file = resolve(outDir, `${s.name}.mcpb`);
  rmSync(file, { force: true });
  execFileSync("zip", ["-qr", "-X", file, "."], { cwd: stage });
  console.log(`${relative(root, file)}  (${manifest.tools.length} tools, ${cfg.length} settings)`);
}
rmSync(resolve(root, "build", "stage"), { recursive: true, force: true });
if (!existsSync(outDir)) process.exit(1);
