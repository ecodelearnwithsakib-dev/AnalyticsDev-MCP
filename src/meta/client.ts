import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { requestJson } from "../shared/http.js";

type Params = Record<string, unknown>;
type Page = { data?: unknown[]; paging?: { next?: string } };

export const apiVersion = () => optionalEnv("META_API_VERSION", "v25.0");

/** Graph API takes nested values (arrays, objects) as JSON strings. */
function encode(params: Params): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return search;
}

function authParams(token?: string): Params {
  const accessToken = token ?? requireEnv("META_ACCESS_TOKEN");
  const appSecret = optionalEnv("META_APP_SECRET");
  return {
    access_token: accessToken,
    appsecret_proof: appSecret ? createHmac("sha256", appSecret).update(accessToken).digest("hex") : undefined,
  };
}

export async function graph(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Params = {},
  token?: string,
): Promise<unknown> {
  const url = `https://graph.facebook.com/${apiVersion()}/${path.replace(/^\/+/, "")}`;
  const query = encode({ ...params, ...authParams(token) });
  if (method === "POST") {
    return requestJson(url, {
      method,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: query.toString(),
    });
  }
  return requestJson(`${url}?${query}`, { method });
}

/** GET a connection (edge) and follow paging.next until `limit` items are collected. */
export async function graphList(path: string, params: Params = {}, limit = 50, token?: string) {
  let page = (await graph("GET", path, { ...params, limit: Math.min(limit, 100) }, token)) as Page;
  const data = [...(page.data ?? [])];
  while (data.length < limit && page.paging?.next) {
    page = (await requestJson(page.paging.next)) as Page;
    data.push(...(page.data ?? []));
  }
  return { count: Math.min(data.length, limit), has_more: Boolean(page.paging?.next) || data.length > limit, data: data.slice(0, limit) };
}

const pageTokens = new Map<string, string>();

/** Page and lead endpoints need a Page access token; derive it from the user/system-user token. */
export async function pageToken(pageId: string): Promise<string> {
  const cached = pageTokens.get(pageId);
  if (cached) return cached;
  const res = (await graph("GET", pageId, { fields: "access_token" })) as { access_token?: string };
  if (!res.access_token) {
    throw new Error(`No Page access token for ${pageId}; the token needs a role on this Page (pages_show_list, pages_manage_posts).`);
  }
  pageTokens.set(pageId, res.access_token);
  return res.access_token;
}

export function adAccount(id?: string): string {
  const value = id ?? requireEnv("META_AD_ACCOUNT_ID");
  return value.startsWith("act_") ? value : `act_${value}`;
}

/** Meta requires PII to be normalized (trimmed, lowercased) and SHA-256 hashed. */
export function hash(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export const schema = {
  adAccountId: z.string().optional().describe("Ad account ID, with or without act_. Defaults to META_AD_ACCOUNT_ID"),
  fields: (defaults: string) => z.string().default(defaults).describe("Comma-separated Graph API fields"),
  limit: z.number().int().min(1).max(1000).default(50).describe("Max items to return (follows pagination)"),
  extra: z.record(z.unknown()).optional().describe("Any additional Graph API parameters, sent as-is"),
  status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED").describe("Created PAUSED by default so nothing spends by accident"),
};
