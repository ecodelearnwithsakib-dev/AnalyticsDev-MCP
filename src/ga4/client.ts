import { z } from "zod";
import { requireEnv } from "../shared/env.js";
import { googleClient, googleRequest, PROFILES } from "../shared/google-auth.js";

export const API = {
  data: "https://analyticsdata.googleapis.com",
  admin: "https://analyticsadmin.googleapis.com",
} as const;

const getClient = googleClient(PROFILES.ga4);

export function google(
  api: keyof typeof API,
  version: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return googleRequest(getClient, {
    url: `${API[api]}/${version}/${path.replace(/^\/+/, "")}`,
    method,
    data: body,
    params,
  });
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
