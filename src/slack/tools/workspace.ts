import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { channels, conversationId, iso, nameOf, paginate, schema, slack, toTs, userId, users, whoami, type Channel } from "../client.js";

const need = <T>(v: T | undefined, name: string): T => {
  if (v === undefined || v === null || v === "") throw new Error(`${name} is required`);
  return v;
};

export function registerWorkspaceTools(server: McpServer): void {
  server.registerTool(
    "slack_api",
    {
      title: "Slack API call",
      description: "Call ANY Slack Web API method (e.g. conversations.info, admin.*, workflows.*, lists.*, stars.list, team.accessLogs). Params are sent form-encoded; objects/arrays as JSON.",
      inputSchema: { method: z.string(), params: z.record(z.unknown()).optional(), as_bot: schema.as_bot },
    },
    ({ method, params, as_bot }) => run(() => slack(method, params, { asBot: as_bot })),
  );

  server.registerTool(
    "slack_channels",
    {
      title: "Channels",
      description:
        "Channels: list (public/private, with member counts, topic and purpose), info, members, create (public or private), join/leave, invite or remove people, set topic/purpose, rename, and archive/unarchive (confirm).",
      inputSchema: {
        action: z.enum(["list", "info", "members", "create", "join", "leave", "invite", "kick", "topic", "purpose", "rename", "archive", "unarchive"]).default("list"),
        channel: schema.channel.optional(),
        name: z.string().optional().describe("create/rename: channel name (lowercase, no spaces)"),
        private: z.boolean().default(false),
        people: z.array(z.string()).optional().describe("invite/kick: @names, emails or user IDs"),
        text: z.string().optional().describe("topic/purpose text"),
        filter: z.string().optional().describe("list: only names containing this"),
        include_archived: z.boolean().default(false),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        if (a.action === "list") {
          const all = (await channels(true)).filter((c) => (a.include_archived || !c.is_archived) && (!a.filter || c.name?.includes(a.filter.toLowerCase())));
          return all.map((c) => ({ id: c.id, name: `#${c.name}`, private: c.is_private || undefined, archived: c.is_archived || undefined, members: c.num_members, topic: c.topic?.value || undefined, purpose: c.purpose?.value || undefined }));
        }
        if (a.action === "create") {
          const res = await slack("conversations.create", { name: need(a.name, "name").toLowerCase().replace(/[^a-z0-9_-]+/g, "-"), is_private: a.private });
          const ch = res.channel as Channel;
          if (a.people?.length) await slack("conversations.invite", { channel: ch.id, users: (await Promise.all(a.people.map(userId))).join(",") });
          if (a.text) await slack("conversations.setPurpose", { channel: ch.id, purpose: a.text });
          await channels(true);
          return { id: ch.id, name: `#${ch.name}`, private: ch.is_private };
        }
        const channel = await conversationId(need(a.channel, "channel"));
        switch (a.action) {
          case "info":
            return (await slack("conversations.info", { channel, include_num_members: true })).channel;
          case "members": {
            const ids = await paginate<string>("conversations.members", "members", { channel }, 5000);
            return Promise.all(ids.map(async (id) => ({ id, name: await nameOf(id) })));
          }
          case "join":
            return slack("conversations.join", { channel });
          case "leave":
            return slack("conversations.leave", { channel });
          case "invite":
            return slack("conversations.invite", { channel, users: (await Promise.all(need(a.people, "people").map(userId))).join(",") });
          case "kick":
            if (!a.confirm) throw new Error("Removing people from a channel needs confirm: true");
            for (const p of need(a.people, "people")) await slack("conversations.kick", { channel, user: await userId(p) });
            return { removed: a.people };
          case "topic":
            return slack("conversations.setTopic", { channel, topic: need(a.text, "text") });
          case "purpose":
            return slack("conversations.setPurpose", { channel, purpose: need(a.text, "text") });
          case "rename":
            return slack("conversations.rename", { channel, name: need(a.name, "name") });
          case "archive":
            if (!a.confirm) throw new Error("Archiving hides the channel for everyone; set confirm: true");
            return slack("conversations.archive", { channel });
          case "unarchive":
            return slack("conversations.unarchive", { channel });
        }
      }),
  );

  server.registerTool(
    "slack_people",
    {
      title: "People, status & presence",
      description:
        "Find people (name, handle, email, title, timezone), get someone's profile and presence, list everyone, see who you are; set your own status (emoji, text, expiry), presence (auto/away) or pause notifications (Do Not Disturb) for N minutes.",
      inputSchema: {
        action: z.enum(["find", "info", "list", "me", "set_status", "clear_status", "set_presence", "snooze", "end_snooze"]).default("find"),
        who: z.string().optional().describe("Name, @handle, email or user ID"),
        status_text: z.string().optional(),
        status_emoji: z.string().optional().describe("e.g. :palm_tree:"),
        until: schema.when.describe("Status expiry, e.g. +2h or tomorrow"),
        presence: z.enum(["auto", "away"]).optional(),
        minutes: z.number().int().positive().optional(),
        include_bots: z.boolean().default(false),
      },
    },
    (a) =>
      run(async () => {
        const card = (u: Awaited<ReturnType<typeof users>>[number]) => ({
          id: u.id,
          handle: `@${u.name}`,
          name: u.profile?.real_name ?? u.real_name,
          display: u.profile?.display_name || undefined,
          email: u.profile?.email,
          title: u.profile?.title || undefined,
          tz: u.tz,
          bot: u.is_bot || undefined,
          deactivated: u.deleted || undefined,
        });
        switch (a.action) {
          case "list":
            return (await users()).filter((u) => !u.deleted && (a.include_bots || !u.is_bot)).map(card);
          case "find": {
            const q = need(a.who, "who").toLowerCase().replace(/^@/, "");
            return (await users()).filter((u) => [u.name, u.real_name, u.profile?.display_name, u.profile?.email, u.profile?.title].some((f) => f?.toLowerCase().includes(q))).map(card);
          }
          case "info": {
            const id = await userId(need(a.who, "who"));
            const [info, presence] = await Promise.all([slack("users.info", { user: id }), slack("users.getPresence", { user: id }).catch(() => ({ presence: undefined }))]);
            return { ...(info.user as object), presence: (presence as { presence?: string }).presence };
          }
          case "me":
            return whoami();
          case "set_status":
            return slack("users.profile.set", {
              profile: { status_text: a.status_text ?? "", status_emoji: a.status_emoji ?? "", status_expiration: a.until ? Number(toTs(a.until)) : 0 },
            });
          case "clear_status":
            return slack("users.profile.set", { profile: { status_text: "", status_emoji: "", status_expiration: 0 } });
          case "set_presence":
            return slack("users.setPresence", { presence: need(a.presence, "presence") });
          case "snooze":
            return slack("dnd.setSnooze", { num_minutes: need(a.minutes, "minutes") });
          case "end_snooze":
            return slack("dnd.endSnooze");
        }
      }),
  );

  server.registerTool(
    "slack_files",
    {
      title: "Files",
      description: "Upload a local file to a channel, DM or thread (with a comment), list recent files (by channel, person or type), get a file's details, or delete one (confirm).",
      inputSchema: {
        action: z.enum(["upload", "list", "info", "delete"]).default("list"),
        file_path: z.string().optional(),
        to: schema.channel.optional(),
        thread_ts: z.string().optional(),
        comment: z.string().optional(),
        title: z.string().optional(),
        file_id: z.string().optional(),
        who: z.string().optional().describe("list: files by this person"),
        types: z.string().optional().describe("list: e.g. images, pdfs, spaces, snippets, zips"),
        limit: z.number().int().min(1).max(200).default(50),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        switch (a.action) {
          case "upload": {
            const path = need(a.file_path, "file_path");
            const filename = basename(path);
            const length = statSync(path).size;
            const target = await slack("files.getUploadURLExternal", { filename, length });
            const upload = await fetch(String(target.upload_url), { method: "POST", body: readFileSync(path) });
            if (!upload.ok) throw new Error(`Upload failed: HTTP ${upload.status}`);
            const done = await slack("files.completeUploadExternal", {
              files: [{ id: target.file_id, title: a.title ?? filename }],
              channel_id: a.to ? await conversationId(a.to) : undefined,
              initial_comment: a.comment,
              thread_ts: a.thread_ts,
            });
            return { uploaded: filename, bytes: length, files: done.files };
          }
          case "list": {
            const res = await slack("files.list", {
              channel: a.to ? await conversationId(a.to) : undefined,
              user: a.who ? await userId(a.who) : undefined,
              types: a.types,
              count: a.limit,
            });
            return Promise.all(
              ((res.files as Record<string, unknown>[]) ?? []).map(async (f) => ({ id: f.id, name: f.name, title: f.title, type: f.filetype, size: f.size, by: await nameOf(f.user as string), at: iso(String(f.created)), permalink: f.permalink })),
            );
          }
          case "info":
            return (await slack("files.info", { file: need(a.file_id, "file_id") })).file;
          case "delete":
            if (!a.confirm) throw new Error("Deleting a file is permanent; set confirm: true");
            return slack("files.delete", { file: need(a.file_id, "file_id") });
        }
      }),
  );

  server.registerTool(
    "slack_canvases",
    {
      title: "Canvases",
      description: "Create a canvas from markdown (standalone or as a channel's canvas), append/prepend/replace its content, look up sections, share it with people or channels, or delete it (confirm).",
      inputSchema: {
        action: z.enum(["create", "channel_canvas", "append", "prepend", "replace", "sections", "share", "delete"]),
        canvas_id: z.string().optional(),
        title: z.string().optional(),
        markdown: z.string().optional(),
        channel: schema.channel.optional(),
        people: z.array(z.string()).optional(),
        access: z.enum(["read", "write"]).default("read"),
        section_contains: z.string().optional().describe("sections: find sections containing this text"),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const doc = () => ({ type: "markdown", markdown: need(a.markdown, "markdown") });
        switch (a.action) {
          case "create":
            return slack("canvases.create", { title: a.title, document_content: a.markdown ? doc() : undefined });
          case "channel_canvas":
            return slack("conversations.canvases.create", { channel_id: await conversationId(need(a.channel, "channel")), document_content: a.markdown ? doc() : undefined });
          case "append":
          case "prepend":
          case "replace":
            return slack("canvases.edit", {
              canvas_id: need(a.canvas_id, "canvas_id"),
              changes: [{ operation: { append: "insert_at_end", prepend: "insert_at_start", replace: "replace" }[a.action], document_content: doc() }],
            });
          case "sections":
            return slack("canvases.sections.lookup", { canvas_id: need(a.canvas_id, "canvas_id"), criteria: { contains_text: a.section_contains ?? "" } });
          case "share":
            return slack("canvases.access.set", {
              canvas_id: need(a.canvas_id, "canvas_id"),
              access_level: a.access,
              channel_ids: a.channel ? [await conversationId(a.channel)] : undefined,
              user_ids: a.people?.length ? await Promise.all(a.people.map(userId)) : undefined,
            });
          case "delete":
            if (!a.confirm) throw new Error("Deleting a canvas is permanent; set confirm: true");
            return slack("canvases.delete", { canvas_id: need(a.canvas_id, "canvas_id") });
        }
      }),
  );

  server.registerTool(
    "slack_workspace",
    {
      title: "Reminders, bookmarks, user groups, emoji",
      description:
        "Workspace extras: reminders (add with natural time like \"in 2 hours\" or \"every Monday at 9am\", list, complete, delete), channel bookmarks (list/add link/remove), user groups (list, create, update members, disable/enable), custom emoji list, and workspace info.",
      inputSchema: {
        area: z.enum(["reminders", "bookmarks", "usergroups", "emoji", "team"]),
        action: z.enum(["list", "add", "complete", "delete", "update_members", "disable", "enable"]).default("list"),
        text: z.string().optional().describe("reminders: what to remind"),
        time: z.string().optional().describe("reminders: \"in 20 minutes\", \"tomorrow at 9am\", \"every weekday at 10am\" or Unix ts"),
        for_whom: z.string().optional().describe("reminders: someone else (name/email)"),
        reminder_id: z.string().optional(),
        channel: schema.channel.optional(),
        title: z.string().optional(),
        link: z.string().url().optional(),
        bookmark_id: z.string().optional(),
        usergroup_id: z.string().optional(),
        name: z.string().optional(),
        handle: z.string().optional(),
        description: z.string().optional(),
        people: z.array(z.string()).optional(),
      },
    },
    (a) =>
      run(async () => {
        switch (a.area) {
          case "reminders":
            if (a.action === "list") return (await slack("reminders.list")).reminders;
            if (a.action === "add") return slack("reminders.add", { text: need(a.text, "text"), time: need(a.time, "time"), user: a.for_whom ? await userId(a.for_whom) : undefined });
            if (a.action === "complete") return slack("reminders.complete", { reminder: need(a.reminder_id, "reminder_id") });
            if (a.action === "delete") return slack("reminders.delete", { reminder: need(a.reminder_id, "reminder_id") });
            break;
          case "bookmarks": {
            const channel_id = await conversationId(need(a.channel, "channel"));
            if (a.action === "list") return (await slack("bookmarks.list", { channel_id })).bookmarks;
            if (a.action === "add") return slack("bookmarks.add", { channel_id, title: need(a.title, "title"), type: "link", link: need(a.link, "link") });
            if (a.action === "delete") return slack("bookmarks.remove", { channel_id, bookmark_id: need(a.bookmark_id, "bookmark_id") });
            break;
          }
          case "usergroups": {
            if (a.action === "list") return (await slack("usergroups.list", { include_users: true, include_count: true, include_disabled: true })).usergroups;
            const members = a.people?.length ? (await Promise.all(a.people.map(userId))).join(",") : undefined;
            if (a.action === "add") {
              const res = await slack("usergroups.create", { name: need(a.name, "name"), handle: a.handle, description: a.description });
              const id = (res.usergroup as { id: string }).id;
              if (members) await slack("usergroups.users.update", { usergroup: id, users: members });
              return res.usergroup;
            }
            if (a.action === "update_members") return slack("usergroups.users.update", { usergroup: need(a.usergroup_id, "usergroup_id"), users: need(members, "people") });
            if (a.action === "disable") return slack("usergroups.disable", { usergroup: need(a.usergroup_id, "usergroup_id") });
            if (a.action === "enable") return slack("usergroups.enable", { usergroup: need(a.usergroup_id, "usergroup_id") });
            break;
          }
          case "emoji":
            return Object.keys(((await slack("emoji.list")).emoji as Record<string, string>) ?? {}).sort();
          case "team":
            return { ...(await slack("team.info")).team as object, you: await whoami() };
        }
        throw new Error(`${a.action} isn't supported for ${a.area}`);
      }),
  );
}
