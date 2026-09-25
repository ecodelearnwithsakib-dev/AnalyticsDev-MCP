import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv } from "../../shared/env.js";
import { run } from "../../shared/server.js";
import { instanceUrl, listAll, n8n, schema } from "../client.js";

const condition = z.object({
  column: z.string(),
  condition: z.enum(["eq", "neq", "like", "ilike", "gt", "gte", "lt", "lte"]).default("eq"),
  value: z.unknown(),
});
const toFilter = (conds?: z.infer<typeof condition>[], mode: "and" | "or" = "and") =>
  conds?.length ? { type: mode, filters: conds.map((c) => ({ columnName: c.column, condition: c.condition, value: c.value })) } : undefined;

export function registerAdminTools(server: McpServer): void {
  server.registerTool(
    "n8n_credentials",
    {
      title: "Credentials",
      description:
        "List credentials (no secrets), show the fields a credential type needs, create one, rename it, test it, move it to another project, or delete it (confirm). Secret fields are read from .env by name via data_from_env so they never pass through the chat; `data` is for non-secret fields such as host or region.",
      inputSchema: {
        action: z.enum(["list", "get", "schema", "create", "rename", "test", "transfer", "delete"]).default("list"),
        id: z.string().optional(),
        type: z.string().optional().describe("Credential type, e.g. slackApi, httpHeaderAuth, googleSheetsOAuth2Api, postgres"),
        name: z.string().optional(),
        data: z.record(z.unknown()).optional().describe("Non-secret fields only"),
        data_from_env: z.record(z.string()).optional().describe("{field: ENV_VAR_NAME}, e.g. {\"accessToken\":\"SLACK_BOT_TOKEN\"} — value read from .env"),
        project_id: z.string().optional(),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const need = (v: string | undefined, name: string) => {
          if (!v) throw new Error(`${name} is required`);
          return v;
        };
        switch (a.action) {
          case "list":
            return (await listAll("credentials", {}, 1000)).data.map((c) => ({ id: c.id, name: c.name, type: c.type, updated: c.updatedAt, shared: c.shared }));
          case "get":
            return n8n("GET", `credentials/${need(a.id, "id")}`);
          case "schema":
            return n8n("GET", `credentials/schema/${need(a.type, "type")}`);
          case "create": {
            const secrets = Object.fromEntries(
              Object.entries(a.data_from_env ?? {}).map(([field, env]) => {
                const value = optionalEnv(env);
                if (!value) throw new Error(`${env} is not set in .env`);
                return [field, value];
              }),
            );
            const created = (await n8n("POST", "credentials", {
              body: { name: need(a.name, "name"), type: need(a.type, "type"), data: { ...a.data, ...secrets }, projectId: a.project_id },
            })) as { id: string; name: string; type: string };
            return { id: created.id, name: created.name, type: created.type, secret_fields_from_env: Object.keys(a.data_from_env ?? {}) };
          }
          case "rename":
            return n8n("PATCH", `credentials/${need(a.id, "id")}`, { body: { name: need(a.name, "name") } });
          case "test":
            return n8n("POST", `credentials/${need(a.id, "id")}/test`);
          case "transfer":
            return n8n("PUT", `credentials/${need(a.id, "id")}/transfer`, { body: { destinationProjectId: need(a.project_id, "project_id") } });
          case "delete":
            if (!a.confirm) throw new Error("Deleting a credential breaks every workflow that uses it; set confirm: true");
            return n8n("DELETE", `credentials/${need(a.id, "id")}`);
        }
      }),
  );

  server.registerTool(
    "n8n_data_tables",
    {
      title: "Data tables",
      description:
        "n8n Data tables: list, create (with columns), view columns, query rows (filters, search, sort), insert, update or upsert rows by filter, delete matching rows (dry run by default), clear or delete a table (confirm).",
      inputSchema: {
        action: z.enum(["list", "create", "columns", "add_column", "rows", "insert", "update", "upsert", "delete_rows", "clear", "delete_table"]).default("list"),
        table_id: z.string().optional(),
        name: z.string().optional(),
        columns: z.array(z.object({ name: z.string(), type: z.enum(["string", "number", "boolean", "date"]).default("string") })).optional(),
        rows: z.array(z.record(z.unknown())).optional().describe("insert: rows to add"),
        data: z.record(z.unknown()).optional().describe("update/upsert: values to set"),
        where: z.array(condition).optional(),
        match: z.enum(["and", "or"]).default("and"),
        search: z.string().optional(),
        sort_by: z.string().optional().describe("column:asc or column:desc"),
        dry_run: z.boolean().default(true).describe("delete_rows/update: preview affected rows first"),
        project_id: z.string().optional(),
        limit: schema.limit.default(100),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const table = () => {
          if (!a.table_id) throw new Error("table_id is required");
          return `data-tables/${a.table_id}`;
        };
        const filter = toFilter(a.where, a.match);
        switch (a.action) {
          case "list":
            return (await listAll("data-tables", {}, a.limit)).data;
          case "create":
            return n8n("POST", "data-tables", { body: { name: a.name, columns: a.columns ?? [], projectId: a.project_id } });
          case "columns":
            return n8n("GET", `${table()}/columns`);
          case "add_column":
            if (!a.columns?.length) throw new Error("columns is required");
            return Promise.all(a.columns.map((c) => n8n("POST", `${table()}/columns`, { body: c })));
          case "rows":
            return listAll(`${table()}/rows`, { filter, search: a.search, sortBy: a.sort_by }, a.limit);
          case "insert":
            if (!a.rows?.length) throw new Error("rows is required");
            return n8n("POST", `${table()}/rows`, { body: { data: a.rows, returnType: "count" } });
          case "update":
            if (!filter || !a.data) throw new Error("update needs where and data");
            return n8n("PATCH", `${table()}/rows/update`, { body: { filter, data: a.data, returnData: true, dryRun: a.dry_run } });
          case "upsert":
            if (!filter || !a.data) throw new Error("upsert needs where and data");
            return n8n("POST", `${table()}/rows/upsert`, { body: { filter, data: a.data, returnData: true } });
          case "delete_rows":
            if (!filter) throw new Error("delete_rows needs where (use clear to remove everything)");
            return n8n("DELETE", `${table()}/rows/delete`, { query: { filter, returnData: true, dryRun: a.dry_run } });
          case "clear":
          case "delete_table":
            if (!a.confirm) throw new Error(`${a.action === "clear" ? "Clearing all rows" : "Deleting the table"} is permanent; set confirm: true`);
            return n8n("DELETE", a.action === "clear" ? `${table()}/rows/clear` : table());
        }
      }),
  );

  server.registerTool(
    "n8n_organize",
    {
      title: "Tags, variables, projects, folders",
      description:
        "Organize the instance: tags (list/create/rename/delete), variables ($vars — list/create/update/delete), projects (list/create/rename/delete, members add/remove/role) and project folders (list/create/delete).",
      inputSchema: {
        resource: z.enum(["tags", "variables", "projects", "project_members", "folders"]),
        action: z.enum(["list", "create", "update", "delete", "add", "remove", "set_role"]).default("list"),
        id: z.string().optional().describe("Tag / variable / project / folder ID"),
        project_id: z.string().optional(),
        name: z.string().optional(),
        key: z.string().optional().describe("variables: key"),
        value: z.string().optional().describe("variables: value (not for secrets — use credentials)"),
        user_id: z.string().optional(),
        role: z.string().optional().describe("e.g. project:admin, project:editor, project:viewer"),
        parent_folder_id: z.string().optional(),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const need = (v: string | undefined, name: string) => {
          if (!v) throw new Error(`${name} is required`);
          return v;
        };
        const guard = () => {
          if (!a.confirm) throw new Error(`Deleting ${a.resource} is permanent; set confirm: true`);
        };
        switch (a.resource) {
          case "tags":
            if (a.action === "list") return (await listAll("tags", {}, 5000)).data;
            if (a.action === "create") return n8n("POST", "tags", { body: { name: need(a.name, "name") } });
            if (a.action === "update") return n8n("PUT", `tags/${need(a.id, "id")}`, { body: { name: need(a.name, "name") } });
            if (a.action === "delete") return guard(), n8n("DELETE", `tags/${need(a.id, "id")}`);
            break;
          case "variables":
            if (a.action === "list") return (await listAll("variables", { projectId: a.project_id }, 5000)).data;
            if (a.action === "create") return n8n("POST", "variables", { body: { key: need(a.key, "key"), value: a.value ?? "", projectId: a.project_id } });
            if (a.action === "update") return n8n("PUT", `variables/${need(a.id, "id")}`, { body: { key: need(a.key, "key"), value: a.value ?? "", projectId: a.project_id } });
            if (a.action === "delete") return guard(), n8n("DELETE", `variables/${need(a.id, "id")}`);
            break;
          case "projects":
            if (a.action === "list") return (await listAll("projects", {}, 1000)).data;
            if (a.action === "create") return n8n("POST", "projects", { body: { name: need(a.name, "name") } });
            if (a.action === "update") return n8n("PUT", `projects/${need(a.id, "id")}`, { body: { name: need(a.name, "name") } });
            if (a.action === "delete") return guard(), n8n("DELETE", `projects/${need(a.id, "id")}`);
            break;
          case "project_members": {
            const project = need(a.project_id, "project_id");
            if (a.action === "list") return n8n("GET", `projects/${project}/users`);
            if (a.action === "add") return n8n("POST", `projects/${project}/users`, { body: { relations: [{ userId: need(a.user_id, "user_id"), role: a.role ?? "project:viewer" }] } });
            if (a.action === "set_role") return n8n("PATCH", `projects/${project}/users/${need(a.user_id, "user_id")}`, { body: { role: need(a.role, "role") } });
            if (a.action === "remove") return n8n("DELETE", `projects/${project}/users/${need(a.user_id, "user_id")}`);
            break;
          }
          case "folders": {
            const project = need(a.project_id, "project_id");
            if (a.action === "list") return n8n("GET", `projects/${project}/folders`);
            if (a.action === "create") return n8n("POST", `projects/${project}/folders`, { body: { name: need(a.name, "name"), parentFolderId: a.parent_folder_id } });
            if (a.action === "update") return n8n("PATCH", `projects/${project}/folders/${need(a.id, "id")}`, { body: { name: a.name, parentFolderId: a.parent_folder_id } });
            if (a.action === "delete") return guard(), n8n("DELETE", `projects/${project}/folders/${need(a.id, "id")}`);
            break;
          }
        }
        throw new Error(`${a.action} isn't supported for ${a.resource}`);
      }),
  );

  server.registerTool(
    "n8n_users",
    {
      title: "Users",
      description: "List users (optionally in a project), look one up by ID or email, invite users (global:member or global:admin), change a global role, or remove a user (confirm).",
      inputSchema: {
        action: z.enum(["list", "get", "invite", "set_role", "delete"]).default("list"),
        id: z.string().optional().describe("User ID or email"),
        emails: z.array(z.string().email()).optional(),
        role: z.enum(["global:member", "global:admin"]).default("global:member"),
        project_id: z.string().optional(),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        switch (a.action) {
          case "list":
            return (await listAll("users", { projectId: a.project_id }, 1000)).data;
          case "get":
            return n8n("GET", `users/${encodeURIComponent(a.id ?? "")}`);
          case "invite":
            if (!a.emails?.length) throw new Error("emails is required");
            return n8n("POST", "users", { body: a.emails.map((email) => ({ email, role: a.role })) });
          case "set_role":
            return n8n("PATCH", `users/${encodeURIComponent(a.id ?? "")}/role`, { body: { newRoleName: a.role } });
          case "delete":
            if (!a.confirm) throw new Error("Removing a user is permanent; set confirm: true");
            return n8n("DELETE", `users/${encodeURIComponent(a.id ?? "")}`);
        }
      }),
  );

  server.registerTool(
    "n8n_instance",
    {
      title: "Instance health, audit, insights, source control",
      description:
        "Instance-level checks: health (URL, API key, native MCP endpoint), security audit (risky credentials, nodes, database, filesystem, instance settings; abandoned workflows), insights summary (executions, failure rate, time saved), API capabilities for this key, and source control status / pull / push.",
      inputSchema: {
        action: z.enum(["health", "audit", "insights", "capabilities", "source_control_status", "source_control_pull", "source_control_push"]).default("health"),
        days_abandoned: z.number().int().positive().optional(),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        project_id: z.string().optional(),
        commit_message: z.string().optional(),
        force: z.boolean().default(false),
      },
    },
    (a) =>
      run(async () => {
        switch (a.action) {
          case "health": {
            const base = instanceUrl();
            const probe = async (url: string, init?: RequestInit) => {
              try {
                const res = await fetch(url, init);
                return res.status;
              } catch (error) {
                return error instanceof Error ? error.message : String(error);
              }
            };
            let api: unknown;
            try {
              const wf = (await n8n("GET", "workflows", { query: { limit: 1 } })) as { data?: unknown[] };
              api = { ok: true, can_read_workflows: Array.isArray(wf.data) };
            } catch (error) {
              api = { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
            return {
              instance: base,
              healthz: await probe(`${base}/healthz`),
              public_api: api,
              native_mcp_endpoint: `${base}/mcp-server/http`,
              // 401 = endpoint up but token missing/wrong; 404 = instance-level MCP disabled; 400/200 = reachable with a valid token.
              native_mcp_status: await probe(`${base}/mcp-server/http`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json, text/event-stream",
                  ...(optionalEnv("N8N_MCP_TOKEN") && { Authorization: `Bearer ${optionalEnv("N8N_MCP_TOKEN")}` }),
                },
                body: "{}",
              }),
              native_mcp_token_set: Boolean(optionalEnv("N8N_MCP_TOKEN")),
            };
          }
          case "audit":
            return n8n("POST", "audit", { body: a.days_abandoned ? { additionalOptions: { daysAbandonedWorkflow: a.days_abandoned } } : {} });
          case "insights":
            return n8n("GET", "insights/summary", { query: { startDate: a.start_date, endDate: a.end_date, projectId: a.project_id } });
          case "capabilities":
            return n8n("GET", "discover");
          case "source_control_status":
            return n8n("GET", "source-control/status", { query: { direction: "push" } });
          case "source_control_pull":
            return n8n("POST", "source-control/pull", { body: { force: a.force } });
          case "source_control_push":
            {
              if (!a.commit_message) throw new Error("commit_message is required");
              const status = (await n8n("GET", "source-control/status", { query: { direction: "push" } })) as { data?: { id: string; type: string; status?: string }[] };
              const files = (status.data ?? []).filter((f) => f.status !== "ignored").map((f) => ({ id: f.id, type: f.type }));
              if (!files.length) return { pushed: 0, note: "Nothing to push" };
              return n8n("POST", "source-control/push", { body: { commitMessage: a.commit_message, fileNames: files, force: a.force } });
            }
        }
      }),
  );
}
