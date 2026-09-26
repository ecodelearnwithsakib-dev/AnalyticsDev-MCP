#!/usr/bin/env node
/**
 * One entry point for npx, Docker and global installs:
 *
 *   analyticsdev-mcp <server>            run one server over stdio (e.g. ga4, shopify, ads-hub)
 *   analyticsdev-mcp serve <servers…>    HTTP gateway (same flags as npm run serve)
 *   analyticsdev-mcp config <client> …   print a client config (same as npm run config)
 *   analyticsdev-mcp auth <profile>      Google / LinkedIn / Pinterest / Snapchat / Amazon Ads sign-in
 *   analyticsdev-mcp secret …            Keychain helper (same as npm run secret)
 *   analyticsdev-mcp list                list servers
 *   analyticsdev-mcp init                create <config folder>/.env from .env.example
 *
 * The config folder is MCP_HOME, or ~/.analyticsdev-mcp when running from npx / node_modules.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configRoot, projectEnv } from "./env.js";
import { projectRoot, SERVERS } from "./servers.js";

const [cmd, ...rest] = process.argv.slice(2);
const GOOGLE_AUTH = ["ga4", "gtm", "bigquery", "looker-studio", "google-ads", "microsoft-ads", "search-console", "merchant", "youtube", "sheets"];
const OAUTH = ["linkedin", "pinterest", "snapchat", "amazon-ads"];
const OWN_SIGNIN: Record<string, string> = { "microsoft-ads-ms": "microsoft-ads/signin.js", "zoho-crm": "zoho-crm/signin.js", salesforce: "salesforce/signin.js", reddit: "reddit/signin.js" };

async function start(file: string, args: string[]) {
  const path = resolve(projectRoot, "dist", file);
  if (!existsSync(path)) throw new Error(`${path} is missing — the package was not built`);
  process.argv = [process.argv[0], path, ...args];
  await import(pathToFileURL(path).href);
}

function usage(code = 0) {
  console.error(`Usage: analyticsdev-mcp <server> | init | serve <servers> | config <client> [servers] | auth <name> | secret … | list

Servers: ${SERVERS.map((s) => s.name).join(", ")}
Sign-ins: ${[...GOOGLE_AUTH, ...OAUTH, ...Object.keys(OWN_SIGNIN)].join(", ")}
Config folder (.env, profiles, state): ${configRoot} — set MCP_HOME to change it`);
  process.exit(code);
}

try {
  if (!cmd || cmd === "-h" || cmd === "--help") usage();
  else if (cmd === "list") for (const s of SERVERS) console.log(`${s.name.padEnd(18)} ${s.title}`);
  else if (cmd === "init") {
    if (existsSync(projectEnv)) console.error(`${projectEnv} already exists — edit it to add credentials.`);
    else {
      mkdirSync(configRoot, { recursive: true });
      copyFileSync(resolve(projectRoot, ".env.example"), projectEnv);
      chmodSync(projectEnv, 0o600);
      console.error(`Created ${projectEnv} — open it and fill in only the platforms you use.`);
    }
  } else if (cmd === "serve") await start("shared/http-gateway.js", rest);
  else if (cmd === "config") await start("shared/print-config.js", rest);
  else if (cmd === "secret") await start("shared/secret.js", rest);
  else if (cmd === "auth") {
    const name = rest[0];
    if (name && GOOGLE_AUTH.includes(name)) await start("shared/google-signin.js", rest);
    else if (name && OAUTH.includes(name)) await start("shared/oauth-signin.js", rest);
    else if (name && OWN_SIGNIN[name]) await start(OWN_SIGNIN[name], rest.slice(1));
    else usage(1);
  } else {
    const s = SERVERS.find((x) => x.name === cmd || x.dir === cmd);
    if (!s) {
      console.error(`Unknown server or command "${cmd}".`);
      usage(1);
    } else await start(`${s.dir}/index.js`, rest);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
