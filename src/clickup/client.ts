import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";

type Query = Record<string, unknown>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const BASE = "https://api.clickup.com/api";

/** Keys ending in [] repeat per value; arrays/objects otherwise go as JSON (e.g. custom_fields filters). */
function encode(query: Query = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (key.endsWith("[]") && Array.isArray(value)) value.forEach((v) => search.append(key, String(v)));
    else search.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** Calls the ClickUp API (path starts with v2/ or v3/); waits out 429s using X-RateLimit-Reset. */
export async function cu(method: Method, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<unknown> {
  const url = `${BASE}/${path.replace(/^\/+/, "").replace(/^api\//, "")}${encode(opts.query)}`;
  const headers: Record<string, string> = { Authorization: requireEnv("CLICKUP_API_TOKEN"), Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : { ok: true };
    } catch {
      // keep raw text
    }
    if ((res.status === 429 || res.status >= 502) && attempt < 4) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const wait = reset ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000));
      continue;
    }
    if (!res.ok) {
      const err = typeof data === "object" && data ? (data as { err?: string; ECODE?: string }) : {};
      const hint = res.status === 401 ? " — check CLICKUP_API_TOKEN (ClickUp → Settings → Apps → API Token, starts with pk_)" : "";
      throw new Error(`HTTP ${res.status} ${method} ${path}: ${err.err ?? String(text).slice(0, 800)}${err.ECODE ? ` (${err.ECODE})` : ""}${hint}`);
    }
    return data;
  }
}

type Member = { id: number; username?: string; email?: string; role?: number };
type Team = { id: string; name: string; members?: { user: Member }[] };

let teamsCache: Promise<Team[]> | undefined;
const teams = () => (teamsCache ??= cu("GET", "v2/team").then((r) => (r as { teams: Team[] }).teams));

/** Workspace (team) ID: argument, CLICKUP_TEAM_ID, or the only workspace the token can see. */
export async function teamId(id?: string): Promise<string> {
  if (id) return id;
  const configured = optionalEnv("CLICKUP_TEAM_ID");
  if (configured) return configured;
  const all = await teams();
  if (all.length === 1) return String(all[0].id);
  throw new Error(`Several workspaces — set CLICKUP_TEAM_ID or pass team_id: ${all.map((t) => `${t.name} (${t.id})`).join(", ")}`);
}

let me: Promise<Member> | undefined;
export const currentUser = () => (me ??= cu("GET", "v2/user").then((r) => (r as { user: Member }).user));

export async function members(team?: string): Promise<Member[]> {
  const id = await teamId(team);
  return ((await teams()).find((t) => String(t.id) === id)?.members ?? []).map((m) => m.user);
}

/** "me", user IDs, emails or (partial) names → ClickUp user IDs. */
export async function userIds(people: (string | number)[] | undefined, team?: string): Promise<number[]> {
  if (!people?.length) return [];
  const all = await members(team);
  const out: number[] = [];
  for (const p of people) {
    const q = String(p).trim().toLowerCase();
    if (q === "me") out.push((await currentUser()).id);
    else if (/^\d+$/.test(q)) out.push(Number(q));
    else {
      const hits = all.filter((m) => m.email?.toLowerCase() === q || m.username?.toLowerCase() === q);
      const fuzzy = hits.length ? hits : all.filter((m) => m.username?.toLowerCase().includes(q) || m.email?.toLowerCase().startsWith(q));
      if (fuzzy.length !== 1) {
        throw new Error(fuzzy.length ? `"${p}" matches several people: ${fuzzy.map((m) => `${m.username} <${m.email}>`).join(", ")}` : `No workspace member matches "${p}"`);
      }
      out.push(fuzzy[0].id);
    }
  }
  return out;
}

/** "2026-10-01", ISO datetime, Unix ms, today/tomorrow/yesterday or +3d / -2w → { ms, hasTime }. */
export function toMs(value: string | number): { ms: number; hasTime: boolean } {
  if (typeof value === "number" || /^\d{10,}$/.test(String(value))) return { ms: Number(value), hasTime: true };
  const v = String(value).trim().toLowerCase();
  const noon = (d: Date) => (d.setHours(12, 0, 0, 0), d.getTime());
  const rel = v.match(/^([+-]\d+)([dwm])$/);
  const named: Record<string, number> = { today: 0, tomorrow: 1, yesterday: -1 };
  if (v in named || rel) {
    const d = new Date();
    if (rel) {
      const n = Number(rel[1]);
      if (rel[2] === "m") d.setMonth(d.getMonth() + n);
      else d.setDate(d.getDate() + n * (rel[2] === "w" ? 7 : 1));
    } else d.setDate(d.getDate() + named[v]);
    return { ms: noon(d), hasTime: false };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return { ms: noon(new Date(y, m - 1, d)), hasTime: false };
  }
  const ms = Date.parse(String(value));
  if (Number.isNaN(ms)) throw new Error(`Can't read date "${value}" — use YYYY-MM-DD, an ISO datetime, today/tomorrow or +3d`);
  return { ms, hasTime: true };
}

