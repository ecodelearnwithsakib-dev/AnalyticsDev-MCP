import { z } from "zod";
import { optionalEnv, requireEnv, saveEnv } from "../shared/env.js";

export type Rec = Record<string, unknown>;
type Query = Record<string, string | number | boolean | undefined | null>;

export const apiVersion = () => optionalEnv("SF_API_VERSION", "v65.0").replace(/^(\d)/, "v$1");
/** My Domain login URL, e.g. https://acme.my.salesforce.com (sandbox: https://acme--dev.sandbox.my.salesforce.com). */
export const loginUrl = () => optionalEnv("SF_LOGIN_URL", "https://login.salesforce.com").replace(/\/+$/, "");

let token: { access: string; instance: string; expires: number } | undefined;

async function authenticate(): Promise<{ access: string; instance: string }> {
  if (token && token.expires > Date.now()) return token;
  const form = new URLSearchParams({ client_id: requireEnv("SF_CLIENT_ID") });
  const secret = optionalEnv("SF_CLIENT_SECRET");
  if (secret) form.set("client_secret", secret);
  const refresh = optionalEnv("SF_REFRESH_TOKEN");
  if (refresh) {
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", refresh);
  } else {
    // Client credentials flow: the External Client App runs as its configured "Run As" user.
    if (!secret) throw new Error("Run `npm run auth:salesforce` to sign in, or set SF_CLIENT_SECRET for the client-credentials flow");
    form.set("grant_type", "client_credentials");
  }
  const base = refresh ? optionalEnv("SF_INSTANCE_URL") || loginUrl() : loginUrl();
  const res = await fetch(`${base}/services/oauth2/token`, { method: "POST", body: form });
  const data = (await res.json()) as { access_token?: string; instance_url?: string; error?: string; error_description?: string; refresh_token?: string };
  if (!data.access_token) throw new Error(`Salesforce sign-in failed: ${data.error}: ${data.error_description} — check SF_LOGIN_URL (your My Domain) and the External Client App settings`);
  if (data.refresh_token && data.refresh_token !== refresh) saveEnv("SF_REFRESH_TOKEN", data.refresh_token);
  if (data.instance_url && data.instance_url !== optionalEnv("SF_INSTANCE_URL")) saveEnv("SF_INSTANCE_URL", data.instance_url);
  token = { access: data.access_token, instance: data.instance_url ?? base, expires: Date.now() + 50 * 60_000 };
  return token;
}

/**
 * REST call. Paths: "query" → /services/data/vXX.X/query, "/services/..." absolute, full URLs as-is.
 * Returns parsed JSON (or text for CSV).
 */
