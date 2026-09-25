import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { instanceUrl, listAll, n8n, schema, summarize, writableWorkflow, type Workflow } from "../client.js";

const getWorkflow = async (id: string) => (await n8n("GET", `workflows/${id}`, { query: { excludePinnedData: true } })) as Workflow;

export function registerWorkflowTools(server: McpServer): void {
  server.registerTool(
    "n8n_api_request",
    {
      title: "n8n API request",
      description:
        "Call ANY n8n public REST API endpoint (relative to /api/v1), e.g. GET discover, POST workflows/{id}/test-runs, GET insights/summary, PATCH data-tables/{id}/rows/update, POST n8n-packages/export, GET settings/log-streaming/destinations.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string(),
        query: z.record(z.unknown()).optional(),
        body: z.unknown().optional(),
      },
    },
    ({ method, path, query, body }) => run(() => n8n(method, path, { query, body })),
  );

  server.registerTool(
    "n8n_workflows",
    {
      title: "List / get / export workflows",
      description:
        "Every workflow in the instance (not only MCP-enabled ones): list with filters (compact: triggers, node count, tags, MCP access), get one in full, or export one to a local .json file.",
      inputSchema: {
        action: z.enum(["list", "get", "export"]).default("list"),
        id: z.string().optional(),
        active: z.boolean().optional(),
        name: z.string().optional().describe("Name filter"),
        tags: z.array(z.string()).optional(),
        project_id: z.string().optional(),
        file_path: z.string().optional().describe("export: where to write the JSON"),
        limit: schema.limit,
      },
    },
    (a) =>
      run(async () => {
        if (a.action === "list") {
          const res = await listAll("workflows", { active: a.active, name: a.name, tags: a.tags?.join(","), projectId: a.project_id, excludePinnedData: true }, a.limit);
          return { count: res.count, has_more: res.has_more, workflows: (res.data as Workflow[]).map(summarize) };
        }
        if (!a.id) throw new Error("id is required");
        const wf = await getWorkflow(a.id);
        if (a.action === "get") return wf;
        const path = a.file_path ?? `${wf.name.replace(/[^\w.-]+/g, "_")}.json`;
        writeFileSync(path, JSON.stringify(wf, null, 2));
        return { exported: path, ...summarize(wf) };
      }),
  );

  server.registerTool(
    "n8n_workflow_save",
    {
      title: "Create / update / import workflow",
      description:
        "Create a workflow from JSON (or a local .json export), or update one. For updates you can pass only what changes (name, nodes, connections, settings, description) — the rest is kept. New workflows are created inactive.",
      inputSchema: {
        id: z.string().optional().describe("Update this workflow; omit to create"),
        workflow: z.record(z.unknown()).optional().describe("Workflow JSON: {name, nodes, connections, settings}"),
        file_path: z.string().optional().describe("Import from a local n8n JSON export"),
        name: z.string().optional(),
        settings: z.record(z.unknown()).optional().describe("Merged into existing settings, e.g. {\"errorWorkflow\":\"123\",\"timezone\":\"Asia/Dhaka\"}"),
        description: z.string().optional(),
        project_id: z.string().optional().describe("Create in this project"),
        publish_if_active: z.boolean().default(false).describe("Update: republish if the workflow is active"),
      },
    },
    (a) =>
      run(async () => {
        const input = (a.file_path ? JSON.parse(readFileSync(a.file_path, "utf8")) : a.workflow ?? {}) as Partial<Workflow>;
        if (a.id) {
          const current = await getWorkflow(a.id);
          const merged: Partial<Workflow> = { ...current, ...input, settings: { ...current.settings, ...input.settings, ...a.settings } };
          if (a.name) merged.name = a.name;
          if (a.description !== undefined) merged.description = a.description;
          const saved = (await n8n("PUT", `workflows/${a.id}`, { body: writableWorkflow(merged), query: { publishIfActive: a.publish_if_active || undefined } })) as Workflow;
          return { updated: summarize(saved) };
        }
        const body: Partial<Workflow> = { ...input, settings: { executionOrder: "v1", ...input.settings, ...a.settings } };
        if (a.name) body.name = a.name;
        if (!body.name) throw new Error("name is required for a new workflow");
        if (a.description !== undefined) body.description = a.description;
        const created = (await n8n("POST", "workflows", { body: { ...writableWorkflow(body), ...(a.project_id && { projectId: a.project_id }) } })) as Workflow;
        return { created: summarize(created), url: `${instanceUrl()}/workflow/${created.id}` };
      }),
  );

  server.registerTool(
    "n8n_workflow_action",
    {
      title: "Publish / deactivate / archive / MCP access / tags / delete",
      description:
        "Workflow lifecycle: publish (activate), unpublish, archive, unarchive, enable or disable MCP access (so the native n8n MCP tools can run and edit it), set tags, move to another project, duplicate, or delete permanently (confirm).",
      inputSchema: {
        id: z.string(),
        action: z.enum(["publish", "unpublish", "archive", "unarchive", "enable_mcp", "disable_mcp", "set_tags", "transfer", "duplicate", "delete"]),
        tag_names: z.array(z.string()).optional().describe("set_tags: tags are created if missing"),
        project_id: z.string().optional().describe("transfer: destination project"),
        new_name: z.string().optional().describe("duplicate: name of the copy"),
        version_id: z.string().optional().describe("publish: a specific version from its history"),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        switch (a.action) {
          case "publish":
            return n8n("POST", `workflows/${a.id}/activate`, { body: a.version_id ? { versionId: a.version_id } : {} });
          case "unpublish":
            return n8n("POST", `workflows/${a.id}/deactivate`);
          case "archive":
          case "unarchive":
            return n8n("POST", `workflows/${a.id}/${a.action}`);
          case "enable_mcp":
          case "disable_mcp": {
            const wf = await getWorkflow(a.id);
            const saved = (await n8n("PUT", `workflows/${a.id}`, { body: writableWorkflow({ ...wf, settings: { ...wf.settings, availableInMCP: a.action === "enable_mcp" } }) })) as Workflow;
            return {
              ...summarize(saved),
              note: a.action === "enable_mcp" ? "MCP access needs a published workflow with a webhook, form, schedule or chat trigger, and instance-level MCP turned on." : undefined,
            };
          }
          case "set_tags": {
            const wanted = a.tag_names ?? [];
            const existing = (await listAll("tags", {}, 5000)).data as { id: string; name: string }[];
            const ids = [];
            for (const name of wanted) {
              const hit = existing.find((t) => t.name.toLowerCase() === name.toLowerCase());
              ids.push({ id: hit ? hit.id : ((await n8n("POST", "tags", { body: { name } })) as { id: string }).id });
            }
            return n8n("PUT", `workflows/${a.id}/tags`, { body: ids });
          }
          case "transfer":
            if (!a.project_id) throw new Error("project_id is required");
            return n8n("PUT", `workflows/${a.id}/transfer`, { body: { destinationProjectId: a.project_id } });
          case "duplicate": {
            const wf = await getWorkflow(a.id);
            const copy = (await n8n("POST", "workflows", { body: writableWorkflow({ ...wf, name: a.new_name ?? `${wf.name} (copy)` }) })) as Workflow;
            return { duplicated: summarize(copy), note: "The copy is inactive; webhook paths are shared with the original, so change them before publishing." };
          }
          case "delete":
            if (!a.confirm) throw new Error("Deleting a workflow is permanent (archive is reversible); set confirm: true");
            return n8n("DELETE", `workflows/${a.id}`);
        }
      }),
  );

  server.registerTool(
    "n8n_trigger_webhook",
    {
      title: "Call a workflow's webhook",
      description:
        "Run a workflow through its Webhook trigger, even when it isn't MCP-enabled: finds the webhook node's path and method, then calls the production URL (published workflow) or the test URL (while 'Listen for test event' is on in the editor).",
      inputSchema: {
        workflow_id: z.string(),
        node_name: z.string().optional().describe("Which webhook node, if the workflow has several"),
        test: z.boolean().default(false),
        body: z.unknown().optional(),
        query: z.record(z.string()).optional(),
        headers: z.record(z.string()).optional(),
      },
    },
    (a) =>
      run(async () => {
        const wf = await getWorkflow(a.workflow_id);
        const hooks = (wf.nodes ?? []).filter((n) => n.type === "n8n-nodes-base.webhook" && !n.disabled);
        const node = a.node_name ? hooks.find((n) => n.name === a.node_name) : hooks[0];
        if (!node) throw new Error(`No enabled Webhook trigger found${a.node_name ? ` named "${a.node_name}"` : ""} in "${wf.name}"`);
        const path = String(node.parameters?.path ?? node.webhookId ?? "").replace(/^\/+/, "");
        const method = String(node.parameters?.httpMethod ?? "GET").toUpperCase();
        if (!a.test && !wf.active) throw new Error(`"${wf.name}" isn't published, so its production webhook is off; publish it or use test: true`);
        const url = `${instanceUrl()}/${a.test ? "webhook-test" : "webhook"}/${path}${a.query ? `?${new URLSearchParams(a.query)}` : ""}`;
        const hasBody = a.body !== undefined && !["GET", "HEAD"].includes(method);
        const res = await fetch(url, {
          method,
          headers: { ...(hasBody && { "Content-Type": "application/json" }), ...a.headers },
          body: hasBody ? JSON.stringify(a.body) : undefined,
        });
        const text = await res.text();
        let response: unknown = text;
        try {
          response = JSON.parse(text);
        } catch {
          // keep text
        }
        return { url, method, status: res.status, response: typeof response === "string" ? response.slice(0, 5000) : response };
      }),
  );
}
