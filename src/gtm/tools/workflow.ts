import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { accountPath, containerPath, gtm, ids, summarize, workspacePath } from "../client.js";

export function registerWorkflowTools(server: McpServer): void {
  server.registerTool(
    "gtm_create_workspace",
    {
      title: "Create workspace",
      description: "Create a new workspace to stage changes separately from the Default Workspace.",
      inputSchema: { account_id: ids.account_id, container_id: ids.container_id, name: z.string(), description: z.string().optional() },
    },
    ({ name, description, ...args }) => run(async () => gtm("POST", `${await containerPath(args)}/workspaces`, { name, description })),
  );

  server.registerTool(
    "gtm_workspace_status",
    {
      title: "Workspace changes",
      description: "List what changed in a workspace (added/updated/deleted entities) and any merge conflicts.",
      inputSchema: { ...ids },
    },
    (args) => run(async () => gtm("GET", `${await workspacePath(args)}/status`)),
  );

  server.registerTool(
    "gtm_sync_workspace",
    {
      title: "Sync workspace",
      description: "Bring a workspace up to date with the latest container version; reports merge conflicts.",
      inputSchema: { ...ids },
    },
    (args) => run(async () => gtm("POST", `${await workspacePath(args)}:sync`)),
  );

  server.registerTool(
    "gtm_quick_preview",
    {
      title: "Quick preview",
      description: "Compile the workspace into a preview version and report compiler errors, without publishing.",
      inputSchema: { ...ids },
    },
    (args) => run(async () => gtm("POST", `${await workspacePath(args)}:quick_preview`)),
  );

  server.registerTool(
    "gtm_create_version",
    {
      title: "Create (and publish) version",
      description:
        "Create a container version from a workspace, optionally publishing it live. Note: GTM deletes a non-default workspace once it becomes a version.",
      inputSchema: {
        ...ids,
        name: z.string(),
        notes: z.string().optional(),
        publish: z.boolean().default(false).describe("Publish the new version live immediately"),
      },
    },
    ({ name, notes, publish, ...args }) =>
      run(async () => {
        const created = (await gtm("POST", `${await workspacePath(args)}:create_version`, { name, notes })) as {
          containerVersion?: { path: string; containerVersionId: string };
          compilerError?: boolean;
          syncStatus?: unknown;
        };
        if (!publish || created.compilerError || !created.containerVersion) return created;
        const published = await gtm("POST", `${created.containerVersion.path}:publish`);
        return { created: { versionId: created.containerVersion.containerVersionId, path: created.containerVersion.path }, published };
      }),
  );

  server.registerTool(
    "gtm_publish_version",
    {
      title: "Publish version",
      description: "Publish an existing container version (also used to roll back to an older version).",
      inputSchema: { account_id: ids.account_id, container_id: ids.container_id, version_id: z.string() },
    },
    ({ version_id, ...args }) => run(async () => gtm("POST", `${await containerPath(args)}/versions/${version_id}:publish`)),
  );

  server.registerTool(
    "gtm_get_version",
    {
      title: "Get container version",
      description: "Get the live version (default) or a specific version, i.e. a full export of tags, triggers, variables, etc.",
      inputSchema: {
        account_id: ids.account_id,
        container_id: ids.container_id,
        version_id: z.string().optional().describe("Omit for the live version"),
        full: z.boolean().default(false).describe("Include full configuration; default summarizes entities"),
      },
    },
    ({ version_id, full, ...args }) =>
      run(async () => {
        const container = await containerPath(args);
        const path = version_id ? `${container}/versions/${version_id}` : `${container}/versions:live`;
        const version = (await gtm("GET", path)) as Record<string, unknown>;
        if (full) return version;
        return Object.fromEntries(
          Object.entries(version).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.map((v) => (typeof v === "object" && v ? summarize(v as Record<string, unknown>) : v)) : value,
          ]),
        );
      }),
  );

  server.registerTool(
    "gtm_set_builtin_variables",
    {
      title: "Enable/disable built-in variables",
      description: "Enable or disable built-in variables, e.g. clickElement, clickClasses, clickId, clickUrl, clickText, formId, pageUrl, pagePath, referrer, event, scrollDepthThreshold, videoTitle.",
      inputSchema: {
        ...ids,
        enable: z.array(z.string()).default([]),
        disable: z.array(z.string()).default([]),
      },
    },
    ({ enable, disable, ...args }) =>
      run(async () => {
        const path = `${await workspacePath(args)}/built_in_variables`;
        const result: Record<string, unknown> = {};
        if (enable.length) result.enabled = await gtm("POST", path, undefined, enable.map((t) => ["type", t]));
        if (disable.length) result.disabled = await gtm("DELETE", path, undefined, disable.map((t) => ["type", t]));
        return result;
      }),
  );

  server.registerTool(
    "gtm_import_gallery_template",
    {
      title: "Import Community Template",
      description: "Import a Community Template Gallery template (e.g. owner 'stape-io', repository 'facebook-tag').",
      inputSchema: {
        ...ids,
        gallery_owner: z.string(),
        gallery_repository: z.string(),
        gallery_sha: z.string().optional().describe("Specific version; latest if omitted"),
        accept_permissions_update: z.boolean().default(true),
      },
    },
    ({ gallery_owner, gallery_repository, gallery_sha, accept_permissions_update, ...args }) =>
      run(async () => {
        const query: [string, string][] = [
          ["galleryOwner", gallery_owner],
          ["galleryRepository", gallery_repository],
          ["acknowledgePermissions", String(accept_permissions_update)],
        ];
        if (gallery_sha) query.push(["gallerySha", gallery_sha]);
        return gtm("POST", `${await workspacePath(args)}/templates:import_from_gallery`, undefined, query);
      }),
  );

  server.registerTool(
    "gtm_move_to_folder",
    {
      title: "Move entities to folder",
      description: "Move tags, triggers and variables into a folder.",
      inputSchema: {
        ...ids,
        folder_id: z.string(),
        tag_ids: z.array(z.string()).default([]),
        trigger_ids: z.array(z.string()).default([]),
        variable_ids: z.array(z.string()).default([]),
      },
    },
    ({ folder_id, tag_ids, trigger_ids, variable_ids, ...args }) =>
      run(async () => {
        const query: [string, string][] = [
          ...tag_ids.map((id): [string, string] => ["tagId", id]),
          ...trigger_ids.map((id): [string, string] => ["triggerId", id]),
          ...variable_ids.map((id): [string, string] => ["variableId", id]),
        ];
        return gtm("POST", `${await workspacePath(args)}/folders/${folder_id}:move_entities_to_folder`, {}, query);
      }),
  );

  server.registerTool(
    "gtm_create_environment",
    {
      title: "Create environment",
      description: "Create a custom environment (e.g. staging) and get its preview/auth parameters.",
      inputSchema: {
        account_id: ids.account_id,
        container_id: ids.container_id,
        name: z.string(),
        description: z.string().optional(),
        url: z.string().optional(),
        enable_debug: z.boolean().default(true),
      },
    },
    ({ name, description, url, enable_debug, ...args }) =>
      run(async () =>
        gtm("POST", `${await containerPath(args)}/environments`, { name, description, url, enableDebug: enable_debug, type: "user" }),
      ),
  );

  server.registerTool(
    "gtm_grant_access",
    {
      title: "Grant user access",
      description: "Give an email access to a GTM account and specific containers. Remove with gtm_delete on the user permission path.",
      inputSchema: {
        account_id: ids.account_id,
        email: z.string().email(),
        account_permission: z.enum(["user", "admin", "noAccess"]).default("user"),
        containers: z
          .array(z.object({ container_id: z.string(), permission: z.enum(["read", "edit", "approve", "publish"]) }))
          .default([]),
      },
    },
    ({ account_id, email, account_permission, containers }) =>
      run(() =>
        gtm("POST", `${accountPath({ account_id })}/user_permissions`, {
          emailAddress: email,
          accountAccess: { permission: account_permission },
          containerAccess: containers.map((c) => ({ containerId: c.container_id, permission: c.permission })),
        }),
      ),
  );
}
