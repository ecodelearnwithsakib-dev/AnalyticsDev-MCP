import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";

type Params = Record<string, unknown>;
export type Domain = unknown[];

export const baseUrl = () => requireEnv("ODOO_URL").replace(/\/+$/, "").replace(/\/(odoo|web).*$/, "");

/** Database: ODOO_DB, else the subdomain of *.odoo.com (Odoo Online's default). */
export function database(): string | undefined {
  const db = optionalEnv("ODOO_DB");
  if (db) return db;
  const host = new URL(baseUrl()).hostname;
  return host.endsWith(".odoo.com") ? host.split(".")[0] : undefined;
}

let protocol: Promise<"json2" | "jsonrpc"> | undefined;
let legacyUid: Promise<number> | undefined;

class OdooError extends Error {}

async function json2(model: string, method: string, body: Params): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `bearer ${requireEnv("ODOO_API_KEY")}`, "Content-Type": "application/json; charset=utf-8", "User-Agent": "analyticsdev-mcp" };
  const db = database();
  if (db) headers["X-Odoo-Database"] = db;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${baseUrl()}/json/2/${model}/${method}`, { method: "POST", headers, body: JSON.stringify(body) });
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1500));
      continue;
    }
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (res.ok) return data;
    if (res.status === 404 && typeof data !== "object") throw Object.assign(new OdooError("json2 route not found"), { notFound: true });
    const e = data as { name?: string; message?: string };
    const hint = res.status === 401 ? " — check ODOO_API_KEY (keys expire; create a new one under Preferences → Account Security)" : res.status === 403 ? " — the API key's user lacks access rights for this model" : "";
    throw new OdooError(`Odoo ${res.status} ${e?.name?.split(".").pop() ?? ""}: ${e?.message ?? String(text).slice(0, 300)}${hint}`);
  }
}

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${baseUrl()}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params: { service, method, args } }),
  });
  const data = (await res.json()) as { result?: unknown; error?: { message?: string; data?: { name?: string; message?: string } } };
  if (data.error) throw new OdooError(`Odoo ${data.error.data?.name?.split(".").pop() ?? "error"}: ${data.error.data?.message ?? data.error.message}`);
  return data.result;
}

function uid(): Promise<number> {
  legacyUid ??= (async () => {
    const db = database();
    if (!db) throw new OdooError("Set ODOO_DB (your database name) — needed for Odoo versions before 19");
    const id = await rpc("common", "authenticate", [db, requireEnv("ODOO_LOGIN"), requireEnv("ODOO_API_KEY"), {}]);
    if (!id) throw new OdooError("Odoo login failed — check ODOO_LOGIN (your user's email/login) and ODOO_API_KEY");
    return id as number;
  })();
  legacyUid.catch(() => (legacyUid = undefined));
  return legacyUid;
}

/** Which protocol this instance speaks: ODOO_PROTOCOL, else JSON-2 (Odoo 19+) with JSON-RPC fallback. */
export function detectProtocol(): Promise<"json2" | "jsonrpc"> {
  protocol ??= (async () => {
    const forced = optionalEnv("ODOO_PROTOCOL");
    if (forced === "json2" || forced === "jsonrpc") return forced;
    try {
      await json2("res.users", "context_get", {});
      return "json2" as const;
    } catch (error) {
      if ((error as { notFound?: boolean }).notFound) return "jsonrpc" as const;
      throw error;
    }
  })();
  protocol.catch(() => (protocol = undefined));
  return protocol;
}

/**
 * Calls a model method with named parameters. `ids` targets records (omit for @api.model methods).
 * Works on JSON-2 (/json/2/<model>/<method>) and legacy JSON-RPC execute_kw alike.
 */
export async function odoo<T = unknown>(model: string, method: string, params: Params = {}, ids?: number[]): Promise<T> {
  const context = { ...(optionalEnv("ODOO_LANG") ? { lang: optionalEnv("ODOO_LANG") } : {}), ...((params.context as object) ?? {}) };
  const rest = Object.fromEntries(Object.entries(params).filter(([k, v]) => k !== "context" && v !== undefined));
  if ((await detectProtocol()) === "json2") return json2(model, method, { ...(ids ? { ids } : {}), context, ...rest }) as Promise<T>;
  // execute_kw needs create's values positionally; everything else goes by name.
  const { vals_list, ...kwargs } = rest;
  const args = method === "create" && vals_list ? [vals_list] : ids ? [ids] : [];
  return rpc("object", "execute_kw", [database(), await uid(), requireEnv("ODOO_API_KEY"), model, method, args, method === "create" ? { ...kwargs, context } : { ...rest, context }]) as Promise<T>;
}

export async function version(): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl()}/web/webclient/version_info`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", params: {} }) });
  return ((await res.json()) as { result?: Record<string, unknown> }).result ?? {};
}

