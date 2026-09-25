import { z } from "zod";
import { requireEnv } from "../shared/env.js";

type Query = Record<string, unknown>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Instance root, e.g. https://acme.app.n8n.cloud or http://localhost:5678 (a pasted /api/v1 or /mcp-server/http is stripped). */
export const instanceUrl = () =>
  requireEnv("N8N_URL")
    .replace(/\/+$/, "")
    .replace(/\/(api\/v\d+|mcp-server\/http|rest)$/, "");

function encode(query: Query = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** Calls the n8n public REST API (X-N8N-API-KEY); retries 429/503. */
export async function n8n(method: Method, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<unknown> {
  const url = `${instanceUrl()}/api/v1/${path.replace(/^\/+/, "")}${encode(opts.query)}`;
  const headers: Record<string, string> = { "X-N8N-API-KEY": requireEnv("N8N_API_KEY"), Accept: "application/json" };
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
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 2 ** attempt) * 1000));
      continue;
    }
    if (!res.ok) {
      const message = typeof data === "object" && data && "message" in data ? (data as { message: string }).message : String(text).slice(0, 1500);
      const hint =
        res.status === 401
          ? " — check N8N_API_KEY (Settings → n8n API; the public API isn't available on the free trial)"
          : res.status === 404 && path.startsWith("workflows/")
            ? " — workflow not found (or the key's user can't see it)"
            : "";
      throw new Error(`HTTP ${res.status} ${method} /api/v1/${path}: ${message}${hint}`);
    }
    return data;
  }
}

type Page = { data?: Record<string, unknown>[]; nextCursor?: string | null };

/** GET a paginated collection, following nextCursor until `limit` items. */
export async function listAll(path: string, query: Query = {}, limit = 250) {
  const data: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = (await n8n("GET", path, { query: { ...query, limit: Math.min(250, limit - data.length), cursor } })) as Page;
    data.push(...(page.data ?? []));
    cursor = page.nextCursor ?? undefined;
  } while (cursor && data.length < limit);
  return { count: data.length, has_more: Boolean(cursor), data };
}

type Node = { name: string; type: string; disabled?: boolean; parameters?: Record<string, unknown>; webhookId?: string; credentials?: Record<string, { id?: string; name?: string }> };
export type Workflow = {
  id: string;
  name: string;
  active?: boolean;
  isArchived?: boolean;
  nodes?: Node[];
  connections?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  tags?: { id: string; name: string }[];
  updatedAt?: string;
  createdAt?: string;
  description?: string;
  [key: string]: unknown;
};

export const isTrigger = (n: Node) => /trigger$/i.test(n.type) || /\.(webhook|formTrigger|chatTrigger|scheduleTrigger|cron|interval|start)$/i.test(n.type);

/** Compact view of a workflow for listings. */
export function summarize(w: Workflow) {
  const nodes = w.nodes ?? [];
  return {
    id: w.id,
    name: w.name,
    active: w.active,
    archived: w.isArchived || undefined,
    tags: w.tags?.map((t) => t.name),
    triggers: nodes.filter(isTrigger).map((n) => n.type.split(".").pop()),
    node_count: nodes.length,
    mcp: w.settings?.availableInMCP ?? false,
    updated: w.updatedAt,
  };
}

/** Keys the PUT /workflows/{id} body accepts (it rejects anything else). */
const WORKFLOW_KEYS = ["name", "nodes", "connections", "settings", "nodeGroups", "staticData", "pinData", "parentFolderId", "description"];
const SETTINGS_KEYS = [
  "saveExecutionProgress",
  "saveManualExecutions",
  "saveDataErrorExecution",
  "saveDataSuccessExecution",
  "executionTimeout",
  "errorWorkflow",
  "timezone",
  "executionOrder",
  "binaryMode",
  "callerPolicy",
  "callerIds",
  "timeSavedMode",
  "timeSavedPerExecution",
  "redactionPolicy",
  "availableInMCP",
  "customTelemetryTags",
  "credentialResolverId",
];

export function writableWorkflow(w: Partial<Workflow>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WORKFLOW_KEYS) if (w[key] !== undefined && w[key] !== null) out[key] = w[key];
  const settings = (w.settings ?? {}) as Record<string, unknown>;
  out.settings = Object.fromEntries(Object.entries(settings).filter(([k, v]) => SETTINGS_KEYS.includes(k) && v !== null));
  out.connections ??= {};
  out.nodes ??= [];
  return out;
}

export const schema = {
  limit: z.number().int().min(1).max(5000).default(250).describe("Max items (follows pagination)"),
  confirm: z.boolean().default(false).describe("Required for permanent deletes"),
};