export async function sf<T = Rec>(path: string, opts: { method?: string; query?: Query; body?: unknown; raw?: string; contentType?: string; accept?: string; response?: boolean } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const { access, instance } = await authenticate();
    const url = new URL(path.startsWith("http") ? path : path.startsWith("/") ? `${instance}${path}` : `${instance}/services/data/${apiVersion()}/${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined || opts.raw !== undefined ? "POST" : "GET"),
      headers: { Authorization: `Bearer ${access}`, Accept: opts.accept ?? "application/json", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : opts.raw !== undefined ? { "Content-Type": opts.contentType ?? "text/csv" } : {}) },
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
    if (res.status === 401 && attempt === 0) {
      token = undefined;
      continue;
    }
    if ((res.status === 503 || res.status === 429) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 2000));
      continue;
    }
    if (opts.response && res.ok) return res as unknown as T;
    if (res.status === 204) return {} as T;
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 400);
      try {
        const e = JSON.parse(text) as { message?: string; errorCode?: string; fields?: string[] }[] | { message?: string };
        msg = Array.isArray(e) ? e.map((x) => `${x.errorCode}: ${x.message}${x.fields?.length ? ` [${x.fields.join(", ")}]` : ""}`).join("; ") : e.message ?? msg;
      } catch {
        /* keep text */
      }
      throw new Error(`Salesforce ${res.status}: ${msg}`);
    }
    if ((opts.accept ?? "").includes("csv") || !text) return text as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }
}

export const instanceUrl = async () => (await authenticate()).instance;

/** SOQL with automatic nextRecordsUrl paging. */
export async function soql(q: string, max = 2000, all = false, tooling = false): Promise<{ records: Rec[]; totalSize: number }> {
  let res = await sf<{ records: Rec[]; totalSize: number; nextRecordsUrl?: string; done: boolean }>(tooling ? "tooling/query" : all ? "queryAll" : "query", { query: { q } });
  const records = [...res.records];
  while (!res.done && res.nextRecordsUrl && records.length < max) {
    res = await sf(res.nextRecordsUrl);
    records.push(...res.records);
  }
  return { records: records.slice(0, max), totalSize: res.totalSize };
}

/** Drop "attributes" and flatten relationship objects (Owner: {Name} → Owner.Name). */
export function flat(r: Rec, prefix = ""): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "attributes") continue;
    if (v && typeof v === "object" && !Array.isArray(v) && "attributes" in (v as Rec)) Object.assign(out, flat(v as Rec, `${prefix}${k}.`));
    else if (v && typeof v === "object" && "records" in (v as Rec)) out[`${prefix}${k}`] = ((v as { records: Rec[] }).records ?? []).map((x) => flat(x));
    else if (v !== null) out[`${prefix}${k}`] = v;
  }
  return out;
}

// ---------- describe & name resolution ----------

type Field = { name: string; label: string; type: string; picklistValues?: { value: string; label: string; active: boolean }[]; referenceTo?: string[]; nillable: boolean; createable: boolean; updateable: boolean; defaultedOnCreate: boolean; relationshipName?: string; externalId?: boolean; custom?: boolean };
export type Describe = { name: string; label: string; fields: Field[]; recordTypeInfos?: { name: string; recordTypeId: string; active: boolean; master: boolean }[]; createable: boolean; queryable: boolean; keyPrefix?: string };
const describeCache = new Map<string, Promise<Describe>>();
export function describe(object: string): Promise<Describe> {
  const key = object.toLowerCase();
  if (!describeCache.has(key)) {
    const p = sf<Describe>(`sobjects/${object}/describe`);
    p.catch(() => describeCache.delete(key));
    describeCache.set(key, p);
  }
  return describeCache.get(key)!;
}

const norm = (s?: string) => (s ?? "").toLowerCase().replace(/__c$/, "").replace(/[\s_]+/g, "");

/** Field API name from an API name or a label ("Lead Source" → LeadSource, "Budget" → Budget__c). */
export async function fieldName(object: string, name: string): Promise<string> {
  const d = await describe(object);
  return d.fields.find((f) => f.name.toLowerCase() === name.toLowerCase())?.name ?? d.fields.find((f) => f.label.toLowerCase() === name.toLowerCase())?.name ?? d.fields.find((f) => norm(f.name) === norm(name) || norm(f.label) === norm(name))?.name ?? name;
}

/** Record values by label or API name; picklists by label; owner by name/email/"me"; dates like tomorrow. */
export async function toApi(object: string, values: Rec): Promise<Rec> {
  const d = await describe(object);
  const out: Rec = {};
  for (const [k, v] of Object.entries(values)) {
    const name = await fieldName(object, k);
    const f = d.fields.find((x) => x.name === name);
    let value = v;
    if (f?.type === "picklist" && typeof v === "string" && f.picklistValues?.length && !f.picklistValues.some((p) => p.value === v)) {
      const hit = f.picklistValues.find((p) => p.active && p.label.toLowerCase() === v.toLowerCase()) ?? f.picklistValues.find((p) => p.active && p.value.toLowerCase() === v.toLowerCase());
      if (!hit) throw new Error(`${f.label} must be one of: ${f.picklistValues.filter((p) => p.active).map((p) => p.value).join(", ")}`);
      value = hit.value;
    }
    if (f?.type === "reference" && f.referenceTo?.includes("User") && typeof v === "string" && !/^005/.test(v)) value = await userId(v);
    if ((f?.type === "date" || f?.type === "datetime") && typeof v === "string") value = f.type === "date" ? day(v) : dateTime(v);
    out[name] = value;
  }
  return out;
}

let meCache: Promise<{ user_id: string; name: string; email: string; organization_id: string; username: string }> | undefined;
export function me() {
  meCache ??= (async () => {
    const r = await sf<{ user_id: string; name: string; email: string; organization_id: string; preferred_username: string }>("/services/oauth2/userinfo");
    return { user_id: r.user_id, name: r.name, email: r.email, organization_id: r.organization_id, username: r.preferred_username };
  })();
  meCache.catch(() => (meCache = undefined));
  return meCache;
}

export const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** "me", an email, a username or a name → User Id. */
export async function userId(who: string): Promise<string> {
  if (/^005[A-Za-z0-9]{12,15}$/.test(who)) return who;
  if (who.toLowerCase() === "me") return (await me()).user_id;
  const w = esc(who);
  const { records } = await soql(`SELECT Id, Name FROM User WHERE IsActive = true AND (Email = '${w}' OR Username = '${w}' OR Name = '${w}' OR Name LIKE '%${w}%') LIMIT 5`, 5);
  const exact = records.filter((r) => String(r.Name).toLowerCase() === who.toLowerCase());
  if (exact.length === 1 || records.length === 1) return String((exact[0] ?? records[0]).Id);
  throw new Error(records.length ? `"${who}" matches ${records.map((r) => r.Name).join(", ")}` : `No active user "${who}"`);
}

// ---------- dates ----------

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function day(input: string): string {
  const s = input.trim().toLowerCase();
  const n = new Date();
  const at = (k: number) => ymd(new Date(n.getFullYear(), n.getMonth(), n.getDate() + k));
  if (s === "today") return at(0);
  if (s === "tomorrow") return at(1);
  if (s === "yesterday") return at(-1);
  const rel = s.match(/^([+-]\d+)\s*d/);
  if (rel) return at(Number(rel[1]));
  const wd = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(s.replace(/^next\s+/, ""));
  if (wd >= 0) return at(((wd - n.getDay() + 7) % 7) || 7);
  return input.slice(0, 10);
}
export function dateTime(input: string): string {
  const s = input.trim().toLowerCase();
  const rel = s.match(/^\+(\d+)\s*([mhd])$/);
  if (rel) return new Date(Date.now() + Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "m" | "h" | "d"]).toISOString();
  const m = s.match(/^(today|tomorrow|[+-]\d+d|\w+day)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    const [y, mo, d] = day(m[1]).split("-").map(Number);
    let h = Number(m[2]);
    if (m[4] === "pm" && h < 12) h += 12;
    if (m[4] === "am" && h === 12) h = 0;
    return new Date(y, mo - 1, d, h, Number(m[3] ?? 0)).toISOString();
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`Can't read the time "${input}"`);
  return d.toISOString();
}

export const PERIOD = z.enum(["THIS_MONTH", "LAST_MONTH", "THIS_QUARTER", "LAST_QUARTER", "THIS_YEAR", "LAST_N_DAYS:30", "LAST_N_DAYS:90", "THIS_FISCAL_QUARTER", "THIS_FISCAL_YEAR"]).optional();
export const confirm = z.boolean().default(false).describe("Required for deletes, bulk deletes and sending email");
export const money = (n: number) => Math.round(n * 100) / 100;
