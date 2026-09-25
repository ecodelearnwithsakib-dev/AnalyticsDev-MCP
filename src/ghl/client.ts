import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";

const BASE = "https://services.leadconnectorhq.com";

type Query = Record<string, string | number | boolean | undefined | null>;

/** Calendars and conversations use the 2021-04-15 API version; everything else 2021-07-28. */
const versionFor = (path: string) => (/^\/(calendars|conversations)/.test(path) ? "2021-04-15" : "2021-07-28");

/** Calls the HighLevel API v2 with the Private Integration Token; retries 429/5xx. */
export async function ghl<T = Record<string, unknown>>(path: string, opts: { method?: string; query?: Query; body?: unknown } = {}): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${optionalEnv("GHL_API_BASE", BASE)}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: { Authorization: `Bearer ${requireEnv("GHL_API_TOKEN")}`, Version: versionFor(url.pathname), Accept: "application/json", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if ((res.status === 429 || res.status >= 502) && attempt < 4) {
      const reset = Number(res.headers.get("x-ratelimit-interval-milliseconds") ?? 0);
      await new Promise((r) => setTimeout(r, reset || 2 ** attempt * 1500));
      continue;
    }
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const e = data as { message?: string | string[]; error?: string };
      const msg = Array.isArray(e?.message) ? e.message.join("; ") : e?.message ?? e?.error ?? String(text).slice(0, 300);
      const hint =
        /scope/i.test(msg) ? " — the Private Integration is missing this scope; edit it under Settings → Private Integrations and add the scope" : res.status === 401 ? " — check GHL_API_TOKEN (Settings → Private Integrations) and that it belongs to this sub-account" : res.status === 403 ? " — the Private Integration is missing the scope for this endpoint; edit it and add the scope" : "";
      throw new Error(`HighLevel ${res.status}: ${msg}${hint}`);
    }
    return data as T;
  }
}

export const locationId = (id?: string) => id ?? requireEnv("GHL_LOCATION_ID");

// ---------- lookups ----------

type Named = { id: string; name: string };
const memo = new Map<string, Promise<unknown>>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!memo.has(key)) {
    const p = load();
    p.catch(() => memo.delete(key));
    memo.set(key, p);
  }
  return memo.get(key) as Promise<T>;
}

export type User = { id: string; name?: string; firstName?: string; lastName?: string; email?: string; roles?: { role?: string } };
export const users = (loc: string) => cached(`users:${loc}`, async () => (await ghl<{ users?: User[] }>("/users/", { query: { locationId: loc } })).users ?? []);

export type CustomField = { id: string; name: string; fieldKey?: string; dataType?: string; picklistOptions?: string[]; model?: string };
export const customFields = (loc: string) => cached(`cf:${loc}`, async () => (await ghl<{ customFields?: CustomField[] }>(`/locations/${loc}/customFields`)).customFields ?? []);

export type Pipeline = { id: string; name: string; stages: Named[] };
export const pipelines = (loc: string) => cached(`pl:${loc}`, async () => (await ghl<{ pipelines?: Pipeline[] }>("/opportunities/pipelines", { query: { locationId: loc } })).pipelines ?? []);

const norm = (s?: string) => (s ?? "").toLowerCase().trim();

/** "me" isn't known to a token, so users are matched by id, email or name. */
export async function userId(loc: string, who: string): Promise<string> {
  const list = await users(loc);
  const q = norm(who);
  const hit =
    list.find((u) => u.id === who || norm(u.email) === q) ??
    list.find((u) => norm(u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`) === q) ??
    list.filter((u) => norm(u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`).includes(q));
  if (Array.isArray(hit)) {
    if (hit.length === 1) return hit[0].id;
    throw new Error(hit.length ? `"${who}" matches ${hit.map((u) => u.name ?? u.email).join(", ")}` : `No user "${who}" in this sub-account`);
  }
  return hit.id;
}

export async function userName(loc: string, id?: string): Promise<string | undefined> {
  if (!id) return undefined;
  const u = (await users(loc).catch(() => [] as User[])).find((x) => x.id === id);
  return u ? u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : id;
}

