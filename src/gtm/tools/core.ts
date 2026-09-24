import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import {
  accountPath,
  containerPath,
  gtm,
  ids,
  LIST_KEYS,
  listAll,
  parentPath,
  summarize,
  WORKSPACE_LEVEL,
  workspacePath,
  type Collection,
} from "../client.js";

const collections = Object.keys(LIST_KEYS) as [Collection, ...Collection[]];

export function registerCoreTools(server: McpServer): void {
  server.registerTool(
    "gtm_api_request",
    {
      title: "GTM API request",
      description:
        "Call ANY Tag Manager API v2 endpoint directly when no dedicated tool fits. path is relative to /tagmanager/v2, e.g. 'accounts/1/containers/2/workspaces/3/tags'.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
        path: z.string(),
        body: z.record(z.unknown()).optional(),
        query: z.record(z.union([z.string(), z.array(z.string())])).optional().describe("Arrays become repeated params"),
      },
    },
    ({ method, path, body, query }) =>
      run(() =>
        gtm(
          method,
          path,
          body,
          Object.entries(query ?? {}).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x): [string, string] => [k, x]) : [[k, v] as [string, string]])),
        ),
      ),
  );

  server.registerTool(
    "gtm_list",
    {
      title: "List GTM resources",
      description:
        "List accounts, containers, user_permissions (account level); workspaces, environments, version_headers, destinations (container level); tags, triggers, variables, built_in_variables, folders, templates, clients, zones, transformations, gtag_config (workspace level).",
      inputSchema: {
        resource: z.enum(collections),
        ...ids,
        full: z.boolean().default(false).describe("Include full configuration (parameters, filters); default is a compact summary"),
      },
    },
    ({ resource, full, ...args }) =>
      run(async () => {
        const parent = await parentPath(resource, args);
        const items = await listAll(parent ? `${parent}/${resource}` : resource, LIST_KEYS[resource]);
        return { parent: parent || "/", count: items.length, [resource]: full ? items : items.map(summarize) };
      }),
  );

  server.registerTool(
    "gtm_get",
    {
      title: "Get any GTM resource",
      description: "Get the full object at a path, e.g. accounts/1/containers/2/workspaces/3/tags/4 or accounts/1/containers/2/versions/5.",
      inputSchema: { path: z.string() },
    },
    ({ path }) => run(() => gtm("GET", path)),
  );

  server.registerTool(
    "gtm_create",
    {
      title: "Create workspace entity",
      description:
        "Create a tag, trigger, variable, folder, template, client, zone, transformation or gtag_config from a raw API body. Example tag: {\"name\":\"GA4 - purchase\",\"type\":\"gaawe\",\"parameter\":[{\"type\":\"template\",\"key\":\"eventName\",\"value\":\"purchase\"},{\"type\":\"template\",\"key\":\"measurementIdOverride\",\"value\":\"G-XXXX\"}],\"firingTriggerId\":[\"12\"]}. For common cases prefer gtm_add_* tools.",
      inputSchema: {
        resource: z.enum(WORKSPACE_LEVEL.filter((r) => r !== "built_in_variables") as [Collection, ...Collection[]]),
        ...ids,
        body: z.record(z.unknown()),
      },
    },
    ({ resource, body, ...args }) => run(async () => gtm("POST", `${await workspacePath(args)}/${resource}`, body)),
  );

  server.registerTool(
    "gtm_update",
    {
      title: "Update GTM resource",
      description:
        "Update any tag/trigger/variable/folder/template/client/workspace/environment/container. Reads the current object, merges your top-level changes (e.g. {\"name\":\"...\",\"paused\":true,\"firingTriggerId\":[\"5\"]}) and writes it back with the fingerprint, so concurrent edits are detected.",
      inputSchema: {
        path: z.string(),
        changes: z.record(z.unknown()),
        replace: z.boolean().default(false).describe("Send changes as the whole object instead of merging"),
      },
    },
    ({ path, changes, replace }) =>
      run(async () => {
        const current = (await gtm("GET", path)) as Record<string, unknown>;
        const body = replace ? changes : { ...current, ...changes };
        return gtm("PUT", path, body, current.fingerprint ? [["fingerprint", String(current.fingerprint)]] : undefined);
      }),
  );

  server.registerTool(
    "gtm_delete",
    {
      title: "Delete GTM resource",
      description: "Delete a tag, trigger, variable, folder, template, workspace, environment, version, user permission or container.",
      inputSchema: { path: z.string(), confirm: z.literal(true).describe("Must be true; container deletes cannot be undone") },
    },
    ({ path }) => run(() => gtm("DELETE", path)),
  );

  server.registerTool(
    "gtm_revert",
    {
      title: "Revert workspace change",
      description: "Discard workspace changes to a tag, trigger, variable, folder, template, client, zone or transformation (restores the base version).",
      inputSchema: { path: z.string() },
    },
    ({ path }) => run(() => gtm("POST", `${path}:revert`)),
  );

  server.registerTool(
    "gtm_lookup_container",
    {
      title: "Look up container by ID",
      description: "Find a container's account/container IDs from its public ID (GTM-XXXX) or a destination ID (G-XXXX, AW-XXXX).",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      run(() => gtm("GET", "accounts/containers:lookup", undefined, [[/^GTM-/i.test(id) ? "tagId" : "destinationId", id]])),
  );

  server.registerTool(
    "gtm_create_container",
    {
      title: "Create container",
      description: "Create a web, server, iOS, Android or AMP container in an account.",
      inputSchema: {
        account_id: ids.account_id,
        name: z.string(),
        usage_context: z.enum(["web", "server", "android", "ios", "amp"]).default("web"),
        domain_names: z.array(z.string()).optional(),
        tagging_server_urls: z.array(z.string()).optional().describe("Server containers only"),
      },
    },
    ({ account_id, name, usage_context, domain_names, tagging_server_urls }) =>
      run(() =>
        gtm("POST", `${accountPath({ account_id })}/containers`, {
          name,
          usageContext: [usage_context],
          domainName: domain_names,
          taggingServerUrls: tagging_server_urls,
        }),
      ),
  );

  server.registerTool(
    "gtm_container_snippet",
    {
      title: "Get install snippet",
      description: "Get the <head> and <body> install snippets for a web container.",
      inputSchema: { account_id: ids.account_id, container_id: ids.container_id },
    },
    (args) => run(async () => gtm("GET", `${await containerPath(args)}:snippet`)),
  );
}
