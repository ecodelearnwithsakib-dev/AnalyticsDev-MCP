import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";

type Query = Record<string, unknown>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";

export const baseUrl = () => optionalEnv("OPENAI_ADS_API_BASE", "https://api.ads.openai.com/v1").replace(/\/+$/, "");

/** Arrays go out as repeated key[] params; objects inside them (insights time_ranges, filters, sort) as JSON strings. */
function encode(query: Query): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(`${key}[]`, typeof item === "string" ? item : JSON.stringify(item));
    } else {
      search.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  form?: FormData;
  /** Create endpoints accept Idempotency-Key so a network retry can't create a duplicate. */
  idempotencyKey?: string | boolean;
  apiKey?: string;
  url?: string;
}

/** Calls the Ads API, retrying 429/503 with Retry-After (limits: 600/min per endpoint, 1,200/min overall). */
export async function oai(method: Method, path: string, opts: RequestOptions = {}): Promise<unknown> {
  const url = opts.url ?? `${baseUrl()}/${path.replace(/^\/+/, "")}${encode(opts.query ?? {})}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey ?? requireEnv("OPENAI_ADS_API_KEY")}`,
    Accept: "application/json",
  };
  // Partner keys pick the client account with this header; per-account keys must not send it.
  const account = optionalEnv("OPENAI_ADS_AD_ACCOUNT_ID");
  if (account && !opts.apiKey) headers["OpenAI-Ad-Account"] = account;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey === true ? randomUUID() : opts.idempotencyKey;
  const payload = opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers, body: payload });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON response; keep the raw text.
    }
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
      continue;
    }
    if (!res.ok) {
      const detail = typeof body === "string" ? body : JSON.stringify(body);
      const requestId = res.headers.get("x-request-id");
      const hint = res.status === 401 ? " — check the API key in .env (Ads Manager → Settings → API keys)" : "";
      throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${requestId ? ` (request ${requestId})` : ""}: ${detail}${hint}`);
    }
    return body;
  }
}

type Page = { data?: Record<string, unknown>[]; has_more?: boolean; last_id?: string };

/** GET a list endpoint and follow `after` cursors until `limit` items are collected. */
export async function listAll(path: string, query: Query = {}, limit = 100, cursorKey = "id") {
  const data: Record<string, unknown>[] = [];
  let after: string | undefined;
  let page: Page;
  do {
    page = (await oai("GET", path, { query: { ...query, limit: Math.min(limit - data.length, 100), after } })) as Page;
    data.push(...(page.data ?? []));
    after = page.last_id ?? (page.data?.at(-1)?.[cursorKey] as string | undefined);
  } while (page.has_more && after && data.length < limit);
  return { count: data.length, has_more: Boolean(page.has_more), data };
}

let accountCurrency: string | undefined;

/** Currency of the ad account behind the key (cached); OPENAI_ADS_CURRENCY overrides. */
export async function currency(): Promise<string> {
  accountCurrency ??= optionalEnv("OPENAI_ADS_CURRENCY") || ((await oai("GET", "ad_account")) as { currency_code?: string }).currency_code || "USD";
  return accountCurrency;
}

/** Decimal places of a currency's minor unit (USD 2, JPY 0, KWD 3). */
export const minorDigits = (code: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency: code.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;

/** Currency units → micros, rounded to the currency's smallest unit (multiples of 10,000 for USD). */
export async function toMicros(amount: number): Promise<number> {
  const digits = minorDigits(await currency());
  return Math.round(amount * 10 ** digits) * 10 ** (6 - digits);
}

/** Currency units → integer minor units (42.5 USD → 4250), as the Conversions API and feeds expect. */
export const toMinor = (amount: number, code: string) => Math.round(amount * 10 ** minorDigits(code));

export const fromMicros = (value: unknown) => (value === null || value === undefined ? value : Number(value) / 1e6);

/** Convert every *_micros field in a response to currency units, keeping the original key name minus the suffix. */
export function humanize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(humanize);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key.endsWith("_micros") && (typeof v === "number" || typeof v === "string")) out[key.replace(/_micros$/, "")] = fromMicros(v);
    else out[key] = humanize(v);
  }
  return out;
}

/** "2026-10-01" or ISO datetime → Unix seconds. */
export function unixTime(value: string): number {
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(ms)) throw new Error(`Invalid date: ${value}`);
  return Math.floor(ms / 1000);
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const isHash = (value: string) => /^[a-f0-9]{64}$/i.test(value.trim());

/** PII hashing per the Ads normalization rules; values that are already SHA-256 digests pass through. */
export const hashPii = {
  email: (v: string) => (isHash(v) ? v.trim().toLowerCase() : sha256(v.trim().toLowerCase())),
  /** Conversions API: country code + number, digits only, no leading + or zeroes. */
  phoneDigits: (v: string) => (isHash(v) ? v.trim().toLowerCase() : sha256(v.replace(/[^\d]/g, "").replace(/^0+/, ""))),
  /** Custom audiences: E.164 with the leading +. */
  phoneE164: (v: string) => (isHash(v) ? v.trim().toLowerCase() : sha256(`+${v.replace(/[^\d]/g, "").replace(/^0+/, "")}`)),
  name: (v: string) => (isHash(v) ? v.trim().toLowerCase() : sha256(v.toLowerCase().replace(/[\s!-/:-@[-`{-~]/g, ""))),
  externalId: (v: string) => (isHash(v) ? v.trim().toLowerCase() : sha256(v.trim())),
};

export const KINDS = { campaign: "campaigns", ad_group: "ad_groups", ad: "ads" } as const;
export type Kind = keyof typeof KINDS;

export const schema = {
  status: z.enum(["active", "paused"]).default("paused").describe("Created paused by default so nothing spends by accident"),
  limit: z.number().int().min(1).max(2000).default(100).describe("Max items to return (follows pagination)"),
  landingQuery: z.string().optional().describe("Query string appended to landing URLs, e.g. utm_source=chatgpt&utm_medium=cpc&utm_campaign={campaign_id}"),
  kind: z.enum(["campaign", "ad_group", "ad"]),
};
