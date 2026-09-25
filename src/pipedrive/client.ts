import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";

type Query = Record<string, string | number | boolean | undefined | null>;
export type Rec = Record<string, unknown>;

/** https://<company>.pipedrive.com — accepts "acme", "acme.pipedrive.com" or a full URL. */
export function baseUrl(): string {
  const d = requireEnv("PIPEDRIVE_DOMAIN").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return optionalEnv("PIPEDRIVE_API_BASE") || `https://${d.includes(".") ? d : `${d}.pipedrive.com`}`;
}

/**
 * Calls the API. Paths: "v2/deals" → /api/v2/deals, "v1/notes" → /v1/notes.
 * Returns the full envelope ({ success, data, additional_data }).
 */
export async function pd<T = { data?: unknown; additional_data?: Rec }>(path: string, opts: { method?: string; query?: Query; body?: unknown } = {}): Promise<T> {
  const clean = path.replace(/^\//, "");
  const url = new URL(`${baseUrl()}/${clean.startsWith("v2/") ? `api/${clean}` : clean.startsWith("v1/") ? clean : `api/v2/${clean}`}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: { "x-api-token": requireEnv("PIPEDRIVE_API_TOKEN"), Accept: "application/json", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if ((res.status === 429 || res.status >= 502) && attempt < 4) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 0) * 1000 || 2 ** attempt * 1500));
      continue;
    }
    const text = await res.text();
    let data: Rec = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (!res.ok || data.success === false) {
      const msg = (data.error as string) ?? (data.message as string) ?? text.slice(0, 300);
      const hint = res.status === 401 ? " — check PIPEDRIVE_API_TOKEN (Personal preferences → API) and PIPEDRIVE_DOMAIN" : res.status === 403 ? " — your Pipedrive user lacks permission for this" : "";
      throw new Error(`Pipedrive ${res.status}: ${msg}${data.error_info ? ` (${data.error_info})` : ""}${hint}`);
    }
    return data as T;
  }
}

/** Follows cursor (v2) or start (v1) pagination up to `max` items. */
export async function all(path: string, query: Query = {}, max = 500): Promise<Rec[]> {
  const out: Rec[] = [];
  const v1 = path.startsWith("v1/");
  let cursor: string | undefined;
  let start = 0;
  while (out.length < max) {
    const res = await pd<{ data?: Rec[] | null; additional_data?: { next_cursor?: string; pagination?: { more_items_in_collection?: boolean; next_start?: number } } }>(path, {
      query: { ...query, limit: Math.min(v1 ? 500 : 500, max - out.length), ...(v1 ? { start } : { cursor }) },
    });
    out.push(...(res.data ?? []));
    if (v1) {
      if (!res.additional_data?.pagination?.more_items_in_collection) break;
      start = res.additional_data.pagination.next_start ?? start + 500;
    } else {
      cursor = res.additional_data?.next_cursor;
      if (!cursor) break;
    }
  }
  return out;
}

// ---------- lookups ----------

const memo = new Map<string, Promise<unknown>>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!memo.has(key)) {
    const p = load();
    p.catch(() => memo.delete(key));
    memo.set(key, p);
  }
  return memo.get(key) as Promise<T>;
}

const norm = (s?: unknown) => String(s ?? "").toLowerCase().trim();

export type User = { id: number; name: string; email: string; active_flag?: boolean; is_admin?: number };
export const users = () => cached("users", async () => ((await pd<{ data: User[] }>("v1/users")).data ?? []));
export const me = () => cached("me", async () => (await pd<{ data: User & { company_name?: string; company_domain?: string; default_currency?: string; timezone_name?: string } }>("v1/users/me")).data);

export async function userId(who: string | number): Promise<number> {
  if (typeof who === "number" || /^\d+$/.test(who)) return Number(who);
  if (norm(who) === "me") return (await me()).id;
  const list = await users();
  const hit = list.find((u) => norm(u.email) === norm(who)) ?? list.find((u) => norm(u.name) === norm(who)) ?? list.filter((u) => norm(u.name).includes(norm(who)));
  if (Array.isArray(hit)) {
    if (hit.length === 1) return hit[0].id;
    throw new Error(hit.length ? `"${who}" matches ${hit.map((u) => u.name).join(", ")}` : `No Pipedrive user "${who}"`);
  }
  return hit.id;
}
export const userName = async (id?: unknown) => (id ? (await users().catch(() => [] as User[])).find((u) => u.id === Number(id))?.name ?? id : undefined);

export type Stage = { id: number; name: string; pipeline_id: number; deal_probability?: number; order_nr?: number; rotten_days?: number | null };
export type Pipeline = { id: number; name: string };
export const pipelines = () => cached("pipelines", async () => ((await pd<{ data: Pipeline[] }>("v2/pipelines")).data ?? []));
export const stages = () => cached("stages", async () => all("v2/stages", {}, 1000) as Promise<Stage[]>);

export async function pipelineId(p: string | number): Promise<number> {
  if (typeof p === "number" || /^\d+$/.test(p)) return Number(p);
  const list = await pipelines();
  const hit = list.find((x) => norm(x.name) === norm(p)) ?? list.find((x) => norm(x.name).includes(norm(p)));
  if (!hit) throw new Error(`No pipeline "${p}" — pipelines: ${list.map((x) => x.name).join(", ")}`);
  return hit.id;
}

export async function stageId(s: string | number, pipeline?: string | number): Promise<{ stage_id: number; pipeline_id: number }> {
  const list = await stages();
  if (typeof s === "number" || /^\d+$/.test(String(s))) {
    const hit = list.find((x) => x.id === Number(s));
    return { stage_id: Number(s), pipeline_id: hit?.pipeline_id ?? 0 };
  }
  const pid = pipeline !== undefined ? await pipelineId(pipeline) : undefined;
  const scope = list.filter((x) => pid === undefined || x.pipeline_id === pid);
  const hits = scope.filter((x) => norm(x.name) === norm(s));
  const hit = hits.length === 1 ? hits[0] : hits.length > 1 ? undefined : scope.find((x) => norm(x.name).includes(norm(s)));
  if (!hit) throw new Error(hits.length > 1 ? `Stage "${s}" exists in several pipelines — pass pipeline` : `No stage "${s}"${pid ? " in that pipeline" : ""} — stages: ${scope.map((x) => x.name).join(", ")}`);
  return { stage_id: hit.id, pipeline_id: hit.pipeline_id };
}

export const stageName = async (id?: unknown) => (await stages().catch(() => [] as Stage[])).find((s) => s.id === Number(id))?.name;
export const pipelineName = async (id?: unknown) => (await pipelines().catch(() => [] as Pipeline[])).find((p) => p.id === Number(id))?.name;

// ---------- custom fields ----------

export type Field = { key: string; name: string; field_type: string; options?: { id: number; label: string }[]; edit_flag?: boolean };
export type Entity = "deal" | "person" | "organization" | "product" | "activity";
export const fields = (entity: Entity) => cached(`fields:${entity}`, async () => all(`v1/${entity === "organization" ? "organization" : entity}Fields`, {}, 2000) as Promise<Field[]>);

const HASH = /^[0-9a-f]{40}$/;

/** {"Lead source": "Facebook", "Budget": 5000} → {hash: optionId | value} for v2 custom_fields. */
export async function customFieldValues(entity: Entity, values?: Rec): Promise<Rec | undefined> {
  if (!values) return undefined;
  const list = await fields(entity);
  const out: Rec = {};
  for (const [k, v] of Object.entries(values)) {
    const f = HASH.test(k) ? list.find((x) => x.key === k) : list.find((x) => norm(x.name) === norm(k) || x.key === k);
    if (!f) throw new Error(`No ${entity} field "${k}" — see pipedrive_setup what=fields`);
    const option = (label: unknown) => {
      if (typeof label === "number") return label;
      const o = f.options?.find((x) => norm(x.label) === norm(label));
      if (!o) throw new Error(`"${label}" is not an option of ${f.name}: ${f.options?.map((x) => x.label).join(", ")}`);
      return o.id;
    };
    out[f.key] = f.field_type === "enum" ? option(v) : f.field_type === "set" ? (Array.isArray(v) ? v : [v]).map(option) : f.field_type === "user" && typeof v === "string" ? await userId(v) : v;
  }
  return out;
}

/** Custom field hashes → names and option ids → labels, for reading. */
export async function readableCustom(entity: Entity, custom?: Rec | null): Promise<Rec | undefined> {
  if (!custom) return undefined;
  const list = await fields(entity).catch(() => [] as Field[]);
  const out: Rec = {};
  for (const [k, v] of Object.entries(custom)) {
    if (v === null || v === undefined || v === "") continue;
    const f = list.find((x) => x.key === k);
    const label = (id: unknown) => f?.options?.find((o) => o.id === Number(id))?.label ?? id;
    out[f?.name ?? k] = f?.field_type === "enum" ? label(v) : f?.field_type === "set" && Array.isArray(v) ? v.map(label) : v;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------- dates ----------

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function day(input?: string): string | undefined {
  if (!input) return undefined;
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
export const money = (n: number) => Math.round(n * 100) / 100;
export const confirm = z.boolean().default(false).describe("Required for deletes and merges");
