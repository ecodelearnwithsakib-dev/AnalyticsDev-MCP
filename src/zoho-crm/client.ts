import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";

/** Data centers: accounts server + API domain. The sign-in saves the exact ones Zoho returns. */
export const DATA_CENTERS: Record<string, { accounts: string; api: string }> = {
  com: { accounts: "https://accounts.zoho.com", api: "https://www.zohoapis.com" },
  eu: { accounts: "https://accounts.zoho.eu", api: "https://www.zohoapis.eu" },
  in: { accounts: "https://accounts.zoho.in", api: "https://www.zohoapis.in" },
  "com.au": { accounts: "https://accounts.zoho.com.au", api: "https://www.zohoapis.com.au" },
  jp: { accounts: "https://accounts.zoho.jp", api: "https://www.zohoapis.jp" },
  ca: { accounts: "https://accounts.zohocloud.ca", api: "https://www.zohoapis.ca" },
  sa: { accounts: "https://accounts.zoho.sa", api: "https://www.zohoapis.sa" },
  "com.cn": { accounts: "https://accounts.zoho.com.cn", api: "https://www.zohoapis.com.cn" },
};

export const SCOPES = [
  "ZohoCRM.modules.ALL",
  "ZohoCRM.settings.ALL",
  "ZohoCRM.users.ALL",
  "ZohoCRM.org.ALL",
  "ZohoCRM.bulk.ALL",
  "ZohoCRM.coql.READ",
  "ZohoCRM.send_mail.all.CREATE",
  "ZohoCRM.Files.CREATE",
  "ZohoCRM.Files.READ",
  "ZohoFiles.files.ALL",
].join(",");

const dc = () => DATA_CENTERS[optionalEnv("ZOHO_DC", "com").replace(/^\./, "")] ?? DATA_CENTERS.com;
export const accountsUrl = () => optionalEnv("ZOHO_ACCOUNTS_URL") || dc().accounts;
export const apiDomain = () => (optionalEnv("ZOHO_API_DOMAIN") || dc().api).replace(/\/+$/, "");

let cached: { token: string; expires: number } | undefined;

async function accessToken(): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: requireEnv("ZOHO_REFRESH_TOKEN"),
    client_id: requireEnv("ZOHO_CLIENT_ID"),
    client_secret: requireEnv("ZOHO_CLIENT_SECRET"),
  });
  const res = await fetch(`${accountsUrl()}/oauth/v2/token`, { method: "POST", body: form });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!data.access_token) throw new Error(`Zoho token refresh failed: ${data.error ?? res.status} — run \`npm run auth:zoho-crm\` again, and check ZOHO_DC / ZOHO_ACCOUNTS_URL`);
  cached = { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

type Query = Record<string, string | number | boolean | undefined | null | string[]>;

export interface ZohoOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  /** Raw body (FormData for uploads). */
  raw?: BodyInit;
  /** Return the Response instead of parsing JSON (file downloads). */
  rawResponse?: boolean;
}

/** Calls the CRM API. `path` is relative to /crm/v8 (e.g. "Leads/search") or absolute ("/crm/bulk/v8/read"). */
export async function zoho<T = Record<string, unknown>>(path: string, opts: ZohoOptions = {}): Promise<T> {
  const url = new URL(path.startsWith("/") ? `${apiDomain()}${path}` : `${apiDomain()}/crm/v8/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${await accessToken()}` };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { method: opts.method ?? (opts.body !== undefined || opts.raw ? "POST" : "GET"), headers, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
    if (res.status === 401 && attempt === 0) {
      cached = undefined;
      continue;
    }
    if ((res.status === 429 || res.status >= 502) && attempt < 4) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 0) * 1000 || 2 ** attempt * 1500));
      continue;
    }
    if (opts.rawResponse && res.ok) return res as unknown as T;
    if (res.status === 204) return {} as T;
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* keep text */
    }
    if (!res.ok) {
      const e = data as { code?: string; message?: string; details?: unknown; data?: { code?: string; message?: string; details?: unknown }[] };
      const first = e?.data?.[0] ?? e;
      const hint = first?.code === "OAUTH_SCOPE_MISMATCH" ? " — run `npm run auth:zoho-crm` again to grant the missing scope" : first?.code === "INVALID_URL_PATTERN" ? " — check the module API name (e.g. Leads, Contacts, Deals)" : "";
      throw new Error(`Zoho ${res.status} ${first?.code ?? ""}: ${first?.message ?? String(text).slice(0, 300)}${first?.details ? ` ${JSON.stringify(first.details)}` : ""}${hint}`);
    }
    return data as T;
  }
}

/** Per-record results of a write: { success, id, error } with the failures explained. */
export function writeResults(res: Record<string, unknown>) {
  const rows = (res.data as { code?: string; status?: string; message?: string; details?: Record<string, unknown> }[] | undefined) ?? [];
  const out = rows.map((r) => (r.status === "success" ? { ok: true, id: r.details?.id, action: r.message } : { ok: false, code: r.code, message: r.message, details: r.details }));
  return { succeeded: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length, results: out };
}