// ---------- fields & friendly values ----------

export type FieldInfo = { type: string; string: string; relation?: string; selection?: [string, string][]; required?: boolean; readonly?: boolean; store?: boolean };
const fieldCache = new Map<string, Promise<Record<string, FieldInfo>>>();

export function fieldsOf(model: string): Promise<Record<string, FieldInfo>> {
  if (!fieldCache.has(model)) {
    const p = odoo<Record<string, FieldInfo>>(model, "fields_get", { attributes: ["type", "string", "relation", "selection", "required", "readonly", "store"] });
    p.catch(() => fieldCache.delete(model));
    fieldCache.set(model, p);
  }
  return fieldCache.get(model)!;
}

/** Keep only the fields this Odoo version has (e.g. res.partner.mobile is gone in 19+). */
export async function existing(model: string, wanted: string[]): Promise<string[]> {
  const f = await fieldsOf(model);
  return wanted.filter((n) => n === "id" || f[n]);
}

/** Name → id via name_search; exact (case-insensitive) match wins, otherwise a single hit. */
export async function idByName(model: string, name: string, create = false): Promise<number> {
  const hits = await odoo<[number, string][]>(model, "name_search", { name, operator: "ilike", limit: 8 });
  const exact = hits.filter(([, n]) => n.toLowerCase() === name.toLowerCase() || n.toLowerCase().endsWith(` ${name.toLowerCase()}`));
  if (exact.length === 1 || (exact.length > 1 && exact[0][1].toLowerCase() === name.toLowerCase())) return exact[0][0];
  if (hits.length === 1) return hits[0][0];
  if (!hits.length && create) {
    const ids = await odoo<number[] | number>(model, "create", { vals_list: [{ name }] });
    return Array.isArray(ids) ? ids[0] : ids;
  }
  throw new OdooError(hits.length ? `"${name}" matches several ${model}: ${hits.map(([, n]) => n).join(", ")} — be more specific or pass the id` : `No ${model} named "${name}"`);
}

const AUTO_CREATE = new Set(["crm.tag", "res.partner.category", "project.tags", "product.tag"]);

/** Accept names for relations, labels for selections and "tomorrow"-style dates in values to write. */
export async function resolveVals(model: string, vals: Params): Promise<Params> {
  const fields = await fieldsOf(model);
  const out: Params = {};
  for (const [key, value] of Object.entries(vals)) {
    const f = fields[key];
    if (!f) throw new OdooError(`${model} has no field "${key}" — check odoo_models what=fields`);
    if (f.type === "many2one" && typeof value === "string" && !/^\d+$/.test(value)) out[key] = f.relation === "res.users" ? await userId(value) : await idByName(f.relation!, value);
    else if ((f.type === "many2many" || f.type === "one2many") && Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number") && f.type === "many2many")
      out[key] = [[6, 0, await Promise.all(value.map((v) => (typeof v === "number" ? v : idByName(f.relation!, v, AUTO_CREATE.has(f.relation!)))))]];
    else if (f.type === "selection" && typeof value === "string" && f.selection && !f.selection.some(([k]) => k === value)) {
      const hit = f.selection.find(([, label]) => label.toLowerCase() === value.toLowerCase());
      if (!hit) throw new OdooError(`${key} must be one of: ${f.selection.map(([k, l]) => `${k} (${l})`).join(", ")}`);
      out[key] = hit[0];
    } else if ((f.type === "date" || f.type === "datetime") && typeof value === "string") {
      const d = day(value) ?? value;
      out[key] = f.type === "datetime" && d.length === 10 ? `${d} 09:00:00` : d;
    } else out[key] = value;
  }
  return out;
}

/** Simple conditions → Odoo domain. Accepts a domain list as-is. */
export function toDomain(where?: unknown): Domain {
  if (!where) return [];
  if (Array.isArray(where)) return where;
  const out: Domain = [];
  for (const [k, v] of Object.entries(where as Params)) {
    if (v && typeof v === "object" && !Array.isArray(v)) for (const [op, val] of Object.entries(v)) out.push([k, op, val]);
    else if (Array.isArray(v)) out.push([k, "in", v]);
    else if (typeof v === "string" && v.includes("%")) out.push([k, "ilike", v.replace(/%/g, "")]);
    else out.push([k, "=", v]);
  }
  return out;
}

/** many2one [id, "Name"] → "Name" for readable output (id kept as <field>_id when asked). */
export function compact(record: Params): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(record)) {
    if (v === false && k !== "active") continue;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "string") out[k] = v[1];
    else if (Array.isArray(v) && !v.length) continue;
    else out[k] = v;
  }
  return out;
}

