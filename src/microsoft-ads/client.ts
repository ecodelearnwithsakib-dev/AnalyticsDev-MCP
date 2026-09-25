import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { optionalEnv, requireEnv, saveEnv } from "../shared/env.js";
import { oauthClientCredentials, PROFILES } from "../shared/google-auth.js";

export const MS_SCOPE = "https://ads.microsoft.com/msads.manage offline_access";
export const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

const SERVICES = {
  campaign: "campaign.api.bingads.microsoft.com/CampaignManagement/v13",
  reporting: "reporting.api.bingads.microsoft.com/Reporting/v13",
  customer: "clientcenter.api.bingads.microsoft.com/CustomerManagement/v13",
  adinsight: "adinsight.api.bingads.microsoft.com/AdInsight/v13",
  bulk: "bulk.api.bingads.microsoft.com/Bulk/v13",
} as const;
export type Service = keyof typeof SERVICES;

const sandbox = () => optionalEnv("MSADS_ENVIRONMENT").toLowerCase() === "sandbox";

export function serviceUrl(service: Service, path: string): string {
  const host = sandbox() ? SERVICES[service].replace(".api.", ".api.sandbox.") : SERVICES[service];
  return `https://${host}/${path.replace(/^\/+/, "")}`;
}

type Token = { value: string; expires: number; google: boolean };
let token: Token | undefined;

/**
 * Access token from whichever sign-in the user did: a Microsoft account (MSADS_REFRESH_TOKEN,
 * rotated back into .env on every refresh) or Google (MSADS_GOOGLE_REFRESH_TOKEN, sent with IdentityProvider: Google).
 */
async function accessToken(): Promise<Token> {
  if (token && token.expires > Date.now() + 60_000) return token;
  const msRefresh = optionalEnv("MSADS_REFRESH_TOKEN");
  if (msRefresh) {
    const form = new URLSearchParams({
      client_id: requireEnv("MSADS_CLIENT_ID"),
      grant_type: "refresh_token",
      refresh_token: msRefresh,
      scope: MS_SCOPE,
    });
    const secret = optionalEnv("MSADS_CLIENT_SECRET");
    if (secret) form.set("client_secret", secret);
    const res = await fetch(MS_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!data.access_token) {
      throw new Error(`Microsoft sign-in failed (${data.error}): ${data.error_description?.split("\r\n")[0]} — run npm run auth:microsoft-ads again`);
    }
    if (data.refresh_token && data.refresh_token !== msRefresh) saveEnv("MSADS_REFRESH_TOKEN", data.refresh_token);
    token = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000, google: false };
    return token;
  }
  if (optionalEnv(PROFILES["microsoft-ads"].refreshTokenEnv)) {
    const oauth = oauthClientCredentials(PROFILES["microsoft-ads"]);
    oauth.setCredentials({ refresh_token: optionalEnv(PROFILES["microsoft-ads"].refreshTokenEnv) });
    const { token: value, res } = await oauth.getAccessToken();
    if (!value) throw new Error("Google sign-in failed — run npm run auth:microsoft-ads-google again");
    const expiry = (res?.data as { expiry_date?: number } | undefined)?.expiry_date ?? Date.now() + 3000_000;
    token = { value, expires: expiry, google: true };
    return token;
  }
  throw new Error("Not signed in: run `npm run auth:microsoft-ads` (Microsoft account) or `npm run auth:microsoft-ads-google` (Google sign-in) — see .env.example");
}

export const accountId = (id?: string) => id ?? requireEnv("MSADS_ACCOUNT_ID");

let customerCache: Record<string, string> = {};

/** CustomerId header: MSADS_CUSTOMER_ID, else the parent customer of the account (looked up once). */
async function customerFor(account: string): Promise<string> {
  const configured = optionalEnv("MSADS_CUSTOMER_ID");
  if (configured) return configured;
  if (!customerCache[account]) {
    const res = (await msads("customer", "POST", "Account/Query", { AccountId: account }, { noCustomer: true })) as { Account?: { ParentCustomerId?: string | number } };
    customerCache = { ...customerCache, [account]: String(res.Account?.ParentCustomerId ?? "") };
  }
  return customerCache[account];
}