// ---------- field metadata & friendly names ----------

type Field = { api_name: string; field_label: string; display_label?: string; data_type: string; read_only?: boolean; pick_list_values?: { display_value: string; actual_value: string }[]; lookup?: { module?: { api_name?: string } }; system_mandatory?: boolean };
const fieldCache = new Map<string, Promise<Field[]>>();

export function fields(module: string): Promise<Field[]> {
  if (!fieldCache.has(module)) {
    const p = zoho<{ fields?: Field[] }>("settings/fields", { query: { module } }).then((r) => r.fields ?? []);
    p.catch(() => fieldCache.delete(module));
    fieldCache.set(module, p);
  }
  return fieldCache.get(module)!;
}

const COMMON = ["Full_Name", "First_Name", "Last_Name", "Account_Name", "Deal_Name", "Subject", "Product_Name", "Contact_Name", "Company", "Email", "Phone", "Mobile", "Lead_Status", "Lead_Source", "Stage", "Amount", "Closing_Date", "Status", "Due_Date", "Priority", "Industry", "Website", "Owner", "Created_Time", "Modified_Time"];

/** v8 requires `fields` on list/related calls: use the ones asked for, else a sensible default set for the module. */
export async function fieldList(module: string, wanted?: string[]): Promise<string> {
  const all = await fields(module).catch(() => [] as Field[]);
  if (wanted?.length) return (await Promise.all(wanted.map((w) => apiName(module, w)))).slice(0, 50).join(",");
  const names = new Set(all.map((f) => f.api_name));
  const picked = COMMON.filter((c) => names.has(c));
  return (picked.length >= 3 ? picked : all.slice(0, 20).map((f) => f.api_name)).join(",") || "id";
}

/** Accept an API name or a field label ("Lead Source") and return the API name. */
export async function apiName(module: string, name: string): Promise<string> {
  if (name === "id") return name;
  const all = await fields(module).catch(() => [] as Field[]);
  const norm = (s?: string) => (s ?? "").toLowerCase().replace(/[\s_]+/g, "");
  return all.find((f) => f.api_name === name)?.api_name ?? all.find((f) => norm(f.api_name) === norm(name) || norm(f.field_label) === norm(name) || norm(f.display_label) === norm(name))?.api_name ?? name;
}

/** Rewrite a record's keys from labels to API names. */
export async function toApi(module: string, record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) out[k.startsWith("$") ? k : await apiName(module, k)] = v;
  return out;
}

/** Module name tolerance: "leads" → "Leads", "deal" → "Deals". */
export async function moduleName(name: string): Promise<string> {
  const known = ["Leads", "Contacts", "Accounts", "Deals", "Tasks", "Events", "Calls", "Products", "Quotes", "Sales_Orders", "Purchase_Orders", "Invoices", "Vendors", "Campaigns", "Cases", "Solutions", "Price_Books", "Notes"];
  const norm = name.toLowerCase().replace(/[\s_]+/g, "");
  return known.find((k) => {
    const kn = k.toLowerCase().replace(/_/g, "");
    return kn === norm || kn === `${norm}s` || kn.replace(/s$/, "") === norm;
  }) ?? name;
}

/** Flatten lookups ({name,id}) and owners for readable output. */
export function compact(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
    if (k.startsWith("$") && !["$se_module"].includes(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && "name" in v) out[k] = (v as { name?: string }).name;
    else out[k] = v;
  }
  return out;
}

// ---------- dates ----------

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "today", "tomorrow", "+3d", "-7d", "next monday" (basic) or YYYY-MM-DD → YYYY-MM-DD. */
export function day(input?: string): string | undefined {
  if (!input) return undefined;
  const s = input.trim().toLowerCase();
  const now = new Date();
  const add = (n: number) => ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
  if (s === "today") return add(0);
  if (s === "tomorrow") return add(1);
  if (s === "yesterday") return add(-1);
  const rel = s.match(/^([+-]\d+)\s*d/);
  if (rel) return add(Number(rel[1]));
  const wd = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(s.replace(/^next\s+/, ""));
  if (wd >= 0) return add(((wd - now.getDay() + 7) % 7) || 7);
  return input.slice(0, 10);
}

/** Datetime for Zoho (ISO with offset). */
export function dateTime(input: string): string {
  const s = input.trim().toLowerCase();
  const rel = s.match(/^\+(\d+)\s*([mhd])$/);
  let d: Date;
  if (rel) d = new Date(Date.now() + Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "m" | "h" | "d"]);
  else d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`Can't read the time "${input}" — use ISO like 2026-10-01T15:00 or +2h`);
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${off >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

export const schema = {
  module: z.string().describe("Module API name: Leads, Contacts, Accounts, Deals, Tasks, Calls, Events, Products, Quotes, Invoices, Cases, Campaigns or a custom module"),
  fields: z.array(z.string()).optional().describe("Field API names or labels to return (default: a useful set for the module)"),
  confirm: z.boolean().default(false).describe("Required for deletes, mass changes and sending email"),
};
