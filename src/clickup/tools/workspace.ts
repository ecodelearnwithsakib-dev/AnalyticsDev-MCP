import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { cu, currentUser, fieldValue, listFields, members, schema, teamId, toMs, userIds } from "../client.js";

type Named = { id: string; name: string; archived?: boolean };
type List = Named & { task_count?: number; status?: { status?: string } | null };
type Folder = Named & { lists?: List[]; hidden?: boolean };

const need = (v: string | undefined, name: string) => {
  if (!v) throw new Error(`${name} is required`);
  return v;
};

export function registerWorkspaceTools(server: McpServer): void {
  server.registerTool(
    "clickup_api_request",
    {
      title: "ClickUp API request",
      description:
        "Call ANY ClickUp API endpoint (v2 or v3). path like v2/list/123/task or v3/workspaces/{team}/docs; {team} is replaced with your workspace ID. Query keys ending in [] repeat per array value.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string(),
        query: z.record(z.unknown()).optional(),
        body: z.unknown().optional(),
        team_id: schema.team_id,
      },
    },
    ({ method, path, query, body, team_id }) =>
      run(async () => cu(method, path.includes("{team}") ? path.replaceAll("{team}", await teamId(team_id)) : path, { query, body })),
  );

  server.registerTool(
    "clickup_workspace",
    {
      title: "Workspace, hierarchy & people",
      description:
        "Who am I, workspaces, the full hierarchy (spaces → folders → lists with IDs and task counts), members, user groups, custom roles, custom task types, plan and seats, or items shared with you.",
      inputSchema: {
        action: z.enum(["me", "workspaces", "hierarchy", "members", "groups", "roles", "task_types", "plan", "seats", "shared"]).default("hierarchy"),
        include_archived: z.boolean().default(false),
        space_id: z.string().optional().describe("hierarchy: only this space"),
        team_id: schema.team_id,
      },
    },
    (a) =>
      run(async () => {
        if (a.action === "me") return currentUser();
        if (a.action === "workspaces") return ((await cu("GET", "v2/team")) as { teams: { id: string; name: string; members?: unknown[] }[] }).teams.map((t) => ({ id: t.id, name: t.name, members: t.members?.length }));
        const team = await teamId(a.team_id);
        switch (a.action) {
          case "hierarchy": {
            const spaces = a.space_id
              ? [(await cu("GET", `v2/space/${a.space_id}`)) as Named]
              : ((await cu("GET", `v2/team/${team}/space`, { query: { archived: a.include_archived } })) as { spaces: Named[] }).spaces;
            const list = (l: List) => ({ id: l.id, name: l.name, tasks: l.task_count, archived: l.archived || undefined });
            return Promise.all(
              spaces.map(async (s) => {
                const [folders, lists] = await Promise.all([
                  cu("GET", `v2/space/${s.id}/folder`, { query: { archived: a.include_archived } }) as Promise<{ folders: Folder[] }>,
                  cu("GET", `v2/space/${s.id}/list`, { query: { archived: a.include_archived } }) as Promise<{ lists: List[] }>,
                ]);
                return {
                  space: { id: s.id, name: s.name },
                  folders: folders.folders.map((f) => ({ id: f.id, name: f.name, lists: (f.lists ?? []).map(list) })),
                  folderless_lists: lists.lists.map(list),
                };
              }),
            );
          }
          case "members":
            return (await members(team)).map((m) => ({ id: m.id, name: m.username, email: m.email, role: { 1: "owner", 2: "admin", 3: "member", 4: "guest" }[m.role ?? 0] }));
          case "groups":
            return cu("GET", "v2/group", { query: { team_id: team } });
          case "roles":
            return cu("GET", `v2/team/${team}/customroles`, { query: { include_members: true } });
          case "task_types":
            return cu("GET", `v2/team/${team}/custom_item`);
          case "plan":
            return cu("GET", `v2/team/${team}/plan`);
          case "seats":
            return cu("GET", `v2/team/${team}/seats`);
          case "shared":
            return cu("GET", `v2/team/${team}/shared`);
        }
      }),
  );

  server.registerTool(
    "clickup_structure",
    {
      title: "Spaces, folders & lists",
      description:
        "Create, rename/update or delete (confirm) spaces, folders and lists (in a folder or folderless in a space), create lists/folders from templates, and list available templates. New spaces get due dates, time tracking, tags, estimates, checklists and custom fields enabled.",
      inputSchema: {
        action: z.enum(["create", "update", "delete", "templates", "from_template"]),
        kind: z.enum(["space", "folder", "list"]).default("list"),
        id: z.string().optional().describe("update/delete: the space, folder or list ID"),
        name: z.string().optional(),
        space_id: z.string().optional().describe("Parent space for folders and folderless lists"),
        folder_id: z.string().optional().describe("Parent folder for lists"),
        description: z.string().optional().describe("List description (markdown)"),
        due: schema.date,
        owner: z.string().optional().describe("List owner (name/email)"),
        template_id: z.string().optional(),
        archived: z.boolean().optional(),
        team_id: schema.team_id,
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const team = await teamId(a.team_id);
        const path = { space: "space", folder: "folder", list: "list" }[a.kind];
        switch (a.action) {
          case "templates": {
            const endpoint = { list: "list_template", folder: "folder_template", space: "taskTemplate" }[a.kind];
            return cu("GET", `v2/team/${team}/${endpoint}`, { query: a.kind === "space" ? { page: 0 } : undefined });
          }
          case "from_template": {
            const tpl = need(a.template_id, "template_id");
            const body = { name: need(a.name, "name") };
            if (a.kind === "folder") return cu("POST", `v2/space/${need(a.space_id, "space_id")}/folder_template/${tpl}`, { body });
            if (a.folder_id) return cu("POST", `v2/folder/${a.folder_id}/list_template/${tpl}`, { body });
            return cu("POST", `v2/space/${need(a.space_id, "space_id")}/list_template/${tpl}`, { body });
          }
          case "create": {
            const name = need(a.name, "name");
            if (a.kind === "space") {
              const on = { enabled: true };
              return cu("POST", `v2/team/${team}/space`, {
                body: {
                  name,
                  multiple_assignees: true,
                  features: {
                    due_dates: { enabled: true, start_date: true, remap_due_dates: true, remap_closed_due_date: false },
                    time_tracking: on,
                    tags: on,
                    time_estimates: on,
                    checklists: on,
                    custom_fields: on,
                    remap_dependencies: on,
                    dependency_warning: on,
                    portfolios: on,
                  },
                },
              });
            }
            if (a.kind === "folder") return cu("POST", `v2/space/${need(a.space_id, "space_id")}/folder`, { body: { name } });
            const body = {
              name,
              markdown_content: a.description,
              due_date: a.due ? toMs(a.due).ms : undefined,
              assignee: a.owner ? (await userIds([a.owner], team))[0] : undefined,
            };
            return a.folder_id ? cu("POST", `v2/folder/${a.folder_id}/list`, { body }) : cu("POST", `v2/space/${need(a.space_id, "space_id")}/list`, { body });
          }
          case "update": {
            const body: Record<string, unknown> = {};
            if (a.name) body.name = a.name;
            if (a.description !== undefined) body.markdown_content = a.description;
            if (a.due) body.due_date = toMs(a.due).ms;
            if (a.archived !== undefined) body.archived = a.archived;
            if (a.owner) body.assignee = (await userIds([a.owner], team))[0];
            return cu("PUT", `v2/${path}/${need(a.id, "id")}`, { body });
          }
          case "delete":
            if (!a.confirm) throw new Error(`Deleting a ${a.kind} deletes everything inside it; set confirm: true (or archive it with update + archived: true)`);
            return cu("DELETE", `v2/${path}/${need(a.id, "id")}`);
        }
      }),
  );

  server.registerTool(
    "clickup_custom_fields",
    {
      title: "Custom fields",
      description:
        "See custom field definitions (type, dropdown/label options) on a list, folder, space or workspace, and set or clear a field on a task by field name — dropdown and label values by option name, people by name/email, dates like 'tomorrow'.",
      inputSchema: {
        action: z.enum(["list", "set", "clear"]).default("list"),
        level: z.enum(["list", "folder", "space", "workspace"]).default("list"),
        id: z.string().optional().describe("list/folder/space ID for action=list"),
        task_id: z.string().optional(),
        field: z.string().optional().describe("Field name or ID"),
        value: z.unknown().optional(),
        team_id: schema.team_id,
      },
    },
    (a) =>
      run(async () => {
        if (a.action === "list") {
          const path = a.level === "workspace" ? `v2/team/${await teamId(a.team_id)}/field` : `v2/${a.level}/${need(a.id, "id")}/field`;
          const res = (await cu("GET", path)) as { fields: { id: string; name: string; type: string; required?: boolean; type_config?: { options?: { name?: string; label?: string }[] } }[] };
          return res.fields.map((f) => ({ id: f.id, name: f.name, type: f.type, required: f.required || undefined, options: f.type_config?.options?.map((o) => o.name ?? o.label) }));
        }
        const taskId = need(a.task_id, "task_id");
        const task = (await cu("GET", `v2/task/${taskId}`)) as { list: { id: string } };
        const fields = await listFields(task.list.id);
        const f = fields.find((x) => x.id === a.field || x.name.toLowerCase() === String(a.field).toLowerCase());
        if (!f) throw new Error(`No custom field "${a.field}": ${fields.map((x) => x.name).join(", ")}`);
        if (a.action === "clear") return cu("DELETE", `v2/task/${taskId}/field/${f.id}`);
        return cu("POST", `v2/task/${taskId}/field/${f.id}`, { body: { value: await fieldValue(f, a.value, a.team_id) } });
      }),
  );

  server.registerTool(
    "clickup_comments",
    {
      title: "Comments",
      description:
        "Read comments on a task, list or chat view (with thread replies), post a comment or reply (optionally assigning it to someone), edit or resolve a comment, or delete one (confirm).",
      inputSchema: {
        action: z.enum(["list", "add", "reply", "replies", "update", "resolve", "delete"]).default("list"),
        on: z.enum(["task", "list", "view"]).default("task"),
        id: z.string().optional().describe("Task, list or view ID"),
        comment_id: z.string().optional(),
        text: z.string().optional(),
        assign_to: z.string().optional().describe("Assign the comment to this person (name/email)"),
        notify_all: z.boolean().default(false),
        team_id: schema.team_id,
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const assignee = a.assign_to ? (await userIds([a.assign_to], a.team_id))[0] : undefined;
        switch (a.action) {
          case "list": {
            const res = (await cu("GET", `v2/${a.on}/${need(a.id, "id")}/comment`)) as { comments: { id: string; comment_text: string; user?: { username?: string }; date?: string; resolved?: boolean; reply_count?: number }[] };
            return res.comments.map((c) => ({ id: c.id, by: c.user?.username, at: c.date ? new Date(Number(c.date)).toISOString() : undefined, text: c.comment_text, resolved: c.resolved || undefined, replies: c.reply_count || undefined }));
          }
          case "add":
            return cu("POST", `v2/${a.on}/${need(a.id, "id")}/comment`, { body: { comment_text: need(a.text, "text"), assignee, notify_all: a.notify_all } });
          case "reply":
            return cu("POST", `v2/comment/${need(a.comment_id, "comment_id")}/reply`, { body: { comment_text: need(a.text, "text"), assignee, notify_all: a.notify_all } });
          case "replies":
            return cu("GET", `v2/comment/${need(a.comment_id, "comment_id")}/reply`);
          case "update":
          case "resolve":
            return cu("PUT", `v2/comment/${need(a.comment_id, "comment_id")}`, {
              body: { comment_text: a.text, assignee, resolved: a.action === "resolve" ? true : undefined },
            });
          case "delete":
            if (!a.confirm) throw new Error("Deleting a comment is permanent; set confirm: true");
            return cu("DELETE", `v2/comment/${need(a.comment_id, "comment_id")}`);
        }
      }),
  );

  server.registerTool(
    "clickup_checklists",
    {
      title: "Checklists",
      description: "Add a checklist (with items) to a task, rename or delete it (confirm), and add, tick/untick, rename, assign, nest or delete checklist items.",
      inputSchema: {
        action: z.enum(["create", "rename", "delete", "add_items", "update_item", "delete_item"]),
        task_id: z.string().optional(),
        checklist_id: z.string().optional(),
        item_id: z.string().optional(),
        name: z.string().optional(),
        items: z.array(z.string()).optional(),
        resolved: z.boolean().optional(),
        assignee: z.string().optional(),
        parent_item_id: z.string().optional(),
        team_id: schema.team_id,
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const addItems = async (checklistId: string) => {
          for (const name of a.items ?? []) await cu("POST", `v2/checklist/${checklistId}/checklist_item`, { body: { name } });
        };
        switch (a.action) {
          case "create": {
            const res = (await cu("POST", `v2/task/${need(a.task_id, "task_id")}/checklist`, { body: { name: need(a.name, "name") } })) as { checklist: { id: string } };
            await addItems(res.checklist.id);
            return { checklist_id: res.checklist.id, items_added: a.items?.length ?? 0 };
          }
          case "rename":
            return cu("PUT", `v2/checklist/${need(a.checklist_id, "checklist_id")}`, { body: { name: need(a.name, "name") } });
          case "delete":
            if (!a.confirm) throw new Error("Deleting a checklist removes all its items; set confirm: true");
            return cu("DELETE", `v2/checklist/${need(a.checklist_id, "checklist_id")}`);
          case "add_items":
            await addItems(need(a.checklist_id, "checklist_id"));
            return { items_added: a.items?.length ?? 0 };
          case "update_item":
            return cu("PUT", `v2/checklist/${need(a.checklist_id, "checklist_id")}/checklist_item/${need(a.item_id, "item_id")}`, {
              body: {
                name: a.name,
                resolved: a.resolved,
                assignee: a.assignee ? String((await userIds([a.assignee], a.team_id))[0]) : undefined,
                parent: a.parent_item_id,
              },
            });
          case "delete_item":
            return cu("DELETE", `v2/checklist/${need(a.checklist_id, "checklist_id")}/checklist_item/${need(a.item_id, "item_id")}`);
        }
      }),
  );

  server.registerTool(
    "clickup_relations",
    {
      title: "Dependencies, links & tags",
      description:
        "Task relationships and tags: add/remove 'waiting on' or 'blocking' dependencies and plain links between tasks, add/remove tags on a task, and manage a space's tags (list, create with colors, rename, delete with confirm).",
      inputSchema: {
        action: z.enum(["add_dependency", "remove_dependency", "add_link", "remove_link", "tag_task", "untag_task", "space_tags", "create_tag", "edit_tag", "delete_tag"]),
        task_id: z.string().optional(),
        other_task_id: z.string().optional(),
        direction: z.enum(["waiting_on", "blocking"]).default("waiting_on").describe("task_id is waiting on / blocking other_task_id"),
        tags: z.array(z.string()).optional(),
        space_id: z.string().optional(),
        tag: z.string().optional(),
        new_name: z.string().optional(),
        color: z.string().optional().describe("Tag background color, e.g. #ff5733"),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const task = () => need(a.task_id, "task_id");
        const other = () => need(a.other_task_id, "other_task_id");
        switch (a.action) {
          case "add_dependency":
            return cu("POST", `v2/task/${task()}/dependency`, { body: a.direction === "waiting_on" ? { depends_on: other() } : { dependency_of: other() } });
          case "remove_dependency":
            return cu("DELETE", `v2/task/${task()}/dependency`, { query: a.direction === "waiting_on" ? { depends_on: other() } : { dependency_of: other() } });
          case "add_link":
            return cu("POST", `v2/task/${task()}/link/${other()}`);
          case "remove_link":
            return cu("DELETE", `v2/task/${task()}/link/${other()}`);
          case "tag_task":
          case "untag_task":
            for (const t of a.tags ?? []) await cu(a.action === "tag_task" ? "POST" : "DELETE", `v2/task/${task()}/tag/${encodeURIComponent(t)}`);
            return { task: task(), [a.action === "tag_task" ? "added" : "removed"]: a.tags ?? [] };
          case "space_tags":
            return cu("GET", `v2/space/${need(a.space_id, "space_id")}/tag`);
          case "create_tag":
            return cu("POST", `v2/space/${need(a.space_id, "space_id")}/tag`, { body: { tag: { name: need(a.tag, "tag"), tag_bg: a.color ?? "#7B68EE", tag_fg: "#FFFFFF" } } });
          case "edit_tag":
            return cu("PUT", `v2/space/${need(a.space_id, "space_id")}/tag/${encodeURIComponent(need(a.tag, "tag"))}`, {
              body: { tag: { name: a.new_name ?? a.tag, bg_color: a.color ?? "#7B68EE", fg_color: "#FFFFFF" } },
            });
          case "delete_tag":
            if (!a.confirm) throw new Error("Deleting a tag removes it from every task in the space; set confirm: true");
            return cu("DELETE", `v2/space/${need(a.space_id, "space_id")}/tag/${encodeURIComponent(need(a.tag, "tag"))}`);
        }
      }),
  );

  server.registerTool(
    "clickup_people",
    {
      title: "Invite & manage people",
      description:
        "Invite members or guests to the workspace, change a member's name/admin role, remove someone (confirm), share a task/list/folder with a guest (or revoke it), and create, update or delete user groups (teams).",
      inputSchema: {
        action: z.enum(["invite_member", "invite_guest", "edit_member", "remove_member", "remove_guest", "guest_access", "revoke_guest_access", "create_group", "update_group", "delete_group"]),
        email: z.string().email().optional(),
        user: z.string().optional().describe("Existing user (name/email/ID)"),
        admin: z.boolean().optional().describe("invite/edit: workspace admin (edit keeps the current role if omitted)"),
        username: z.string().optional(),
        custom_role_id: z.number().int().optional(),
        on: z.enum(["task", "list", "folder"]).optional().describe("guest_access target"),
        target_id: z.string().optional(),
        permission: z.enum(["read", "comment", "edit", "create"]).default("read"),
        group_id: z.string().optional(),
        name: z.string().optional(),
        add_members: schema.people,
        remove_members: schema.people,
        team_id: schema.team_id,
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const team = await teamId(a.team_id);
        const user = async () => (await userIds([need(a.user, "user")], team))[0];
        switch (a.action) {
          case "invite_member":
            return cu("POST", `v2/team/${team}/user`, { body: { email: need(a.email, "email"), admin: a.admin ?? false, custom_role_id: a.custom_role_id } });
          case "invite_guest":
            return cu("POST", `v2/team/${team}/guest`, { body: { email: need(a.email, "email"), can_edit_tags: false, can_see_time_spent: false, can_see_time_estimated: true, can_create_views: false, custom_role_id: a.custom_role_id } });
          case "edit_member": {
            // The endpoint wants username, admin and custom_role_id together, so fill the unchanged ones from the current record.
            const id = await user();
            const current = (await cu("GET", `v2/team/${team}/user/${id}`)) as { member?: { user?: { username?: string; role?: number; custom_role?: { id?: number } | null } } };
            const u = current.member?.user ?? {};
            return cu("PUT", `v2/team/${team}/user/${id}`, {
              body: { username: a.username ?? u.username, admin: a.admin ?? u.role === 2, custom_role_id: a.custom_role_id ?? u.custom_role?.id ?? null },
            });
          }
          case "remove_member":
          case "remove_guest":
            if (!a.confirm) throw new Error("Removing someone from the workspace is permanent; set confirm: true");
            return cu("DELETE", `v2/team/${team}/${a.action === "remove_member" ? "user" : "guest"}/${await user()}`);
          case "guest_access":
          case "revoke_guest_access": {
            const target = `v2/${need(a.on, "on")}/${need(a.target_id, "target_id")}/guest/${await user()}`;
            return a.action === "guest_access" ? cu("POST", target, { body: { permission_level: a.permission } }) : cu("DELETE", target);
          }
          case "create_group":
            return cu("POST", `v2/team/${team}/group`, { body: { name: need(a.name, "name"), members: await userIds(a.add_members, team) } });
          case "update_group":
            return cu("PUT", `v2/group/${need(a.group_id, "group_id")}`, {
              body: { name: a.name, members: { add: await userIds(a.add_members, team), rem: await userIds(a.remove_members, team) } },
            });
          case "delete_group":
            if (!a.confirm) throw new Error("Deleting a group is permanent; set confirm: true");
            return cu("DELETE", `v2/group/${need(a.group_id, "group_id")}`);
        }
      }),
  );
}
