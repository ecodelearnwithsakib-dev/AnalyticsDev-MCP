import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load <project root>/.env so MCP clients only need the command, not every secret.
export const projectEnv = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
if (existsSync(projectEnv)) process.loadEnvFile(projectEnv);

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name} (see .env.example)`);
  }
  return value;
}

export function optionalEnv(name: string, fallback = ""): string {
  return process.env[name] || fallback;
}

/** Write (or replace) NAME=value in the project .env, owner-readable only, and apply it to this process. */
export function saveEnv(name: string, value: string): void {
  const lines = existsSync(projectEnv) ? readFileSync(projectEnv, "utf8").split("\n") : [];
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (index >= 0) lines[index] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  writeFileSync(projectEnv, lines.join("\n"), { mode: 0o600 });
  process.env[name] = value;
}
