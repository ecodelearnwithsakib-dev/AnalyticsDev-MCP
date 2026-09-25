import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { compactTask, cu, schema, teamId, toMs, userIds } from "../client.js";

const need = (v: string | undefined, name: string) => {
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const hours = (ms: number) => Math.round((ms / 3_600_000) * 100) / 100;

type TimeEntry = {
  id: string;
  duration: string;
  start: string;
  end?: string;
  billable?: boolean;
  description?: string;
  user?: { id: number; username?: string };
  task?: { id: string; name?: string } | string;
  task_location?: { list_name?: string; folder_name?: string; space_name?: string };
  tags?: { name: string }[];
};

const WEBHOOK_EVENTS = [
  "*",
  "taskCreated",
  "taskUpdated",
  "taskDeleted",
  "taskPriorityUpdated",
  "taskStatusUpdated",
  "taskAssigneeUpdated",
  "taskDueDateUpdated",
  "taskTagUpdated",
  "taskMoved",
  "taskCommentPosted",
  "taskCommentUpdated",
  "taskTimeEstimateUpdated",
  "taskTimeTrackedUpdated",
  "listCreated",
  "listUpdated",
  "listDeleted",
  "folderCreated",
  "folderUpdated",
  "folderDeleted",
  "spaceCreated",
  "spaceUpdated",
  "spaceDeleted",
  "goalCreated",
  "goalUpdated",
  "goalDeleted",
  "keyResultCreated",
  "keyResultUpdated",
  "keyResultDeleted",
] as const;

export function registerExtraTools(server: McpServer): void {
  server.registerTool(
    "clickup_time",
    {
      title: "Time tracking",
      description:
        "Timesheets: hours report for a date range grouped by person, task, list, tag or day (billable split), raw entries, the running timer, start/stop a timer on a task, log time manually, edit or delete (confirm) an entry, and time-in-status for tasks.",
      inputSchema: {
        action: z.enum(["report", "entries", "running", "start", "stop", "log", "update", "delete", "time_in_status"]).default("report"),
        from: schema.date.describe("report/entries: start (default: 7 days ago)"),
        to: schema.date.describe("report/entries: end (default: now)"),
        group_by: z.enum(["user", "task", "list", "tag", "day"]).default("user"),
        people: schema.people.describe("Whose time (admins can see everyone; default: everyone you can see)"),
        space_id: z.string().optional(),
        folder_id: z.string().optional(),
        list_id: z.string().optional(),
        task_id: z.string().optional(),
        task_ids: z.array(z.string()).optional().describe("time_in_status: up to 100 tasks"),
        entry_id: z.string().optional(),
        start: schema.date.describe("log/update: when the work started"),
        duration_minutes: z.number().positive().optional(),
        description: z.string().optional(),
        billable: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
        team_id: schema.team_id,
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const team = await teamId(a.team_id);
        const tagList = a.tags?.map((name) => ({ name }));
        switch (a.action) {
          case "report":
          case "entries": {
            const assignee = a.people?.length ? (await userIds(a.people, team)).join(",") : undefined;
            const res = (await cu("GET", `v2/team/${team}/time_entries`, {
              query: {
                start_date: a.from ? toMs(a.from).ms : Date.now() - 7 * 86_400_000,
                end_date: a.to ? toMs(a.to).ms : Date.now(),
                assignee,
                space_id: a.space_id,
                folder_id: a.folder_id,
                list_id: a.list_id,
                task_id: a.task_id,
                include_location_names: true,
                include_task_tags: true,
              },
            })) as { data: TimeEntry[] };
            const entries = res.data.map((e) => ({
              id: e.id,
              user: e.user?.username,
              task: typeof e.task === "object" ? e.task?.name : undefined,
              task_id: typeof e.task === "object" ? e.task?.id : undefined,
              list: e.task_location?.list_name,
              date: new Date(Number(e.start)).toISOString().slice(0, 10),
              // A running timer reports a negative duration; count the time elapsed so far instead.
              hours: hours(Number(e.duration) < 0 ? Date.now() - Number(e.start) : Number(e.duration)),
              running: Number(e.duration) < 0 || undefined,
              billable: e.billable,
              tags: e.tags?.map((t) => t.name),
              description: e.description || undefined,
            }));
            if (a.action === "entries") return { count: entries.length, total_hours: hours(entries.reduce((s, e) => s + e.hours * 3_600_000, 0)), entries };
            const groups = new Map<string, { hours: number; billable_hours: number; entries: number }>();
            for (const e of entries) {
              const keys = a.group_by === "tag" ? (e.tags?.length ? e.tags : ["(no tag)"]) : [String({ user: e.user, task: e.task, list: e.list, day: e.date }[a.group_by] ?? "(none)")];
              for (const k of keys) {
                const g = groups.get(k) ?? { hours: 0, billable_hours: 0, entries: 0 };
                g.hours += e.hours;
                if (e.billable) g.billable_hours += e.hours;
                g.entries++;
                groups.set(k, g);
              }
            }
            const total = entries.reduce((s, e) => s + e.hours, 0);
            return {
              total_hours: Math.round(total * 100) / 100,
              billable_hours: Math.round(entries.filter((e) => e.billable).reduce((s, e) => s + e.hours, 0) * 100) / 100,
              [`by_${a.group_by}`]: [...groups].map(([key, g]) => ({ [a.group_by]: key, hours: Math.round(g.hours * 100) / 100, billable_hours: Math.round(g.billable_hours * 100) / 100, entries: g.entries })).sort((x, y) => y.hours - x.hours),
            };
          }
          case "running":
            return cu("GET", `v2/team/${team}/time_entries/current`);
          case "start":
            return cu("POST", `v2/team/${team}/time_entries/start`, { body: { tid: a.task_id, description: a.description, billable: a.billable, tags: tagList } });
          case "stop":
            return cu("POST", `v2/team/${team}/time_entries/stop`);
          case "log": {
            if (!a.duration_minutes) throw new Error("duration_minutes is required");
            const duration = Math.round(a.duration_minutes * 60_000);
            const start = a.start ? toMs(a.start).ms : Date.now() - duration;
            return cu("POST", `v2/team/${team}/time_entries`, {
              body: {
                tid: a.task_id,
                start,
                duration,
                description: a.description,
                billable: a.billable,
                tags: tagList,
                assignee: a.people?.length ? (await userIds(a.people, team))[0] : undefined,
              },
            });
          }
          case "update": {
            const body: Record<string, unknown> = { tags: tagList ?? [] };
            if (a.description !== undefined) body.description = a.description;
            if (a.billable !== undefined) body.billable = a.billable;
            if (a.start) body.start = toMs(a.start).ms;
            if (a.duration_minutes) body.duration = Math.round(a.duration_minutes * 60_000);
            if (a.task_id) body.tid = a.task_id;
            if (tagList) body.tag_action = "add";
            return cu("PUT", `v2/team/${team}/time_entries/${need(a.entry_id, "entry_id")}`, { body });
          }
          case "delete":
            if (!a.confirm) throw new Error("Deleting a time entry is permanent; set confirm: true");
            return cu("DELETE", `v2/team/${team}/time_entries/${need(a.entry_id, "entry_id")}`);
          case "time_in_status": {
            const ids = a.task_ids ?? (a.task_id ? [a.task_id] : []);
            if (!ids.length) throw new Error("task_id or task_ids is required");
            if (ids.length === 1) return cu("GET", `v2/task/${ids[0]}/time_in_status`);
            return cu("GET", "v2/task/bulk_time_in_status/task_ids", { query: { task_ids: ids.join(",") } });
          }
        }
      }),
  );

  server.registerTool(
    "clickup_goals",
    {
      title: "Goals & key results",
      description: "List goals with progress, get one with its key results (targets), create/update/delete (confirm) goals, and add, update progress of, or delete key results (number, currency, true/false, percentage, or automatic from tasks/lists).",
      inputSchema: {
        action: z.enum(["list", "get", "create", "update", "delete", "add_target", "update_target", "delete_target"]).default("list"),
        goal_id: z.string().optional(),
        target_id: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        due: schema.date,
        owners: schema.people,
        remove_owners: schema.people,
        color: z.string().optional(),
        type: z.enum(["number", "currency", "boolean", "percentage", "automatic"]).default("number"),
        start: z.number().default(0),
        end: z.number().optional(),
        current: z.number().optional().describe("update_target: new progress value"),
        unit: z.string().default(""),
        task_ids: z.array(z.string()).default([]),
        list_ids: z.array(z.string()).default([]),
        note: z.string().optional(),
        include_completed: z.boolean().default(false),
        team_id: schema.team_id,
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const team = await teamId(a.team_id);
        switch (a.action) {
          case "list": {
            const res = (await cu("GET", `v2/team/${team}/goal`, { query: { include_completed: a.include_completed } })) as { goals: { id: string; name: string; percent_completed?: number; due_date?: string; owners?: { username?: string }[] }[] };
            return res.goals.map((g) => ({ id: g.id, name: g.name, progress_pct: g.percent_completed, due: g.due_date ? new Date(Number(g.due_date)).toISOString().slice(0, 10) : undefined, owners: g.owners?.map((o) => o.username) }));
          }
          case "get":
            return cu("GET", `v2/goal/${need(a.goal_id, "goal_id")}`);
          case "create":
            return cu("POST", `v2/team/${team}/goal`, {
              body: {
                name: need(a.name, "name"),
                description: a.description ?? "",
                due_date: a.due ? toMs(a.due).ms : Date.now() + 90 * 86_400_000,
                multiple_owners: true,
                owners: await userIds(a.owners?.length ? a.owners : ["me"], team),
                color: a.color ?? "#32a852",
              },
            });
          case "update": {
            const id = need(a.goal_id, "goal_id");
            const { goal } = (await cu("GET", `v2/goal/${id}`)) as { goal: { name: string; description?: string; due_date?: string; color?: string } };
            return cu("PUT", `v2/goal/${id}`, {
              body: {
                name: a.name ?? goal.name,
                description: a.description ?? goal.description ?? "",
                due_date: a.due ? toMs(a.due).ms : Number(goal.due_date),
                color: a.color ?? goal.color,
                add_owners: await userIds(a.owners, team),
                rem_owners: await userIds(a.remove_owners, team),
              },
            });
          }
          case "delete":
            if (!a.confirm) throw new Error("Deleting a goal removes its targets too; set confirm: true");
            return cu("DELETE", `v2/goal/${need(a.goal_id, "goal_id")}`);
          case "add_target":
            return cu("POST", `v2/goal/${need(a.goal_id, "goal_id")}/key_result`, {
              body: {
                name: need(a.name, "name"),
                owners: await userIds(a.owners?.length ? a.owners : ["me"], team),
                type: a.type,
                steps_start: a.start,
                steps_end: a.end ?? (a.type === "percentage" ? 100 : a.type === "boolean" ? 1 : 10),
                unit: a.unit,
                task_ids: a.task_ids,
                list_ids: a.list_ids,
              },
            });
          case "update_target":
            if (a.current === undefined) throw new Error("current is required");
            return cu("PUT", `v2/key_result/${need(a.target_id, "target_id")}`, { body: { steps_current: a.current, note: a.note ?? "" } });
          case "delete_target":
            if (!a.confirm) throw new Error("Deleting a key result is permanent; set confirm: true");
            return cu("DELETE", `v2/key_result/${need(a.target_id, "target_id")}`);
        }
      }),
  );

  server.registerTool(
    "clickup_views",
    {
      title: "Views",
      description: "List views at the workspace (Everything), space, folder or list level, read a view's tasks (pages followed), create a view (list, board, calendar, table, timeline, gantt, workload, activity, map, chat, doc) grouped by a field, rename it, or delete it (confirm).",
      inputSchema: {
        action: z.enum(["list", "get", "tasks", "create", "rename", "delete"]).default("list"),
        level: z.enum(["workspace", "space", "folder", "list"]).default("list"),
        parent_id: z.string().optional().describe("Space, folder or list ID"),
        view_id: z.string().optional(),
        name: z.string().optional(),
        type: z.enum(["list", "board", "calendar", "table", "timeline", "gantt", "workload", "activity", "map", "chat", "doc"]).default("board"),
        group_by: z.enum(["none", "status", "priority", "assignee", "tag", "dueDate"]).default("status"),
        show_closed: z.boolean().default(false),
        limit: z.number().int().min(1).max(2000).default(200),
        team_id: schema.team_id,
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const base = a.level === "workspace" ? `v2/team/${await teamId(a.team_id)}` : `v2/${a.level}/${need(a.parent_id, "parent_id")}`;
        switch (a.action) {
          case "list":
            return cu("GET", `${base}/view`);
          case "get":
            return cu("GET", `v2/view/${need(a.view_id, "view_id")}`);
          case "tasks": {
            const tasks: Parameters<typeof compactTask>[0][] = [];
            for (let page = 0; tasks.length < a.limit; page++) {
              const res = (await cu("GET", `v2/view/${need(a.view_id, "view_id")}/task`, { query: { page } })) as { tasks: Parameters<typeof compactTask>[0][]; last_page?: boolean };
              tasks.push(...res.tasks);
              if (res.last_page !== false || !res.tasks.length) break;
            }
            return { count: Math.min(tasks.length, a.limit), tasks: tasks.slice(0, a.limit).map(compactTask) };
          }
          case "create":
            return cu("POST", `${base}/view`, {
              body: {
                name: need(a.name, "name"),
                type: a.type,
                grouping: { field: a.group_by, dir: 1, collapsed: [], ignore: false },
                divide: { field: null, dir: null, collapsed: [] },
                sorting: { fields: [] },
                filters: { op: "AND", fields: [], search: "", show_closed: a.show_closed },
                columns: { fields: [] },
                team_sidebar: { assignees: [], assigned_comments: false, unassigned_tasks: false },
                settings: { show_task_locations: false, show_subtasks: 3, show_subtask_parent_names: false, show_closed_subtasks: false, show_assignees: true, show_images: true, collapse_empty_columns: null, me_comments: true, me_subtasks: true, me_checklists: true },
              },
            });
          case "rename":
            return cu("PUT", `v2/view/${need(a.view_id, "view_id")}`, { body: { name: need(a.name, "name") } });
          case "delete":
            if (!a.confirm) throw new Error("Deleting a view is permanent; set confirm: true");
            return cu("DELETE", `v2/view/${need(a.view_id, "view_id")}`);
        }
      }),
  );

  server.registerTool(
    "clickup_webhooks",
    {
      title: "Webhooks",
      description: "List, create, update (endpoint, events, active/suspended) or delete (confirm) workspace webhooks — e.g. send taskStatusUpdated events for a list to an n8n or Make webhook URL. The signing secret is returned on create; store it where your receiver can read it.",
      inputSchema: {
        action: z.enum(["list", "create", "update", "delete"]).default("list"),
        webhook_id: z.string().optional(),
        endpoint: z.string().url().optional(),
        events: z.array(z.enum(WEBHOOK_EVENTS)).optional(),
        space_id: z.string().optional(),
        folder_id: z.string().optional(),
        list_id: z.string().optional(),
        task_id: z.string().optional(),
        status: z.enum(["active", "suspended"]).optional(),
        team_id: schema.team_id,
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const team = await teamId(a.team_id);
        switch (a.action) {
          case "list": {
            const res = (await cu("GET", `v2/team/${team}/webhook`)) as { webhooks: Record<string, unknown>[] };
            return res.webhooks.map(({ secret: _secret, ...w }) => w);
          }
          case "create":
            return cu("POST", `v2/team/${team}/webhook`, {
              body: {
                endpoint: need(a.endpoint, "endpoint"),
                events: a.events ?? ["*"],
                space_id: a.space_id ? Number(a.space_id) : undefined,
                folder_id: a.folder_id ? Number(a.folder_id) : undefined,
                list_id: a.list_id ? Number(a.list_id) : undefined,
                task_id: a.task_id,
              },
            });
          case "update": {
            const id = need(a.webhook_id, "webhook_id");
            const current = ((await cu("GET", `v2/team/${team}/webhook`)) as { webhooks: { id: string; endpoint: string; events: string[]; health?: { status?: string } }[] }).webhooks.find((w) => w.id === id);
            if (!current) throw new Error(`Webhook ${id} not found`);
            return cu("PUT", `v2/webhook/${id}`, {
              body: { endpoint: a.endpoint ?? current.endpoint, events: (a.events ?? current.events).join(","), status: a.status ?? "active" },
            });
          }
          case "delete":
            if (!a.confirm) throw new Error("Deleting a webhook stops its events; set confirm: true");
            return cu("DELETE", `v2/webhook/${need(a.webhook_id, "webhook_id")}`);
        }
      }),
  );

  server.registerTool(
    "clickup_docs",
    {
      title: "Docs",
      description: "Search Docs, read a Doc with all its pages (markdown), create a Doc (in a space, folder, list or the workspace), add a page, or edit a page (replace, append or prepend markdown).",
      inputSchema: {
        action: z.enum(["search", "read", "create", "add_page", "edit_page"]).default("search"),
        doc_id: z.string().optional(),
        page_id: z.string().optional(),
        name: z.string().optional(),
        content: z.string().optional().describe("Markdown"),
        mode: z.enum(["replace", "append", "prepend"]).default("replace"),
        parent_type: z.enum(["workspace", "everything", "space", "folder", "list"]).optional(),
        parent_id: z.string().optional(),
        parent_page_id: z.string().optional(),
        visibility: z.enum(["PUBLIC", "PRIVATE", "PERSONAL", "HIDDEN"]).optional(),
        team_id: schema.team_id,
      },
    },
    (a) =>
      run(async () => {
        const base = `v3/workspaces/${await teamId(a.team_id)}/docs`;
        const parentTypes = { space: 4, folder: 5, list: 6, everything: 7, workspace: 12 } as const;
        switch (a.action) {
          case "search":
            return cu("GET", base, { query: { limit: 100 } });
          case "read": {
            const id = need(a.doc_id, "doc_id");
            const [doc, pages] = await Promise.all([cu("GET", `${base}/${id}`), cu("GET", `${base}/${id}/pages`, { query: { max_page_depth: -1, content_format: "text/md" } })]);
            return { doc, pages };
          }
          case "create":
            return cu("POST", base, {
              body: {
                name: need(a.name, "name"),
                parent: a.parent_type && a.parent_id ? { id: a.parent_id, type: parentTypes[a.parent_type] } : undefined,
                visibility: a.visibility,
                create_page: !a.content,
              },
            }).then(async (doc) => {
              if (a.content) await cu("POST", `${base}/${(doc as { id: string }).id}/pages`, { body: { name: a.name, content: a.content, content_format: "text/md" } });
              return doc;
            });
          case "add_page":
            return cu("POST", `${base}/${need(a.doc_id, "doc_id")}/pages`, { body: { name: need(a.name, "name"), content: a.content ?? "", content_format: "text/md", parent_page_id: a.parent_page_id } });
          case "edit_page":
            return cu("PUT", `${base}/${need(a.doc_id, "doc_id")}/pages/${need(a.page_id, "page_id")}`, {
              body: { name: a.name, content: a.content, content_edit_mode: a.mode, content_format: "text/md" },
            });
        }
      }),
  );

  server.registerTool(
    "clickup_chat",
    {
      title: "Chat",
      description: "ClickUp Chat: list channels, read recent messages of a channel, send a message (markdown) or reply to one, open a direct message with people, or create a channel (optionally on a space/folder/list).",
      inputSchema: {
        action: z.enum(["channels", "messages", "send", "reply", "direct_message", "create_channel"]).default("channels"),
        channel_id: z.string().optional(),
        message_id: z.string().optional(),
        content: z.string().optional().describe("Markdown"),
        people: schema.people.describe("direct_message: who"),
        name: z.string().optional(),
        location_type: z.enum(["space", "folder", "list"]).optional(),
        location_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(30),
        team_id: schema.team_id,
      },
    },
    (a) =>
      run(async () => {
        const team = await teamId(a.team_id);
        const base = `v3/workspaces/${team}/chat`;
        switch (a.action) {
          case "channels":
            return cu("GET", `${base}/channels`, { query: { limit: 100 } });
          case "messages":
            return cu("GET", `${base}/channels/${need(a.channel_id, "channel_id")}/messages`, { query: { limit: a.limit, content_format: "text/md" } });
          case "send":
            return cu("POST", `${base}/channels/${need(a.channel_id, "channel_id")}/messages`, { body: { type: "message", content: need(a.content, "content"), content_format: "text/md" } });
          case "reply":
            return cu("POST", `${base}/messages/${need(a.message_id, "message_id")}/replies`, { body: { type: "message", content: need(a.content, "content"), content_format: "text/md" } });
          case "direct_message":
            return cu("POST", `${base}/channels/direct_message`, { body: { user_ids: (await userIds(a.people, team)).map(String) } });
          case "create_channel":
            if (a.location_type && a.location_id) {
              return cu("POST", `${base}/channels/location`, { body: { location: { id: a.location_id, type: a.location_type }, topic: a.name } });
            }
            return cu("POST", `${base}/channels`, { body: { name: need(a.name, "name") } });
        }
      }),
  );
}
