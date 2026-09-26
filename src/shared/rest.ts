import { optionalEnv, requireEnv, saveEnv } from "./env.js";

export type Query = Record<string, string | number | boolean | undefined | null | (string | number)[]>;
export type CallOpts = { method?: string; query?: Query; body?: unknown; form?: Record<string, string | undefined>; raw?: BodyInit; headers?: Record<string, string>; rawResponse?: boolean };

/** Pulls a readable message out of the common API error shapes. */
export function errorMessage(data: unknown, text: string): string {
  const d = data as Record<string, unknown> | undefined;
  const e = d?.error as Record<string, unknown> | string | undefined;
  const first = (arr: unknown) => (Array.isArray(arr) && arr.length ? (arr[0] as Record<string, unknown>) : undefined);
  const candidates = [
    typeof e === "string" ? `${e}${d?.error_description ? `: ${d.error_description}` : ""}` : undefined,
    typeof e === "object" ? (e.message as string) ?? (e.detail as string) : undefined,
    d?.message as string,
    d?.detail as string,
    first(d?.errors)?.message as string,
    first(d?.errors)?.detail as string,
    d?.title as string,
  ].filter(Boolean);
  return candidates[0] ?? text.slice(0, 300);
}

/**
 * Small REST client with JSON bodies, query strings (arrays → repeated or comma-joined),
 * retries on 429/5xx honouring Retry-After, and readable errors.
 */
export function restClient(opts: { name: string; base: () => string; headers: () => Promise<Record<string, string>> | Record<string, string>; arrayFormat?: "repeat" | "comma"; hints?: Record<number, string>; onUnauthorized?: () => void }) {
  return async function call<T = Record<string, unknown>>(path: string, o: CallOpts = {}): Promise<T> {
    const url = new URL(path.startsWith("http") ? path : `${opts.base().replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) {
        if (opts.arrayFormat === "comma") url.searchParams.set(k, v.join(","));
        else for (const x of v) url.searchParams.append(k, String(x));
      } else url.searchParams.set(k, String(v));
    }
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Accept: "application/json", ...(await opts.headers()), ...o.headers };
      let body: BodyInit | undefined = o.raw;
      if (o.form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(Object.entries(o.form).filter(([, v]) => v !== undefined) as [string, string][]).toString();
      } else if (o.body !== undefined) {
        headers["Content-Type"] ??= "application/json";
        body = JSON.stringify(o.body);
      }
      const res = await fetch(url, { method: o.method ?? (body !== undefined ? "POST" : "GET"), headers, body });
      if (res.status === 401 && attempt === 0 && opts.onUnauthorized) {
        opts.onUnauthorized();
        continue;
      }
      if ((res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) && attempt < 4) {
        const ra = Number(res.headers.get("retry-after") ?? 0);
        await new Promise((r) => setTimeout(r, Math.min(ra ? ra * 1000 : 2 ** attempt * 1500, 60_000)));
        continue;
      }
      if (o.rawResponse && res.ok) return res as unknown as T;
      if (res.status === 204) return {} as T;
      const text = await res.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        /* keep text */
      }
      if (!res.ok) throw new Error(`${opts.name} ${res.status}: ${errorMessage(data, text)}${opts.hints?.[res.status] ? ` — ${opts.hints[res.status]}` : ""}`);
      return data as T;
    }
  };
}

/**
 * OAuth2 refresh-token flow with in-memory access-token caching. Rotated refresh tokens are
 * saved back to .env (or the Keychain) automatically.
 */
export function oauthRefresher(cfg: { tokenUrl: string | (() => string); clientIdEnv: string; clientSecretEnv?: string; refreshTokenEnv: string; basicAuth?: boolean; extra?: Record<string, string>; signinHint: string }) {
  let cached: { token: string; expires: number } | undefined;
  const get = async (): Promise<string> => {
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    const refresh = requireEnv(cfg.refreshTokenEnv);
    const id = requireEnv(cfg.clientIdEnv);
    const secret = cfg.clientSecretEnv ? optionalEnv(cfg.clientSecretEnv) : "";
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, ...(cfg.basicAuth ? {} : { client_id: id, ...(secret ? { client_secret: secret } : {}) }), ...cfg.extra });
    const res = await fetch(typeof cfg.tokenUrl === "function" ? cfg.tokenUrl() : cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...(cfg.basicAuth ? { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` } : {}) },
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
    if (!data.access_token) throw new Error(`Token refresh failed (${data.error ?? res.status}${data.error_description ? `: ${data.error_description}` : ""}) — ${cfg.signinHint}`);
    if (data.refresh_token && data.refresh_token !== refresh) saveEnv(cfg.refreshTokenEnv, data.refresh_token);
    cached = { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return cached.token;
  };
  return { get, reset: () => (cached = undefined) };
}

/** SHA-256 hex of normalised PII (emails lower-cased/trimmed, phones digits-only with +). */
export async function sha256(value: string, kind: "email" | "phone" | "id" = "id"): Promise<string> {
  const { createHash } = await import("node:crypto");
  if (/^[0-9a-f]{64}$/.test(value)) return value;
  const norm = kind === "email" ? value.trim().toLowerCase() : kind === "phone" ? value.replace(/[^\d]/g, "") : value.trim();
  return createHash("sha256").update(norm).digest("hex");
}
