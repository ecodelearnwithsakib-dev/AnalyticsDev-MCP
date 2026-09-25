import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { compactTask, cu, PRIORITY, priority, resolveFields, schema, teamId, toMs, userIds } from "../client.js";

type RawTask = Parameters<typeof compactTask>[0] & { list?: { id: string; name?: string }; status?: { status?: string; type?: string } };

const findInput = {
  list_ids: z.array(z.string()).optional(),
  folder_ids: z.array(z.string()).optional(),
  space_ids: z.array(z.string()).optional(),
  statuses: z.array(z.string()).optional(),
  assignees: schema.people,
  tags: z.array(z.string()).optional(),
  due_before: schema.date,
  due_after: schema.date,
  created_after: schema.date,
  updated_after: schema.date,
  done_after: schema.date.describe("Closed on/after (implies include_closed)"),
  preset: z.enum(["overdue", "due_today", "due_this_week", "my_open_tasks", "unassigned", "recently_updated"]).optional(),
  include_closed: z.boolean().default(false),
  include_subtasks: z.boolean().default(true),
  custom_field_filters: z.array(z.object({ field_id: z.string(), operator: z.string().default("="), value: z.unknown() })).optional().describe("ClickUp custom_fields filter, e.g. {field_id, operator: \"=\", value}"),
  order_by: z.enum(["created", "updated", "due_date", "id"]).default("updated"),
  limit: z.number().int().min(1).max(2000).default(100),
  team_id: schema.team_id,
};
type FindArgs = { [K in keyof typeof findInput]: z.infer<(typeof findInput)[K]> };

/** Workspace-wide filtered task search (Get Filtered Team Tasks), following pages until `limit`. */
export async function findTasks(a: FindArgs): Promise<RawTask[]> {
  const team = await teamId(a.team_id);
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const query: Record<string, unknown> = {
    "list_ids[]": a.list_ids,
    "project_ids[]": a.folder_ids,
    "space_ids[]": a.space_ids,
    "statuses[]": a.statuses,
    "assignees[]": await userIds(a.assignees, team),
    "tags[]": a.tags,
    due_date_lt: a.due_before ? toMs(a.due_before).ms : undefined,
    due_date_gt: a.due_after ? toMs(a.due_after).ms : undefined,
    date_created_gt: a.created_after ? toMs(a.created_after).ms : undefined,
    date_updated_gt: a.updated_after ? toMs(a.updated_after).ms : undefined,
    date_done_gt: a.done_after ? toMs(a.done_after).ms : undefined,
    include_closed: a.include_closed || Boolean(a.done_after),
    subtasks: a.include_subtasks,
    custom_fields: a.custom_field_filters,
    order_by: a.order_by,
    reverse: true,
  };
  switch (a.preset) {
    case "overdue":
      query.due_date_lt = Date.now();
      break;
    case "due_today":
      query.due_date_lt = endOfDay.getTime();
      query.due_date_gt = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - 1;
      break;
    case "due_this_week":
      query.due_date_lt = endOfDay.getTime() + 6 * 86_400_000;
      break;
    case "my_open_tasks":
      query["assignees[]"] = await userIds(["me"], team);
      break;
    case "recently_updated":
      query.date_updated_gt ??= Date.now() - 7 * 86_400_000;
      break;
  }
  const tasks: RawTask[] = [];
  for (let page = 0; tasks.length < a.limit; page++) {
    const res = (await cu("GET", `v2/team/${team}/task`, { query: { ...query, page } })) as { tasks: RawTask[]; last_page?: boolean };
    tasks.push(...res.tasks);
    if (res.last_page !== false || !res.tasks.length) break;
  }
  const out = a.preset === "unassigned" ? tasks.filter((t) => !t.assignees?.length) : tasks;
  return out.slice(0, a.limit);
}

const count = (tasks: RawTask[], key: (t: RawTask) => string[]) =>
  Object.entries(tasks.reduce<Record<string, number>>((acc, t) => (key(t).forEach((k) => (acc[k] = (acc[k] ?? 0) + 1)), acc), {})).sort((x, y) => y[1] - x[1]);

