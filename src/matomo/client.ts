import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";

type Params = Record<string, unknown>;

/** Instance root, e.g. https://analytics.example.com or https://acme.matomo.cloud (a pasted index.php is stripped). */
export const baseUrl = () => requireEnv("MATOMO_URL").replace(/\/+$/, "").replace(/\/index\.php.*$/, "");

/** Flatten nested params the way Matomo expects: urls[0]=…, idGoals[]=…, matchAttribute=… */
function encode(form: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) value.forEach((v, i) => encode(form, `${key}[${i}]`, v));
  else if (typeof value === "object") Object.entries(value).forEach(([k, v]) => encode(form, `${key}[${k}]`, v));
  else form.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
}

/** Calls a Reporting API method with token_auth in the POST body (Matomo 5 rejects tokens in GET by default). */
export async function matomo(method: string, params: Params = {}): Promise<unknown> {
  const form = new URLSearchParams({ module: "API", method, format: "JSON", token_auth: requireEnv("MATOMO_TOKEN") });
  for (const [k, v] of Object.entries(params)) encode(form, k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${baseUrl()}/index.php`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form });
    if ((res.status === 429 || res.status >= 502) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      continue;
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Matomo ${method}: HTTP ${res.status} — not JSON (${text.slice(0, 300).replace(/\s+/g, " ")}); check MATOMO_URL`);
    }
    const err = data as { result?: string; message?: string };
    if (err?.result === "error") {
      const hint = /token_auth|authenticated|access/i.test(err.message ?? "") ? " — check MATOMO_TOKEN and that the user has access to this site" : "";
      throw new Error(`Matomo ${method}: ${err.message}${hint}`);
    }
    if (!res.ok) throw new Error(`Matomo ${method}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return data;
  }
}

export const siteId = (id?: string | number) => String(id ?? requireEnv("MATOMO_SITE_ID"));

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export const PRESETS = ["today", "yesterday", "last_7_days", "last_28_days", "last_30_days", "last_90_days", "this_week", "last_week", "this_month", "last_month", "this_year", "last_year"] as const;
export type Preset = (typeof PRESETS)[number];

/** Friendly range → { from, to } (inclusive local dates; "last N days" end yesterday so days are complete). */
export function range(preset?: Preset, from?: string, to?: string): { from: string; to: string } {
  if (from) return { from, to: to ?? day(new Date()) };
  const today = new Date();
  const y = addDays(today, -1);
  const back = (n: number) => ({ from: day(addDays(y, -(n - 1))), to: day(y) });
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  switch (preset ?? "last_7_days") {
    case "today":
      return { from: day(today), to: day(today) };
    case "yesterday":
      return { from: day(y), to: day(y) };
    case "last_7_days":
      return back(7);
    case "last_28_days":
      return back(28);
    case "last_30_days":
      return back(30);
    case "last_90_days":
      return back(90);
    case "this_week":
      return { from: day(monday), to: day(today) };
    case "last_week":
      return { from: day(addDays(monday, -7)), to: day(addDays(monday, -1)) };
    case "this_month":
      return { from: day(new Date(today.getFullYear(), today.getMonth(), 1)), to: day(today) };
    case "last_month":
      return { from: day(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: day(new Date(today.getFullYear(), today.getMonth(), 0)) };
    case "this_year":
      return { from: day(new Date(today.getFullYear(), 0, 1)), to: day(today) };
    case "last_year":
      return { from: day(new Date(today.getFullYear() - 1, 0, 1)), to: day(new Date(today.getFullYear() - 1, 11, 31)) };
  }
}

/** The equally long window right before a range, for comparisons. */
export function previous(r: { from: string; to: string }) {
  const [fy, fm, fd] = r.from.split("-").map(Number);
  const [ty, tm, td] = r.to.split("-").map(Number);
  const start = new Date(fy, fm - 1, fd);
  const days = Math.round((new Date(ty, tm - 1, td).getTime() - start.getTime()) / 86_400_000) + 1;
  return { from: day(addDays(start, -days)), to: day(addDays(start, -1)) };
}

/** Range → Matomo period/date params; granularity day/week/month returns one row set per bucket. */
export function periodParams(r: { from: string; to: string }, granularity: "total" | "day" | "week" | "month" = "total") {
  if (granularity !== "total") return { period: granularity, date: `${r.from},${r.to}` };
  return r.from === r.to ? { period: "day", date: r.from } : { period: "range", date: `${r.from},${r.to}` };
}

export const pct = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 1000) / 10 : now ? null : 0);

export const schema = {
  site_id: z.union([z.string(), z.number()]).optional().describe("Matomo site ID (idSite); defaults to MATOMO_SITE_ID"),
  preset: z.enum(PRESETS).optional().describe("Date range; default last_7_days (complete days)"),
  from: z.string().optional().describe("YYYY-MM-DD (overrides preset)"),
  to: z.string().optional().describe("YYYY-MM-DD"),
  segment: z.string().optional().describe("Matomo segment, e.g. deviceType==smartphone;countryCode==bd or referrerType==campaign"),
  confirm: z.boolean().default(false).describe("Required for permanent deletes"),
};

export const officialMcpEnabled = () => optionalEnv("MATOMO_OFFICIAL_MCP").toLowerCase() !== "off";