export interface CallOptions {
  accountId?: string;
  /** Customer Management calls don't take CustomerId/CustomerAccountId headers. */
  noCustomer?: boolean;
}

type ApiFault = { TrackingId?: string; Errors?: unknown[]; OperationErrors?: unknown[]; BatchErrors?: unknown[]; Message?: string };

/** Calls a Bing Ads REST v13 operation; retries throttling (HTTP 429 / error 117) with backoff. */
export async function msads(service: Service, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, opts: CallOptions = {}): Promise<unknown> {
  const t = await accessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${t.value}`,
    DeveloperToken: sandbox() ? optionalEnv("MSADS_DEVELOPER_TOKEN", "BBD37VB98") : requireEnv("MSADS_DEVELOPER_TOKEN"),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (t.google) headers.IdentityProvider = "Google";
  if (!opts.noCustomer && service !== "customer") {
    const account = accountId(opts.accountId);
    headers.CustomerAccountId = account;
    headers.CustomerId = await customerFor(account);
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(serviceUrl(service, path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // keep raw text
    }
    const fault = (typeof data === "object" && data ? data : {}) as ApiFault;
    const throttled = res.status === 429 || JSON.stringify(fault.Errors ?? fault.OperationErrors ?? "").includes('"Code":117');
    if (throttled && attempt < 3) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 5 * 2 ** attempt) * 1000));
      continue;
    }
    if (!res.ok) {
      const errors = fault.OperationErrors ?? fault.Errors ?? fault.BatchErrors;
      const detail = errors ? JSON.stringify(errors).slice(0, 3000) : typeof data === "string" ? data.slice(0, 2000) : JSON.stringify(data).slice(0, 2000);
      throw new Error(`HTTP ${res.status}${fault.TrackingId ? ` (tracking ${fault.TrackingId})` : ""}: ${detail}`);
    }
    return data;
  }
}

/** Surfaces PartialErrors / NestedPartialErrors that come back with HTTP 200. */
export function withErrors<T extends Record<string, unknown>>(res: T): T {
  const partial = (res.PartialErrors ?? res.NestedPartialErrors) as unknown[] | undefined;
  const failures = partial?.filter(Boolean) ?? [];
  if (failures.length) {
    return { ...res, errors: failures.map((e) => {
      const err = e as Record<string, unknown>;
      return { index: err.Index, code: err.ErrorCode, message: err.Message, field: err.FieldPath, details: err.Details ?? undefined };
    }), PartialErrors: undefined, NestedPartialErrors: undefined };
  }
  const { PartialErrors: _p, NestedPartialErrors: _n, ...rest } = res;
  return rest as T;
}

/** Minimal ZIP reader: returns the first file (reports and geo files are single-entry archives). */
export function unzipFirst(buf: Buffer): Buffer {
  if (buf.readUInt32LE(0) !== 0x04034b50) return buf;
  const method = buf.readUInt16LE(8);
  let size = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  if (size === 0 || buf.readUInt16LE(6) & 0x08) {
    // Sizes live in the central directory when a data descriptor is used.
    const cd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    size = buf.readUInt32LE(cd + 20);
  }
  const data = buf.subarray(start, start + size);
  return method === 0 ? data : inflateRawSync(data);
}

/** RFC 4180 CSV → objects; numeric-looking cells become numbers (except 64-bit *Id columns), "--" becomes null. */
export function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v !== "")) rows.push(row);
      (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const [header, ...data] = rows;
  if (!header) return [];
  return data.map((r) =>
    Object.fromEntries(
      header.map((h, i) => {
        const v = r[i] ?? "";
        const num = v.replace(/%$/, "").replace(/,/g, "");
        const numeric = /^-?\d+(\.\d+)?$/.test(num) && !/^0\d/.test(num) && !/(Id| Id)$/.test(h);
        return [h, v === "--" || v === "" ? null : numeric ? Number(num) : v];
      }),
    ),
  );
}

export async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Bing IDs are 64-bit; the REST API takes them as strings. */
export const ids = (values: (string | number)[]) => values.map(String);

export const schema = {
  account_id: z.string().optional().describe("Ad account ID (not the account number); defaults to MSADS_ACCOUNT_ID"),
};