export const PRIORITY: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
export const priority = z.enum(["urgent", "high", "normal", "low", "none"]);

const iso = (ms?: string | number | null) => (ms ? new Date(Number(ms)).toISOString().replace(":00.000Z", "Z") : undefined);

type RawTask = {
  id: string;
  custom_id?: string | null;
  name: string;
  status?: { status?: string };
  priority?: { priority?: string } | null;
  assignees?: Member[];
  due_date?: string | null;
  start_date?: string | null;
  date_updated?: string;
  date_closed?: string | null;
  tags?: { name: string }[];
  list?: { id: string; name?: string };
  folder?: { name?: string; hidden?: boolean };
  space?: { id: string };
  url?: string;
  time_estimate?: number | null;
  points?: number | null;
  parent?: string | null;
};

/** Compact task for listings. */
export function compactTask(t: RawTask) {
  return {
    id: t.id,
    custom_id: t.custom_id ?? undefined,
    name: t.name,
    status: t.status?.status,
    priority: t.priority?.priority ?? undefined,
    assignees: t.assignees?.map((a) => a.username ?? a.email),
    due: iso(t.due_date),
    start: iso(t.start_date),
    tags: t.tags?.length ? t.tags.map((x) => x.name) : undefined,
    list: t.list?.name,
    folder: t.folder?.hidden ? undefined : t.folder?.name,
    parent: t.parent ?? undefined,
    estimate_h: t.time_estimate ? Math.round((t.time_estimate / 3_600_000) * 100) / 100 : undefined,
    points: t.points ?? undefined,
    closed: iso(t.date_closed),
    url: t.url,
  };
}

type Field = { id: string; name: string; type: string; type_config?: { options?: { id: string; name?: string; label?: string; orderindex?: number }[] } };

/** Custom field definitions visible on a list (task-level fields). */
export const listFields = async (listId: string) => ((await cu("GET", `v2/list/${listId}/field`)) as { fields: Field[] }).fields;

/** Convert a friendly value (option names, people, dates) into what ClickUp expects for the field type. */
export async function fieldValue(field: Field, value: unknown, team?: string): Promise<unknown> {
  const options = field.type_config?.options ?? [];
  const option = (v: unknown) => {
    const q = String(v).toLowerCase();
    const hit = options.find((o) => o.id === v || (o.name ?? o.label)?.toLowerCase() === q);
    if (!hit) throw new Error(`"${v}" isn't an option of "${field.name}": ${options.map((o) => o.name ?? o.label).join(", ")}`);
    return hit.id;
  };
  switch (field.type) {
    case "drop_down":
      return option(value);
    case "labels":
      return (Array.isArray(value) ? value : [value]).map(option);
    case "users":
      return { add: await userIds((Array.isArray(value) ? value : [value]) as string[], team), rem: [] };
    case "date":
      return toMs(value as string).ms;
    case "checkbox":
      return value === true || value === "true" || value === "yes";
    case "number":
    case "currency":
    case "emoji":
      return Number(value);
    case "tasks":
      return { add: Array.isArray(value) ? value : [value], rem: [] };
    default:
      return value;
  }
}

/** [{field: name|id, value}] → ClickUp custom_fields payload for a list. */
export async function resolveFields(listId: string, items: { field: string; value?: unknown }[] | undefined, team?: string) {
  if (!items?.length) return undefined;
  const fields = await listFields(listId);
  return Promise.all(
    items.map(async ({ field, value }) => {
      const f = fields.find((x) => x.id === field || x.name.toLowerCase() === field.toLowerCase());
      if (!f) throw new Error(`No custom field "${field}" on this list: ${fields.map((x) => x.name).join(", ")}`);
      return { id: f.id, value: await fieldValue(f, value, team) };
    }),
  );
}

export const schema = {
  team_id: z.string().optional().describe("Workspace ID; defaults to CLICKUP_TEAM_ID or your only workspace"),
  people: z.array(z.string()).optional().describe("\"me\", names, emails or user IDs"),
  date: z.string().optional().describe("YYYY-MM-DD, ISO datetime, today/tomorrow, or +3d / +2w"),
  confirm: z.boolean().default(false).describe("Required for permanent deletes"),
  fields: z.array(z.object({ field: z.string().describe("Custom field name or ID"), value: z.unknown() })).optional().describe("Custom field values by name; dropdown/label options by name, people by name/email"),
};