/** Pipeline and stage by id or name. */
export async function stage(loc: string, pipeline?: string, stageName?: string): Promise<{ pipelineId?: string; stageId?: string; pipeline?: Pipeline }> {
  const list = await pipelines(loc);
  const p = pipeline ? list.find((x) => x.id === pipeline || norm(x.name) === norm(pipeline)) ?? list.find((x) => norm(x.name).includes(norm(pipeline))) : stageName ? list.find((x) => x.stages.some((s) => norm(s.name) === norm(stageName))) : list[0];
  if (pipeline && !p) throw new Error(`No pipeline "${pipeline}" — available: ${list.map((x) => x.name).join(", ")}`);
  if (!stageName) return { pipelineId: p?.id, pipeline: p };
  const s = p?.stages.find((x) => x.id === stageName || norm(x.name) === norm(stageName)) ?? p?.stages.find((x) => norm(x.name).includes(norm(stageName)));
  if (!s) throw new Error(`No stage "${stageName}"${p ? ` in ${p.name} — stages: ${p.stages.map((x) => x.name).join(", ")}` : ""}`);
  return { pipelineId: p!.id, stageId: s.id, pipeline: p };
}

/** {"Budget": 5000, "lead_score": 7} → [{id, field_value}] using field names or keys. */
export async function customFieldValues(loc: string, values?: Record<string, unknown>) {
  if (!values) return undefined;
  const fields = await customFields(loc);
  return Object.entries(values).map(([k, v]) => {
    const f = fields.find((x) => x.id === k || norm(x.name) === norm(k) || norm(x.fieldKey?.replace(/^contact\./, "")) === norm(k) || norm(x.fieldKey) === norm(k));
    if (!f) throw new Error(`No custom field "${k}" — see ghl_location what=custom_fields`);
    return { id: f.id, field_value: v };
  });
}

// ---------- dates ----------

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** today / tomorrow / +3d / friday / YYYY-MM-DD → Date at local midnight. */
export function dayDate(input: string): Date {
  const s = input.trim().toLowerCase();
  const now = new Date();
  const at = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  if (s === "today") return at(0);
  if (s === "tomorrow") return at(1);
  if (s === "yesterday") return at(-1);
  const rel = s.match(/^([+-]\d+)\s*d/);
  if (rel) return at(Number(rel[1]));
  const wd = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(s.replace(/^next\s+/, ""));
  if (wd >= 0) return at(((wd - now.getDay() + 7) % 7) || 7);
  const d = new Date(input.length === 10 ? `${input}T00:00:00` : input);
  if (Number.isNaN(d.getTime())) throw new Error(`Can't read the date "${input}"`);
  return d;
}

/** ISO datetime or +2h / +30m / tomorrow 15:00 → Date. */
export function when(input: string): Date {
  const s = input.trim().toLowerCase();
  const rel = s.match(/^\+(\d+)\s*([mhd])$/);
  if (rel) return new Date(Date.now() + Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "m" | "h" | "d"]);
  const m = s.match(/^(today|tomorrow|[+-]\d+d|\w+day)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    const d = dayDate(m[1]);
    let h = Number(m[2]);
    if (m[4] === "pm" && h < 12) h += 12;
    if (m[4] === "am" && h === 12) h = 0;
    d.setHours(h, Number(m[3] ?? 0));
    return d;
  }
  return dayDate(input);
}

export function period(preset?: string, from?: string, to?: string): { start: Date; end: Date } {
  if (from) {
    const end = dayDate(to ?? "today");
    end.setHours(23, 59, 59);
    return { start: dayDate(from), end };
  }
  const n = new Date();
  const y = n.getFullYear();
  const m = n.getMonth();
  const range = (a: Date, b: Date) => ({ start: a, end: new Date(b.getFullYear(), b.getMonth(), b.getDate(), 23, 59, 59) });
  switch (preset ?? "last_30_days") {
    case "today":
      return range(n, n);
    case "last_7_days":
      return range(new Date(y, m, n.getDate() - 6), n);
    case "this_month":
      return range(new Date(y, m, 1), n);
    case "last_month":
      return range(new Date(y, m - 1, 1), new Date(y, m, 0));
    case "last_90_days":
      return range(new Date(y, m, n.getDate() - 89), n);
    case "this_year":
      return range(new Date(y, 0, 1), n);
    default:
      return range(new Date(y, m, n.getDate() - 29), n);
  }
}

export const PERIOD = z.enum(["today", "last_7_days", "last_30_days", "this_month", "last_month", "last_90_days", "this_year"]).optional();

export const schema = {
  location_id: z.string().optional().describe("Sub-account (location) ID; defaults to GHL_LOCATION_ID"),
  confirm: z.boolean().default(false).describe("Required for deletes and for sending messages/invoices to contacts"),
};

export const money = (n: number) => Math.round(n * 100) / 100;
