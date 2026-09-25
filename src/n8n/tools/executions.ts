import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { listAll, n8n, schema } from "../client.js";

type Execution = {
  id: string;
  workflowId?: string;
  status?: string;
  mode?: string;
  startedAt?: string;
  stoppedAt?: string | null;
  retryOf?: string | null;
  data?: { resultData?: { runData?: Record<string, NodeRun[]>; error?: ErrorInfo; lastNodeExecuted?: string } };
  workflowData?: { name?: string };
};
type ErrorInfo = { message?: string; description?: string; node?: { name?: string }; httpCode?: string };
type NodeRun = { startTime?: number; executionTime?: number; executionStatus?: string; error?: ErrorInfo; data?: { main?: ({ json?: unknown }[] | null)[] } };

const STATUS = ["canceled", "crashed", "error", "new", "running", "success", "unknown", "waiting"] as const;

const ms = (e: Execution) => (e.startedAt && e.stoppedAt ? Date.parse(e.stoppedAt) - Date.parse(e.startedAt) : null);
const brief = (e: Execution) => ({ id: e.id, workflow_id: e.workflowId, status: e.status, mode: e.mode, started: e.startedAt, duration_ms: ms(e), retry_of: e.retryOf ?? undefined });
const clip = (v: unknown, n = 600) => {
  const s = JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : v;
};

/** Per-node view of a run: status, time, items out, error and a sample of the first output item. */
function explain(e: Execution) {
  const runData = e.data?.resultData?.runData ?? {};
  const nodes = Object.entries(runData).map(([name, runs]) => {
    const last = runs.at(-1) ?? {};
    const items = (last.data?.main ?? []).reduce((n, branch) => n + (branch?.length ?? 0), 0);
    const first = last.data?.main?.find((b) => b?.length)?.[0]?.json;
    return {
      node: name,
      status: last.executionStatus ?? (last.error ? "error" : "success"),
      ms: last.executionTime,
      runs: runs.length,
      items_out: items,
      error: last.error ? { message: last.error.message, description: last.error.description, http_code: last.error.httpCode } : undefined,
      sample: first === undefined ? undefined : clip(first),
    };
  });
  const err = e.data?.resultData?.error;
  return {
    ...brief(e),
    workflow: e.workflowData?.name,
    last_node: e.data?.resultData?.lastNodeExecuted,
    error: err ? { node: err.node?.name, message: err.message, description: err.description } : undefined,
    nodes,
  };
}

export function registerExecutionTools(server: McpServer): void {
  server.registerTool(
    "n8n_executions",
    {
      title: "Executions: list / debug / retry / stop",
      description:
        "Execution history across all workflows: list (filter by workflow, status, time), explain one run node by node (status, timing, item counts, errors, sample output), failure digest grouped by workflow and error, retry (with the saved or latest workflow), stop running ones, or delete (confirm).",
      inputSchema: {
        action: z.enum(["list", "explain", "raw", "failures", "retry", "stop", "stop_many", "delete"]).default("list"),
        id: z.string().optional().describe("Execution ID"),
        workflow_id: z.string().optional(),
        status: z.enum(STATUS).optional(),
        project_id: z.string().optional(),
        since_hours: z.number().positive().optional().describe("Only executions started in the last N hours (failures default: 24)"),
        use_latest_workflow: z.boolean().default(true).describe("retry: run with the current workflow version instead of the saved snapshot"),
        limit: schema.limit.default(100),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const since = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
        const need = () => {
          if (!a.id) throw new Error("id is required");
          return a.id;
        };
        switch (a.action) {
          case "list": {
            const res = await listAll("executions", { workflowId: a.workflow_id, status: a.status, projectId: a.project_id, startedAfter: a.since_hours ? since(a.since_hours) : undefined }, a.limit);
            const execs = res.data as Execution[];
            const counts = execs.reduce<Record<string, number>>((c, e) => ({ ...c, [e.status ?? "unknown"]: (c[e.status ?? "unknown"] ?? 0) + 1 }), {});
            return { count: res.count, has_more: res.has_more, by_status: counts, executions: execs.map(brief) };
          }
          case "explain":
            return explain((await n8n("GET", `executions/${need()}`, { query: { includeData: true } })) as Execution);
          case "raw":
            return n8n("GET", `executions/${need()}`, { query: { includeData: true } });
          case "failures": {
            const res = await listAll("executions", { status: "error", workflowId: a.workflow_id, projectId: a.project_id, startedAfter: since(a.since_hours ?? 24), includeData: true }, Math.min(a.limit, 100));
            const groups = new Map<string, { workflow_id?: string; workflow?: string; node?: string; message?: string; count: number; latest_execution: string; latest_at?: string }>();
            for (const e of res.data as Execution[]) {
              const x = explain(e);
              const node = x.error?.node ?? x.nodes.find((n) => n.error)?.node;
              const message = x.error?.message ?? x.nodes.find((n) => n.error)?.error?.message;
              const key = `${e.workflowId}|${node}|${message}`;
              const g = groups.get(key);
              if (g) g.count++;
              else groups.set(key, { workflow_id: e.workflowId, workflow: x.workflow, node, message, count: 1, latest_execution: e.id, latest_at: e.startedAt });
            }
            return { window_hours: a.since_hours ?? 24, failed_executions: res.count, groups: [...groups.values()].sort((x, y) => y.count - x.count) };
          }
          case "retry":
            return brief((await n8n("POST", `executions/${need()}/retry`, { body: { loadWorkflow: a.use_latest_workflow } })) as Execution);
          case "stop":
            return n8n("POST", `executions/${need()}/stop`);
          case "stop_many":
            return n8n("POST", "executions/stop", { body: { status: a.status === "running" || a.status === "waiting" ? [a.status] : ["queued", "running", "waiting"], workflowId: a.workflow_id, startedAfter: a.since_hours ? since(a.since_hours) : undefined } });
          case "delete":
            if (!a.confirm) throw new Error("Deleting execution history is permanent; set confirm: true");
            return n8n("DELETE", `executions/${need()}`);
        }
      }),
  );
}
