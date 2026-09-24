import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";

const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/analytics.edit",
  "https://www.googleapis.com/auth/analytics.manage.users",
];

export const API = {
  data: "https://analyticsdata.googleapis.com",
  admin: "https://analyticsadmin.googleapis.com",
} as const;

type Requester = Pick<OAuth2Client, "request">;
let client: Promise<Requester> | undefined;

/** OAuth refresh token if configured, otherwise a service account / gcloud ADC. */
function getClient(): Promise<Requester> {
  if (!client) {
    const refreshToken = optionalEnv("GA4_OAUTH_REFRESH_TOKEN");
    if (refreshToken) {
      const oauth = new OAuth2Client(requireEnv("GA4_OAUTH_CLIENT_ID"), requireEnv("GA4_OAUTH_CLIENT_SECRET"));
      oauth.setCredentials({ refresh_token: refreshToken });
      client = Promise.resolve(oauth);
    } else {
      client = new GoogleAuth({ scopes: SCOPES }).getClient() as Promise<Requester>;
    }
  }
  return client;
}

export async function google(
  api: keyof typeof API,
  version: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const auth = await getClient();
  try {
    const res = await auth.request({
      url: `${API[api]}/${version}/${path.replace(/^\/+/, "")}`,
      method,
      data: body,
      params: params && Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)),
    });
    return res.data ?? { ok: true };
  } catch (error) {
    type ApiError = { message?: string; status?: string } | string;
    const res = (error as { response?: { status?: number; data?: { error?: ApiError; error_description?: string } } }).response;
    const apiError = res?.data?.error;
    if (typeof apiError === "object") throw new Error(`HTTP ${res?.status} ${apiError.status}: ${apiError.message}`);
    // OAuth token endpoint errors look like { error: "invalid_grant", error_description: "..." }.
    if (typeof apiError === "string") throw new Error(`Auth failed (${apiError}): ${res?.data?.error_description ?? ""}`);
    throw error;
  }
}

export const admin = (method: Parameters<typeof google>[2], path: string, body?: unknown, params?: Record<string, unknown>, version = "v1beta") =>
  google("admin", version, method, path, body, params);

export const data = (path: string, body: unknown, version = "v1beta") => google("data", version, "POST", path, body);

/** Accepts 123456789 or properties/123456789; defaults to GA4_PROPERTY_ID. */
export function property(id?: string): string {
  const value = (id ?? requireEnv("GA4_PROPERTY_ID")).replace(/^properties\//, "");
  return `properties/${value}`;
}

export function account(id?: string): string {
  const value = (id ?? requireEnv("GA4_ACCOUNT_ID")).replace(/^accounts\//, "");
  return `accounts/${value}`;
}

/** Follow nextPageToken for Admin API list calls. */
export async function adminList(path: string, key: string, limit = 200, version = "v1beta", params: Record<string, unknown> = {}) {
  const items: unknown[] = [];
  let pageToken: string | undefined;
  do {
    const res = (await admin("GET", path, undefined, { ...params, pageSize: 200, pageToken }, version)) as Record<string, unknown>;
    items.push(...((res[key] as unknown[]) ?? []));
    pageToken = res.nextPageToken as string | undefined;
  } while (pageToken && items.length < limit);
  return { count: Math.min(items.length, limit), has_more: Boolean(pageToken) || items.length > limit, [key]: items.slice(0, limit) };
}

/** PATCH with an updateMask built from the provided top-level fields. */
export function adminUpdate(name: string, fields: Record<string, unknown>, version = "v1beta") {
  return admin("PATCH", name, fields, { updateMask: Object.keys(fields).join(",") }, version);
}

export const schema = {
  property: z.string().optional().describe("GA4 property ID (123456789 or properties/123456789). Defaults to GA4_PROPERTY_ID"),
  account: z.string().optional().describe("GA4 account ID. Defaults to GA4_ACCOUNT_ID"),
  limit: z.number().int().min(1).max(5000).default(200),
  version: z.enum(["v1beta", "v1alpha"]).default("v1beta").describe("Some resources (audiences, access bindings, BigQuery links, enhanced measurement) are v1alpha only"),
};
