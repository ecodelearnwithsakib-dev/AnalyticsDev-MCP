import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { googleClient, googleRequest, PROFILES } from "../shared/google-auth.js";

const getClient = googleClient(PROFILES["google-ads"]);
const apiVersion = () => optionalEnv("GOOGLE_ADS_API_VERSION", "v25");

/** Customer IDs are accepted with or without dashes. */
export const cid = (id?: string) => (id ?? requireEnv("GOOGLE_ADS_CUSTOMER_ID")).replace(/-/g, "");

export async function ads(method: "GET" | "POST", path: string, body?: unknown, loginCustomerId?: string): Promise<unknown> {
  const login = (loginCustomerId ?? optionalEnv("GOOGLE_ADS_LOGIN_CUSTOMER_ID")).replace(/-/g, "");
  return googleRequest(getClient, {
    url: `https://googleads.googleapis.com/${apiVersion()}/${path.replace(/^\/+/, "")}`,
    method,
    data: body,
    headers: {
      "developer-token": requireEnv("GOOGLE_ADS_DEVELOPER_TOKEN"),
      ...(login && { "login-customer-id": login }),
    },
  });
}

/** Metrics the API returns in micros even though their names don't say so. */
const MICROS_METRICS = new Set([
  "averageCpc",
  "averageCpm",
  "averageCpe",
  "averageCpv",
  "averageCost",
  "costPerConversion",
  "costPerAllConversions",
  "costPerCurrentModelAttributedConversion",
]);

/** Flatten {campaign:{name}, metrics:{costMicros}} into {"campaign.name", "metrics.cost"} with micros converted. */
export function flatten(row: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [key, value] of Object.entries(row)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flatten(value as Record<string, unknown>, `${prefix}${key}.`, out);
    } else if (key.endsWith("Micros") && value !== null && value !== undefined) {
      out[`${prefix}${key.slice(0, -6)}`] = Number(value) / 1e6;
    } else if (prefix === "metrics." && MICROS_METRICS.has(key)) {
      out[`${prefix}${key}`] = Number(value) / 1e6;
    } else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) && prefix === "metrics.") {
      out[`${prefix}${key}`] = Number(value);
    } else {
      out[`${prefix}${key}`] = value;
    }
  }
  return out;
}

/** Run GAQL via searchStream; appends LIMIT when the query has none. */
export async function gaql(customerId: string, query: string, limit = 1000, loginCustomerId?: string) {
  const q = /\bLIMIT\s+\d+/i.test(query) ? query : `${query.trim()} LIMIT ${limit}`;
  const batches = (await ads("POST", `customers/${customerId}/googleAds:searchStream`, { query: q }, loginCustomerId)) as {
    results?: Record<string, unknown>[];
    fieldMask?: string;
  }[];
  const rows = (Array.isArray(batches) ? batches : [batches]).flatMap((b) => b.results ?? []);
  return rows.map((r) => flatten(r));
}

/** Currency units → micros, rounded to the smallest billable unit (multiples of 10,000). */
export const toMicros = (amount: number) => String(Math.round(amount * 100) * 10_000);

export const resource = (customerId: string, collection: string, id: string) =>
  id.startsWith("customers/") ? id : `customers/${customerId}/${collection}/${id}`;

export const schema = {
  customer_id: z.string().optional().describe("Google Ads customer ID (123-456-7890); defaults to GOOGLE_ADS_CUSTOMER_ID"),
  login_customer_id: z.string().optional().describe("Manager (MCC) ID when accessing a client account; defaults to GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
  validate_only: z.boolean().default(false).describe("Check the request without applying it"),
};
