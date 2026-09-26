import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/**
 * Configuration loading, in priority order:
 *   1. variables set by the MCP client (its "env" block) or the shell
 *   2. .env.<MCP_PROFILE> — one file per client/brand in agency mode (MCP_PROFILE=acme → .env.acme)
 *   3. .env
 * Values may point to a secret store instead of holding the secret:
 *   keychain:<name>  macOS Keychain generic password (service "analyticsdev-mcp", account <name>)
 *   op://vault/item/field  1Password CLI reference
 * MCP_HOME moves .env, profiles and state out of the package folder. When the package runs from an
 * npx cache or node_modules and MCP_HOME is not set, ~/.analyticsdev-mcp is used.
 */
// Desktop Extensions (.mcpb) may pass optional settings the user left empty as "${user_config.NAME}" or "".
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && /^\$\{user_config\.\w+\}$/.test(v)) delete process.env[k];
const home = process.env.MCP_HOME?.trim();
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const installed = /[\\/](_npx|node_modules)[\\/]/.test(packageRoot);
const root = home ? resolve(home.replace(/^~(?=[\\/]|$)/, homedir())) : installed ? resolve(homedir(), ".analyticsdev-mcp") : packageRoot;
/** Folder holding .env, .env.<profile>, .state/, reports/ and schedules/. */
export const configRoot = root;
export const projectEnv = resolve(root, ".env");

const fromShell = new Set(Object.keys(process.env));
function load(file: string) {
  if (!existsSync(file)) return;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (!fromShell.has(k)) process.env[k] = v;
  }
}
load(projectEnv);
export const profile = (process.env.MCP_PROFILE ?? "").trim().replace(/[^\w.-]/g, "");
export const profileEnv = profile ? resolve(root, `.env.${profile}`) : projectEnv;
if (profile) {
  if (!existsSync(profileEnv)) console.error(`MCP_PROFILE=${profile} but ${profileEnv} does not exist — using .env only`);
  load(profileEnv);
}

export const KEYCHAIN_SERVICE = "analyticsdev-mcp";
const resolved = new Map<string, string>();

/** Turns keychain:/op:// references into the secret itself (cached per process). */
function resolveSecret(name: string, value: string): string {
  if (!value.startsWith("keychain:") && !value.startsWith("op://")) return value;
  const hit = resolved.get(name);
  if (hit !== undefined) return hit;
  let secret: string;
  try {
    secret = value.startsWith("keychain:")
      ? execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", value.slice(9), "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
      : execFileSync("op", ["read", value], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error(`Could not read ${name} from ${value.startsWith("op://") ? "1Password (is the op CLI signed in?)" : "the macOS Keychain (run `npm run secret -- set " + name + "`)"}`);
  }
  resolved.set(name, secret);
  return secret;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name} (see .env.example${profile ? `; profile ${profile} reads .env.${profile}` : ""})`);
  }
  return resolveSecret(name, value);
}

export function optionalEnv(name: string, fallback = ""): string {
  const value = process.env[name];
  return value ? resolveSecret(name, value) : fallback;
}

/**
 * Write (or replace) NAME=value in the active env file (.env, or .env.<profile> in agency mode),
 * owner-readable only, and apply it to this process. A value currently stored in the Keychain
 * is updated there instead, so the file keeps its keychain: reference.
 */
export function saveEnv(name: string, value: string): void {
  const current = process.env[name];
  if (current?.startsWith("keychain:")) {
    execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", current.slice(9), "-w", value], { stdio: "ignore" });
    resolved.set(name, value);
    return;
  }
  const file = profileEnv;
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (index >= 0) lines[index] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n"), { mode: 0o600 });
  process.env[name] = value;
  resolved.delete(name);
}
