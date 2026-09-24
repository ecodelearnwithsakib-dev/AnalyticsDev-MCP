import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load <project root>/.env so MCP clients only need the command, not every secret.
const projectEnv = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
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