// ---------- dates ----------

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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
  return input;
}

export function period(preset?: string, from?: string, to?: string): { from: string; to: string } {
  if (from) return { from: day(from)!, to: day(to ?? "today")! };
  const n = new Date();
  const y = n.getFullYear();
  const m = n.getMonth();
  const q = Math.floor(m / 3) * 3;
  const d = (yy: number, mm: number, dd: number) => ymd(new Date(yy, mm, dd));
  switch (preset ?? "this_month") {
    case "last_month":
      return { from: d(y, m - 1, 1), to: d(y, m, 0) };
    case "this_quarter":
      return { from: d(y, q, 1), to: d(y, q + 3, 0) };
    case "last_quarter":
      return { from: d(y, q - 3, 1), to: d(y, q, 0) };
    case "this_year":
      return { from: d(y, 0, 1), to: d(y, 11, 31) };
    case "last_30_days":
      return { from: d(y, m, n.getDate() - 29), to: d(y, m, n.getDate()) };
    case "last_90_days":
      return { from: d(y, m, n.getDate() - 89), to: d(y, m, n.getDate()) };
    default:
      return { from: d(y, m, 1), to: d(y, m + 1, 0) };
  }
}

export const PERIOD = z.enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_30_days", "last_90_days"]).optional();

/** Current user (id, name, company) — context_get works on every version. */
let meCache: Promise<{ id: number; name: string; login?: string; company?: string; tz?: string }> | undefined;
export function me() {
  meCache ??= (async () => {
    const ctx = await odoo<{ uid?: number; tz?: string }>("res.users", "context_get");
    const id = ctx.uid ?? (await uid());
    const [u] = await odoo<Params[]>("res.users", "read", { fields: ["name", "login", "company_id"] }, [id]);
    return { id, name: u.name as string, login: u.login as string, company: (u.company_id as [number, string])?.[1], tz: ctx.tz };
  })();
  meCache.catch(() => (meCache = undefined));
  return meCache;
}

/** "me", a login/email, a name or an id → res.users id. */
export async function userId(who: string | number): Promise<number> {
  if (typeof who === "number" || /^\d+$/.test(who)) return Number(who);
  if (who.toLowerCase() === "me") return (await me()).id;
  const byLogin = await odoo<number[]>("res.users", "search", { domain: ["|", ["login", "=ilike", who], ["email", "=ilike", who]], limit: 1 });
  return byLogin[0] ?? idByName("res.users", who);
}

export const schema = {
  model: z.string().describe("Technical model, e.g. crm.lead, res.partner, sale.order, account.move, project.task, product.product"),
  where: z.union([z.array(z.unknown()), z.record(z.unknown())]).optional().describe("Odoo domain [[\"stage_id.name\",\"=\",\"Won\"]] or simple {field: value | [values] | {\"op\": value}}; strings with % use ilike"),
  fields: z.array(z.string()).optional(),
  confirm: z.boolean().default(false).describe("Required for deletes, sending messages to customers and confirming orders"),
};