/** Build a create/update body from friendly inputs. */
async function taskBody(a: TaskEdit, team: string, listId?: string) {
  const body: Record<string, unknown> = {};
  if (a.name) body.name = a.name;
  if (a.description !== undefined) body.markdown_content = a.description;
  if (a.status) body.status = a.status;
  if (a.priority) body.priority = a.priority === "none" ? null : PRIORITY[a.priority];
  if (a.due) {
    const d = toMs(a.due);
    Object.assign(body, { due_date: d.ms, due_date_time: d.hasTime });
  }
  if (a.start) {
    const d = toMs(a.start);
    Object.assign(body, { start_date: d.ms, start_date_time: d.hasTime });
  }
  if (a.estimate_hours !== undefined) body.time_estimate = Math.round(a.estimate_hours * 3_600_000);
  if (a.points !== undefined) body.points = a.points;
  if (a.parent) body.parent = a.parent;
  if (a.fields && listId) body.custom_fields = await resolveFields(listId, a.fields, team);
  return body;
}

const taskEdit = {
  name: z.string().optional(),
  description: z.string().optional().describe("Markdown"),
  status: z.string().optional(),
  priority: priority.optional(),
  due: schema.date,
  start: schema.date,
  estimate_hours: z.number().nonnegative().optional(),
  points: z.number().optional(),
  parent: z.string().optional().describe("Parent task ID → makes this a subtask"),
  assignees: schema.people.describe("create: assignees; update: people to add"),
  remove_assignees: schema.people,
  tags: z.array(z.string()).optional(),
  fields: schema.fields,
};
type TaskEdit = { [K in keyof typeof taskEdit]?: z.infer<(typeof taskEdit)[K]> };

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    "clickup_find_tasks",
    {
      title: "Find tasks",
      description:
        "Search tasks across the whole workspace: by list/folder/space, status, assignee (names or emails), tags, due/created/updated/closed dates, custom fields, or presets (overdue, due_today, due_this_week, my_open_tasks, unassigned, recently_updated). Returns compact tasks plus counts by status, assignee and list.",
      inputSchema: findInput,
    },
    (a) =>
      run(async () => {
        const tasks = await findTasks(a);
        return {
          count: tasks.length,
          by_status: Object.fromEntries(count(tasks, (t) => [t.status?.status ?? "?"])),
          by_assignee: Object.fromEntries(count(tasks, (t) => (t.assignees?.length ? t.assignees.map((x) => x.username ?? String(x.id)) : ["(unassigned)"]))),
          by_list: Object.fromEntries(count(tasks, (t) => [t.list?.name ?? "?"])),
          tasks: tasks.map(compactTask),
        };
      }),
  );

  server.registerTool(
    "clickup_task",
    {
      title: "Get / create / update / delete a task",
      description:
        "One task: get (full details incl. subtasks, custom fields, checklists), create in a list (markdown description, assignees by name/email, due like 'tomorrow' or '2026-10-01', priority, tags, estimate, custom fields by name, subtask via parent), update (only what changes; add/remove assignees), move to another list, add to/remove from extra lists, create from a template, merge duplicates into it, or delete (confirm).",
      inputSchema: {
        action: z.enum(["get", "create", "update", "move", "add_to_list", "remove_from_list", "from_template", "merge", "delete"]).default("get"),
        task_id: z.string().optional().describe("Task ID (or custom ID like DEV-123 with custom_id: true)"),
        custom_id: z.boolean().default(false),
        list_id: z.string().optional().describe("create/from_template: target list; move/add/remove: the list"),
        template_id: z.string().optional(),
        merge_ids: z.array(z.string()).optional().describe("merge: tasks merged into task_id"),
        notify: z.boolean().default(false),
        ...taskEdit,
        team_id: schema.team_id,
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const team = await teamId(a.team_id);
        const ref = { custom_task_ids: a.custom_id || undefined, team_id: a.custom_id ? team : undefined };
        const need = (v: string | undefined, name: string) => {
          if (!v) throw new Error(`${name} is required`);
          return v;
        };
        switch (a.action) {
          case "get":
            return cu("GET", `v2/task/${need(a.task_id, "task_id")}`, { query: { ...ref, include_subtasks: true, include_markdown_description: true } });
          case "create": {
            const listId = need(a.list_id, "list_id");
            const body = {
              ...(await taskBody(a, team, listId)),
              name: need(a.name, "name"),
              assignees: await userIds(a.assignees, team),
              tags: a.tags,
              notify_all: a.notify,
            };
            return compactTask((await cu("POST", `v2/list/${listId}/task`, { body })) as RawTask);
          }
          case "update": {
            const id = need(a.task_id, "task_id");
            let listId = a.list_id;
            if (a.fields && !listId) listId = ((await cu("GET", `v2/task/${id}`, { query: ref })) as RawTask).list?.id;
            const { custom_fields, ...body } = await taskBody(a, team, listId);
            if (a.assignees?.length || a.remove_assignees?.length) body.assignees = { add: await userIds(a.assignees, team), rem: await userIds(a.remove_assignees, team) };
            const updated = Object.keys(body).length ? ((await cu("PUT", `v2/task/${id}`, { query: ref, body })) as RawTask) : undefined;
            for (const f of (custom_fields as { id: string; value: unknown }[] | undefined) ?? []) await cu("POST", `v2/task/${id}/field/${f.id}`, { query: ref, body: { value: f.value } });
            for (const tag of a.tags ?? []) await cu("POST", `v2/task/${id}/tag/${encodeURIComponent(tag)}`, { query: ref });
            return updated ? compactTask(updated) : compactTask((await cu("GET", `v2/task/${id}`, { query: ref })) as RawTask);
          }
          case "move":
            return cu("PUT", `v3/workspaces/${team}/tasks/${need(a.task_id, "task_id")}/home_list/${need(a.list_id, "list_id")}`, { body: { move_custom_fields: true } });
          case "add_to_list":
            return cu("POST", `v2/list/${need(a.list_id, "list_id")}/task/${need(a.task_id, "task_id")}`);
          case "remove_from_list":
            return cu("DELETE", `v2/list/${need(a.list_id, "list_id")}/task/${need(a.task_id, "task_id")}`);
          case "from_template":
            return cu("POST", `v2/list/${need(a.list_id, "list_id")}/taskTemplate/${need(a.template_id, "template_id")}`, { body: { name: need(a.name, "name") } });
          case "merge":
            if (!a.merge_ids?.length) throw new Error("merge_ids is required");
            return cu("POST", `v2/task/${need(a.task_id, "task_id")}/merge`, { body: { source_task_ids: a.merge_ids } });
          case "delete":
            if (!a.confirm) throw new Error("Deleting a task is permanent; set confirm: true (or set its status to closed/archive instead)");
            return cu("DELETE", `v2/task/${need(a.task_id, "task_id")}`, { query: ref });
        }
      }),
  );

  server.registerTool(
    "clickup_bulk_tasks",
    {
      title: "Bulk create / update",
      description:
        "Create many tasks in a list at once (each with its own assignees, due, priority, tags, fields), or apply the same change (status, priority, due, add/remove assignees, archive) to many tasks — given as IDs or found with the same filters as clickup_find_tasks. Runs sequentially within ClickUp's rate limit; set dry_run to preview which tasks a filter hits.",
      inputSchema: {
        action: z.enum(["create", "update"]),
        list_id: z.string().optional().describe("create: target list"),
        tasks: z.array(z.object(taskEdit).extend({ name: z.string() })).max(500).optional().describe("create: the tasks"),
        task_ids: z.array(z.string()).max(1000).optional().describe("update: tasks to change"),
        filter: z.object(findInput).partial().optional().describe("update: select tasks with clickup_find_tasks filters instead of IDs"),
        set: z.object({ ...taskEdit, archived: z.boolean().optional() }).optional().describe("update: the change to apply"),
        dry_run: z.boolean().default(false),
        team_id: schema.team_id,
      },
    },
    (a) =>
      run(async () => {
        const team = await teamId(a.team_id);
        const results: Record<string, unknown>[] = [];
        if (a.action === "create") {
          if (!a.list_id || !a.tasks?.length) throw new Error("create needs list_id and tasks");
          if (a.dry_run) return { would_create: a.tasks.map((t) => t.name) };
          for (const t of a.tasks) {
            try {
              const body = { ...(await taskBody(t, team, a.list_id)), name: t.name, assignees: await userIds(t.assignees, team), tags: t.tags };
              const created = (await cu("POST", `v2/list/${a.list_id}/task`, { body })) as RawTask;
              results.push({ id: created.id, name: created.name, url: created.url });
            } catch (error) {
              results.push({ name: t.name, error: error instanceof Error ? error.message : String(error) });
            }
          }
          return { created: results.filter((r) => !r.error).length, failed: results.filter((r) => r.error).length, results };
        }
        if (!a.set) throw new Error("update needs set");
        const ids = a.task_ids ?? (a.filter ? (await findTasks({ ...findDefaults, ...a.filter, team_id: team })).map((t) => t.id) : []);
        if (!ids.length) throw new Error("No tasks selected — pass task_ids or a filter that matches something");
        if (a.dry_run) return { would_update: ids.length, task_ids: ids };
        const { custom_fields: _cf, ...body } = await taskBody({ ...a.set, fields: undefined }, team);
        if (a.set.assignees?.length || a.set.remove_assignees?.length) body.assignees = { add: await userIds(a.set.assignees, team), rem: await userIds(a.set.remove_assignees, team) };
        if (a.set.archived !== undefined) body.archived = a.set.archived;
        for (const id of ids) {
          try {
            if (Object.keys(body).length) await cu("PUT", `v2/task/${id}`, { body });
            for (const tag of a.set.tags ?? []) await cu("POST", `v2/task/${id}/tag/${encodeURIComponent(tag)}`);
            results.push({ id, ok: true });
          } catch (error) {
            results.push({ id, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return { updated: results.filter((r) => r.ok).length, failed: results.filter((r) => r.error).length, errors: results.filter((r) => r.error) };
      }),
  );

  server.registerTool(
    "clickup_report",
    {
      title: "Status report",
      description:
        "Health report for a list, folder, space or the whole workspace: open tasks by status and assignee, overdue (with names), due in the next 7 days, unassigned, and completed in the last N days per person.",
      inputSchema: {
        list_ids: z.array(z.string()).optional(),
        folder_ids: z.array(z.string()).optional(),
        space_ids: z.array(z.string()).optional(),
        assignees: schema.people,
        days: z.number().int().min(1).max(365).default(7),
        team_id: schema.team_id,
      },
    },
    (a) =>
      run(async () => {
        const scope = { ...findDefaults, list_ids: a.list_ids, folder_ids: a.folder_ids, space_ids: a.space_ids, assignees: a.assignees, team_id: a.team_id };
        const open = await findTasks({ ...scope, limit: 2000 });
        const done = await findTasks({ ...scope, done_after: `-${a.days}d`, include_closed: true, limit: 2000 });
        const now = Date.now();
        const overdue = open.filter((t) => t.due_date && Number(t.due_date) < now);
        const soon = open.filter((t) => t.due_date && Number(t.due_date) >= now && Number(t.due_date) < now + 7 * 86_400_000);
        const closed = done.filter((t) => t.date_closed && Number(t.date_closed) >= now - a.days * 86_400_000);
        const who = (t: RawTask) => (t.assignees?.length ? t.assignees.map((x) => x.username ?? String(x.id)) : ["(unassigned)"]);
        return {
          open: open.length,
          open_by_status: Object.fromEntries(count(open, (t) => [t.status?.status ?? "?"])),
          open_by_assignee: Object.fromEntries(count(open, who)),
          overdue: { count: overdue.length, tasks: overdue.slice(0, 50).map(compactTask) },
          due_next_7_days: { count: soon.length, tasks: soon.slice(0, 50).map(compactTask) },
          unassigned: open.filter((t) => !t.assignees?.length).length,
          [`completed_last_${a.days}_days`]: { count: closed.length, by_assignee: Object.fromEntries(count(closed, who)) },
        };
      }),
  );
}

const findDefaults: FindArgs = {
  include_closed: false,
  include_subtasks: true,
  order_by: "updated",
  limit: 1000,
} as FindArgs;
