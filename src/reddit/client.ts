import { createHash } from "node:crypto";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";

export type Rec = Record<string, unknown>;
type Query = Record<string, string | number | boolean | undefined | null>;

/** One OAuth app, one sign-in: Data API (community) + Ads API scopes. */
export const SCOPES = "identity read history mysubreddits submit edit privatemessages save modposts modlog adsread adsedit adsconversions";

export const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
export const userAgent = () => optionalEnv("REDDIT_USER_AGENT", "node:analyticsdev-mcp:0.1.0 (by /u/analyticsdev)");
const ADS_BASE = () => optionalEnv("REDDIT_ADS_API_BASE", "https://ads-api.reddit.com/api/v3");
const DATA_BASE = () => optionalEnv("REDDIT_DATA_API_BASE", "https://oauth.reddit.com");
const AUTH_URL = () => optionalEnv("REDDIT_TOKEN_URL", TOKEN_URL);

let cached: { token: string; expires: number } | undefined;

export const basicAuth = () => `Basic ${Buffer.from(`${requireEnv("REDDIT_CLIENT_ID")}:${optionalEnv("REDDIT_CLIENT_SECRET")}`).toString("base64")}`;

async function accessToken(): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await fetch(AUTH_URL(), {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent() },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: requireEnv("REDDIT_REFRESH_TOKEN") }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!data.access_token) throw new Error(`Reddit token refresh failed (${data.error ?? res.status}) — run \`npm run auth:reddit\` again`);
  cached = { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function call<T>(base: string, path: string, opts: { method?: string; query?: Query; body?: unknown; form?: Record<string, string | undefined>; bearer?: string }): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.bearer ?? (await accessToken())}`, "User-Agent": userAgent(), Accept: "application/json" };
    let body: string | undefined;
    if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(Object.entries(opts.form).filter(([, v]) => v !== undefined) as [string, string][]).toString();
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, { method: opts.method ?? (body ? "POST" : "GET"), headers, body });
    if (res.status === 401 && attempt === 0 && !opts.bearer) {
      cached = undefined;
      continue;
    }
    if ((res.status === 429 || res.status >= 502) && attempt < 4) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? res.headers.get("retry-after") ?? 0);
      await new Promise((r) => setTimeout(r, Math.min(reset * 1000 || 2 ** attempt * 2000, 60_000)));
      continue;
    }
    if (res.status === 204) return {} as T;
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const e = data as { error?: { message?: string; code?: string; fields?: unknown } | string; message?: string; explanation?: string };
      const msg = typeof e?.error === "object" ? `${e.error.code ?? ""} ${e.error.message ?? ""}${e.error.fields ? ` ${JSON.stringify(e.error.fields)}` : ""}` : e?.message ?? e?.explanation ?? e?.error ?? String(text).slice(0, 300);
      const hint = res.status === 403 ? " — the signed-in account lacks access (Ads: be a member of the ad account; community: moderator rights or a missing scope)" : res.status === 401 ? " — run `npm run auth:reddit` again" : "";
      throw new Error(`Reddit ${res.status}: ${String(msg).trim()}${hint}`);
    }
    return data as T;
  }
}

/** Ads API v3 (https://ads-api.reddit.com/api/v3). */
export const ads = <T = { data?: unknown; pagination?: { next_url?: string } }>(path: string, opts: { method?: string; query?: Query; body?: unknown; bearer?: string } = {}) => call<T>(ADS_BASE(), path, opts);

/** Data API (https://oauth.reddit.com) for community/organic work. */
export const reddit = <T = Rec>(path: string, opts: { method?: string; query?: Query; form?: Record<string, string | undefined> } = {}) => call<T>(DATA_BASE(), path, { ...opts, query: { raw_json: 1, ...opts.query } });

/** Follows Ads API pagination (next_url) up to `max` items. */
export async function adsAll(path: string, query: Query = {}, max = 1000): Promise<Rec[]> {
  const out: Rec[] = [];
  let next: string | undefined = path;
  let q: Query = { ...query, "page.size": 700 };
  while (next && out.length < max) {
    const res: { data?: Rec[]; pagination?: { next_url?: string } } = await ads(next, { query: q });
    out.push(...(res.data ?? []));
    next = res.pagination?.next_url || undefined;
    q = {};
  }
  return out.slice(0, max);
}

export const adAccountId = (id?: string) => id ?? requireEnv("REDDIT_AD_ACCOUNT_ID");

/** Money helpers: Ads API amounts are micro-currency. */
export const toMicros = (v?: number) => (v === undefined ? undefined : Math.round(v * 1_000_000));
export const fromMicros = (v: unknown) => (v === null || v === undefined ? undefined : Math.round((Number(v) / 1_000_000) * 100) / 100);

/** SHA-256 of normalized PII so raw emails/phones never leave the machine. */
export function sha256(v: string, kind: "email" | "phone" | "id" = "id"): string {
  if (/^[0-9a-f]{64}$/.test(v)) return v;
  const norm = kind === "email" ? v.trim().toLowerCase() : kind === "phone" ? v.replace(/[^\d+]/g, "") : v.trim();
  return createHash("sha256").update(norm).digest("hex");
}

// ---------- dates ----------

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export function day(input: string): string {
  const s = input.trim().toLowerCase();
  const n = new Date();
  const at = (k: number) => ymd(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + k)));
  if (s === "today") return at(0);
  if (s === "yesterday") return at(-1);
  if (s === "tomorrow") return at(1);
  const rel = s.match(/^([+-]\d+)\s*d/);
  if (rel) return at(Number(rel[1]));
  return input.slice(0, 10);
}

/** Preset or from/to → report window at hourly granularity (ends_at exclusive, next midnight). */
export function reportWindow(preset?: string, from?: string, to?: string): { starts_at: string; ends_at: string; from: string; to: string } {
  const n = new Date();
  const d = (k: number) => ymd(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + k)));
  let f: string;
  let t: string;
  if (from) [f, t] = [day(from), day(to ?? "yesterday")];
  else
    switch (preset ?? "last_7_days") {
      case "today":
        [f, t] = [d(0), d(0)];
        break;
      case "yesterday":
        [f, t] = [d(-1), d(-1)];
        break;
      case "last_14_days":
        [f, t] = [d(-14), d(-1)];
        break;
      case "last_30_days":
        [f, t] = [d(-30), d(-1)];
        break;
      case "this_month":
        [f, t] = [`${ymd(n).slice(0, 8)}01`, d(0)];
        break;
      case "last_month": {
        const first = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1));
        const last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 0));
        [f, t] = [ymd(first), ymd(last)];
        break;
      }
      default:
        [f, t] = [d(-7), d(-1)];
    }
  const end = new Date(`${t}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { starts_at: `${f}T00:00:00Z`, ends_at: `${end.toISOString().slice(0, 13)}:00:00Z`, from: f, to: t };
}

export const PRESET = z.enum(["today", "yesterday", "last_7_days", "last_14_days", "last_30_days", "this_month", "last_month"]).optional();
export const confirm = z.boolean().default(false).describe("Required to post, comment, message, delete, remove, or send real conversions");

/** "t3_abc" / "abc" / a reddit.com URL → fullname with the given prefix. */
export function fullname(ref: string, prefix: "t1" | "t3" | "t4" | "t5"): string {
  const url = ref.match(/comments\/([a-z0-9]+)(?:\/[^/]*\/([a-z0-9]+))?/i);
  if (url) return url[2] && prefix === "t1" ? `t1_${url[2]}` : `t3_${url[1]}`;
  return /^t\d_/.test(ref) ? ref : `${prefix}_${ref}`;
}
export const subredditName = (s: string) => s.replace(/^\/?r\//i, "").replace(/^https?:\/\/(www\.)?reddit\.com\/r\//, "").replace(/\/.*$/, "");
