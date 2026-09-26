import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { optionalEnv } from "./env.js";
import { projectRoot } from "./servers.js";

/**
 * Cross-platform servers call the single-platform servers as MCP children, so every platform's auth,
 * profiles (MCP_PROFILE), read-only policy and fixes are reused instead of re-implemented.
 */
const children = new Map<string, Promise<Client>>();

function child(dir: string): Promise<Client> {
  if (!children.has(dir)) {
    const entry = resolve(projectRoot, "dist", dir, "index.js");
    const p = (async () => {
      if (!existsSync(entry)) throw new Error(`Server ${dir} is not built (run npm run build)`);
      const client = new Client({ name: `hub-${dir}`, version: "0.1.0" });
      const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: projectRoot, env: process.env as Record<string, string>, stderr: "ignore" });
      transport.onclose = () => children.delete(dir);
      await client.connect(transport);
      return client;
    })();
    p.catch(() => children.delete(dir));
    children.set(dir, p);
  }
  return children.get(dir)!;
}

export class ToolError extends Error {}

/** Calls `tool` on server `dir`; returns parsed JSON (or text) and throws ToolError on tool errors. */
export async function callTool<T = unknown>(dir: string, tool: string, args: Record<string, unknown> = {}, timeoutMs = 180_000): Promise<T> {
  const client = await child(dir);
  const res = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs })) as { isError?: boolean; content?: { type: string; text?: string }[] };
  const text = res.content?.find((c) => c.type === "text")?.text ?? "";
  if (res.isError) throw new ToolError(text.replace(/^Error:\s*/, ""));
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

export async function closeChildren() {
  for (const p of children.values()) await p.then((c) => c.close()).catch(() => undefined);
  children.clear();
}

/** True when every listed variable has a value (for "which platforms are connected"). */
export const configured = (...names: string[]) => names.every((n) => !!process.env[n]);

// ---------- currency ----------

const rateCache = new Map<string, Promise<Record<string, number>>>();

/** Exchange rates with `base` = 1 (open.er-api.com, cached per process). Override with FX_RATES="USD:BDT=121,EUR:BDT=131". */
async function rates(base: string): Promise<Record<string, number>> {
  if (!rateCache.has(base)) {
    const p = (async () => {
      const res = await fetch(`https://open.er-api.com/v6/latest/${base}`);
      const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
      if (data.result !== "success" || !data.rates) throw new Error(`Exchange rates for ${base} unavailable`);
      return data.rates;
    })();
    p.catch(() => rateCache.delete(base));
    rateCache.set(base, p);
  }
  return rateCache.get(base)!;
}

export async function convert(amount: number, from: string, to: string): Promise<number> {
  if (!amount || !from || !to || from.toUpperCase() === to.toUpperCase()) return amount;
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  for (const pair of optionalEnv("FX_RATES").split(",")) {
    const m = pair.trim().match(/^([A-Z]{3}):([A-Z]{3})=([\d.]+)$/i);
    if (!m) continue;
    if (m[1].toUpperCase() === f && m[2].toUpperCase() === t) return amount * Number(m[3]);
    if (m[1].toUpperCase() === t && m[2].toUpperCase() === f) return amount / Number(m[3]);
  }
  const r = await rates(f);
  if (!r[t]) throw new Error(`No exchange rate ${f}→${t}`);
  return amount * r[t];
}

// ---------- dates ----------

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + n));
};
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

export const PRESETS = ["yesterday", "last_7_days", "last_14_days", "last_30_days", "this_month", "last_month", "month_to_date", "last_90_days"] as const;

/** Preset or from/to → inclusive local-date window (complete days, ending yesterday, unless this_month/month_to_date). */
export function window(preset?: string, from?: string, to?: string): { from: string; to: string } {
  const today = ymd(new Date());
  const y = addDays(today, -1);
  if (from) return { from, to: to ?? y };
  const n = new Date();
  switch (preset ?? "last_7_days") {
    case "yesterday":
      return { from: y, to: y };
    case "last_14_days":
      return { from: addDays(y, -13), to: y };
    case "last_30_days":
      return { from: addDays(y, -29), to: y };
    case "last_90_days":
      return { from: addDays(y, -89), to: y };
    case "this_month":
    case "month_to_date":
      return { from: ymd(new Date(n.getFullYear(), n.getMonth(), 1)), to: today };
    case "last_month":
      return { from: ymd(new Date(n.getFullYear(), n.getMonth() - 1, 1)), to: ymd(new Date(n.getFullYear(), n.getMonth(), 0)) };
    default:
      return { from: addDays(y, -6), to: y };
  }
}

/** The equally long window right before `w`. */
export const previousWindow = (w: { from: string; to: string }) => {
  const len = daysBetween(w.from, w.to);
  return { from: addDays(w.from, -len), to: addDays(w.from, -1) };
};

export const round = (n: number, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : 0);
export const pct = (now: number, before: number) => (before ? round(((now - before) / before) * 100, 1) : now ? null : 0);
