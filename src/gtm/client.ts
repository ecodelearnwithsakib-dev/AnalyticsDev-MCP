import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { googleClient, googleRequest, PROFILES } from "../shared/google-auth.js";

const API = "https://tagmanager.googleapis.com/tagmanager/v2";
const getClient = googleClient(PROFILES.gtm);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Call the Tag Manager API. `query` may repeat keys (the API uses ?type=a&type=b),
 * so it is encoded here rather than passed as an object. Retries on the API's tight rate limit.
 */
export async function gtm(method: Method, path: string, body?: unknown, query?: [string, string][]): Promise<unknown> {
  const search = query?.length ? `?${new URLSearchParams(query)}` : "";
  for (let attempt = 0; ; attempt++) {
    try {
      return await googleRequest(getClient, { url: `${API}/${path.replace(/^\/+/, "")}${search}`, method, data: body });
    } catch (error) {
      if (attempt < 4 && error instanceof Error && /HTTP 429/.test(error.message)) {
        await sleep(2 ** attempt * 2000);
        continue;
      }
      throw error;
    }
  }
}

/** Collection name in the URL → key holding the items in the list response. */
export const LIST_KEYS = {
  accounts: "account",
  containers: "container",
  user_permissions: "userPermission",
  workspaces: "workspace",
  environments: "environment",
  version_headers: "containerVersionHeader",
  destinations: "destination",
  tags: "tag",
  triggers: "trigger",
  variables: "variable",
  built_in_variables: "builtInVariable",
  folders: "folder",
  templates: "template",
  clients: "client",
  zones: "zone",
  transformations: "transformation",
  gtag_config: "gtagConfig",
} as const;

export type Collection = keyof typeof LIST_KEYS;
export const ACCOUNT_LEVEL: Collection[] = ["containers", "user_permissions"];
export const CONTAINER_LEVEL: Collection[] = ["workspaces", "environments", "version_headers", "destinations"];
export const WORKSPACE_LEVEL: Collection[] = [
  "tags",
  "triggers",
  "variables",
  "built_in_variables",
  "folders",
  "templates",
  "clients",
  "zones",
  "transformations",
  "gtag_config",
];

export async function listAll(path: string, key: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  do {
    const res = (await gtm("GET", path, undefined, pageToken ? [["pageToken", pageToken]] : undefined)) as Record<string, unknown>;
    items.push(...(((res[key] as Record<string, unknown>[]) ?? [])));
    pageToken = res.nextPageToken as string | undefined;
  } while (pageToken);
  return items;
}

const HEAVY_FIELDS = new Set([
  "parameter",
  "filter",
  "customEventFilter",
  "autoEventFilter",
  "monitoringMetadata",
  "consentSettings",
  "templateData",
  "galleryReference",
  "tagManagerUrl",
  "accountId",
  "containerId",
  "workspaceId",
]);

/** Drop bulky configuration so long lists stay readable; use gtm_get for the full object. */
export function summarize(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !HEAVY_FIELDS.has(key)));
}

export const ids = {
  account_id: z.string().optional().describe("GTM account ID; defaults to GTM_ACCOUNT_ID"),
  container_id: z
    .string()
    .optional()
    .describe("Numeric container ID or public ID (GTM-XXXXXXX); defaults to GTM_CONTAINER_ID"),
  workspace_id: z.string().optional().describe("Defaults to GTM_WORKSPACE_ID, else the 'Default Workspace'"),
};

type Ids = { account_id?: string; container_id?: string; workspace_id?: string };
const lookups = new Map<string, string>();

export function accountPath(args: Ids): string {
  return `accounts/${args.account_id ?? requireEnv("GTM_ACCOUNT_ID")}`;
}

export async function containerPath(args: Ids): Promise<string> {
  const container = args.container_id ?? requireEnv("GTM_CONTAINER_ID");
  if (!/^GTM-/i.test(container)) return `${accountPath(args)}/containers/${container}`;
  const cached = lookups.get(container);
  if (cached) return cached;
  const found = (await gtm("GET", "accounts/containers:lookup", undefined, [["tagId", container]])) as { path: string };
  lookups.set(container, found.path);
  return found.path;
}

export async function workspacePath(args: Ids): Promise<string> {
  const container = await containerPath(args);
  const workspace = args.workspace_id ?? optionalEnv("GTM_WORKSPACE_ID");
  if (workspace) return `${container}/workspaces/${workspace}`;
  const workspaces = await listAll(`${container}/workspaces`, "workspace");
  const pick = workspaces.find((w) => w.name === "Default Workspace") ?? workspaces[0];
  if (!pick) throw new Error("No workspace found; create one with gtm_create_workspace");
  return pick.path as string;
}

export async function parentPath(collection: Collection, args: Ids): Promise<string> {
  if (collection === "accounts") return "";
  if (ACCOUNT_LEVEL.includes(collection)) return accountPath(args);
  if (CONTAINER_LEVEL.includes(collection)) return containerPath(args);
  return workspacePath(args);
}

/** Helpers for GTM's verbose parameter format. */
export const param = {
  template: (key: string, value: string) => ({ type: "template", key, value }),
  boolean: (key: string, value: boolean) => ({ type: "boolean", key, value: String(value) }),
  integer: (key: string, value: number) => ({ type: "integer", key, value: String(value) }),
  table: (key: string, rows: Record<string, string>, nameKey: string, valueKey: string) => ({
    type: "list",
    key,
    list: Object.entries(rows).map(([name, value]) => ({
      type: "map",
      map: [param.template(nameKey, name), param.template(valueKey, value)],
    })),
  }),
};
