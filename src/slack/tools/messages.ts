import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { channels, compactMessage, conversationId, iso, nameOf, paginate, readable, schema, slack, toTs, whoami } from "../client.js";

type Message = Parameters<typeof compactMessage>[0];

export function registerMessageTools(server: McpServer): void {
  server.registerTool(
    "slack_send",
    {
      title: "Send a message",
      description:
        "Post to a channel (#name), a person (DM by @name, email or \"me\"), or reply in a thread; optionally schedule it for later, broadcast a thread reply to the channel, or send Block Kit blocks. Text uses Slack mrkdwn (*bold*, _italic_, <url|label>, <@U123>). Posts as you unless as_bot is true.",
      inputSchema: {
        to: schema.channel,
        text: z.string().describe("Message text (also the notification fallback when blocks are used)"),
        thread_ts: z.string().optional().describe("Reply in this thread (the parent message ts)"),
        broadcast: z.boolean().default(false).describe("Also show a thread reply in the channel"),
        schedule_at: schema.when.describe("Send later: ISO datetime, tomorrow, or +30m / +2h"),
        blocks: z.array(z.record(z.unknown())).optional(),
        unfurl_links: z.boolean().default(true),
        as_bot: schema.as_bot,
      },
    },
    (a) =>
      run(async () => {
        const channel = await conversationId(a.to);
        const common = { channel, text: a.text, blocks: a.blocks, thread_ts: a.thread_ts, reply_broadcast: a.thread_ts ? a.broadcast : undefined, unfurl_links: a.unfurl_links };
        if (a.schedule_at) {
          const res = await slack("chat.scheduleMessage", { ...common, post_at: toTs(a.schedule_at) }, { asBot: a.as_bot });
          return { scheduled: true, channel, scheduled_message_id: res.scheduled_message_id, post_at: iso(String(res.post_at)) };
        }
        const res = await slack("chat.postMessage", common, { asBot: a.as_bot });
        const permalink = await slack("chat.getPermalink", { channel, message_ts: res.ts }).then((p) => p.permalink).catch(() => undefined);
        return { sent: true, channel, ts: res.ts, permalink };
      }),
  );

  server.registerTool(
    "slack_read",
    {
      title: "Read channel / thread / DM",
      description:
        "Read messages from a channel, DM or group DM over a time window (e.g. since yesterday), optionally with every thread's replies, or read one thread. Names are resolved and mentions made readable.",
      inputSchema: {
        channel: schema.channel,
        thread_ts: z.string().optional().describe("Read this thread instead of the channel"),
        since: schema.when.describe("Oldest message time (default: last 24h)"),
        until: schema.when,
        include_threads: z.boolean().default(false).describe("Also fetch replies of threaded messages"),
        limit: z.number().int().min(1).max(2000).default(200),
      },
    },
    (a) =>
      run(async () => {
        const channel = await conversationId(a.channel);
        if (a.thread_ts) {
          const replies = await paginate<Message>("conversations.replies", "messages", { channel, ts: a.thread_ts }, a.limit);
          return { channel, thread_ts: a.thread_ts, messages: await Promise.all(replies.map(compactMessage)) };
        }
        const history = await paginate<Message>("conversations.history", "messages", { channel, oldest: toTs(a.since ?? "-1d"), latest: a.until ? toTs(a.until) : undefined, inclusive: true }, a.limit);
        const messages = await Promise.all(history.reverse().map(compactMessage));
        if (a.include_threads) {
          for (const m of messages.filter((x) => x.replies)) {
            const replies = await paginate<Message>("conversations.replies", "messages", { channel, ts: m.ts }, 200);
            Object.assign(m, { thread: await Promise.all(replies.slice(1).map(compactMessage)) });
          }
        }
        return { channel, count: messages.length, messages };
      }),
  );

  server.registerTool(
    "slack_search",
    {
      title: "Search messages & files",
      description:
        "Search Slack like the search bar (needs the user token): supports modifiers such as in:#channel, from:@person, to:me, has:link, has:reaction, is:thread, before:2026-10-01, after:2026-09-01, during:september, \"exact phrase\", -exclude. Returns messages with channel, author, time and permalink — or files.",
      inputSchema: {
        query: z.string(),
        kind: z.enum(["messages", "files"]).default("messages"),
        sort: z.enum(["timestamp", "score"]).default("timestamp"),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    (a) =>
      run(async () => {
        const out: Record<string, unknown>[] = [];
        for (let page = 1; out.length < a.limit; page++) {
          const res = await slack(a.kind === "messages" ? "search.messages" : "search.files", { query: a.query, sort: a.sort, sort_dir: "desc", count: Math.min(100, a.limit), page });
          const block = res[a.kind] as { matches?: Record<string, unknown>[]; paging?: { pages?: number }; total?: number };
          for (const m of block.matches ?? []) {
            if (a.kind === "files") out.push({ id: m.id, name: m.name, title: m.title, type: m.filetype, by: await nameOf(m.user as string), at: iso(String(m.timestamp)), permalink: m.permalink });
            else
              out.push({
                channel: (m.channel as { name?: string })?.name,
                from: (await nameOf(m.user as string)) ?? m.username,
                at: iso(m.ts as string),
                text: await readable(m.text as string),
                ts: m.ts,
                permalink: m.permalink,
              });
          }
          if (!block.paging?.pages || page >= block.paging.pages) break;
        }
        return { query: a.query, count: out.length, results: out.slice(0, a.limit) };
      }),
  );

  server.registerTool(
    "slack_message",
    {
      title: "Edit / react / pin / delete",
      description:
        "Act on an existing message: edit its text, delete it (confirm), add or remove an emoji reaction, pin or unpin, get its permalink, mark the channel read up to it; list or cancel scheduled messages.",
      inputSchema: {
        action: z.enum(["edit", "delete", "react", "unreact", "pin", "unpin", "permalink", "mark_read", "scheduled", "cancel_scheduled"]),
        channel: schema.channel.optional(),
        ts: z.string().optional().describe("Message ts (from slack_read / slack_search)"),
        text: z.string().optional(),
        emoji: z.string().optional().describe("Reaction name without colons, e.g. white_check_mark"),
        scheduled_message_id: z.string().optional(),
        as_bot: schema.as_bot,
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const channel = a.channel ? await conversationId(a.channel) : undefined;
        const need = () => {
          if (!channel || !a.ts) throw new Error("channel and ts are required");
          return { channel, ts: a.ts };
        };
        switch (a.action) {
          case "edit":
            if (!a.text) throw new Error("text is required");
            return slack("chat.update", { ...need(), text: a.text }, { asBot: a.as_bot });
          case "delete":
            if (!a.confirm) throw new Error("Deleting a message is permanent; set confirm: true");
            return slack("chat.delete", need(), { asBot: a.as_bot });
          case "react":
          case "unreact": {
            const { channel: c, ts } = need();
            return slack(a.action === "react" ? "reactions.add" : "reactions.remove", { channel: c, timestamp: ts, name: (a.emoji ?? "white_check_mark").replace(/:/g, "") });
          }
          case "pin":
          case "unpin": {
            const { channel: c, ts } = need();
            return slack(a.action === "pin" ? "pins.add" : "pins.remove", { channel: c, timestamp: ts });
          }
          case "permalink": {
            const { channel: c, ts } = need();
            return slack("chat.getPermalink", { channel: c, message_ts: ts });
          }
          case "mark_read":
            return slack("conversations.mark", need());
          case "scheduled": {
            const res = await slack("chat.scheduledMessages.list", { channel });
            return res.scheduled_messages;
          }
          case "cancel_scheduled":
            if (!channel || !a.scheduled_message_id) throw new Error("channel and scheduled_message_id are required");
            return slack("chat.deleteScheduledMessage", { channel, scheduled_message_id: a.scheduled_message_id }, { asBot: a.as_bot });
        }
      }),
  );

  server.registerTool(
    "slack_digest",
    {
      title: "Catch-up digest",
      description:
        "Catch up fast: for a time window, messages that mention you, activity per channel you're in (message counts, top posters, busiest threads), and questions nobody has replied to yet.",
      inputSchema: {
        since: schema.when.describe("Default: last 24h"),
        channels: z.array(z.string()).optional().describe("Limit to these channels (default: the ones you're a member of, up to 30)"),
        max_channels: z.number().int().min(1).max(100).default(30),
      },
    },
    (a) =>
      run(async () => {
        const oldest = toTs(a.since ?? "-1d");
        const me = await whoami();
        const afterDate = new Date(Number(oldest) * 1000 - 86_400_000).toISOString().slice(0, 10);
        const mentions = await slack("search.messages", { query: `<@${me.user_id}> after:${afterDate}`, sort: "timestamp", count: 50 })
          .then(async (r) =>
            Promise.all(
              ((r.messages as { matches?: Record<string, unknown>[] }).matches ?? [])
                .filter((m) => Number(m.ts) >= Number(oldest))
                .map(async (m) => ({ channel: (m.channel as { name?: string })?.name, from: await nameOf(m.user as string), at: iso(m.ts as string), text: await readable(m.text as string), permalink: m.permalink })),
            ),
          )
          .catch((e: Error) => `unavailable: ${e.message}`);
        const scope = a.channels?.length
          ? await Promise.all(a.channels.map(async (c) => ({ id: await conversationId(c), name: c.replace(/^#/, "") })))
          : (await paginate<{ id: string; name?: string; is_archived?: boolean }>("users.conversations", "channels", { types: "public_channel,private_channel", exclude_archived: true }, 500))
              .slice(0, a.max_channels)
              .map((c) => ({ id: c.id, name: c.name ?? c.id }));
        const perChannel = [];
        const unanswered = [];
        for (const c of scope) {
          const msgs = await paginate<Message>("conversations.history", "messages", { channel: c.id, oldest }, 500).catch(() => [] as Message[]);
          const human = msgs.filter((m) => !m.subtype);
          if (!human.length) continue;
          const posters: Record<string, number> = {};
          for (const m of human) {
            const n = (await nameOf(m.user)) ?? "bot";
            posters[n] = (posters[n] ?? 0) + 1;
          }
          const busiest = human.filter((m) => m.reply_count).sort((x, y) => (y.reply_count ?? 0) - (x.reply_count ?? 0)).slice(0, 3);
          perChannel.push({
            channel: `#${c.name}`,
            messages: human.length,
            top_posters: Object.entries(posters).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([n, k]) => `${n} (${k})`),
            busiest_threads: await Promise.all(busiest.map(async (m) => ({ replies: m.reply_count, from: await nameOf(m.user), text: (await readable(m.text))?.slice(0, 160), ts: m.ts }))),
          });
          for (const m of human.filter((x) => x.text?.includes("?") && !x.reply_count && x.user !== me.user_id).slice(0, 5)) {
            unanswered.push({ channel: `#${c.name}`, from: await nameOf(m.user), at: iso(m.ts), text: (await readable(m.text))?.slice(0, 200), ts: m.ts });
          }
        }
        return {
          since: iso(oldest),
          you: me.user,
          mentions,
          channels: perChannel.sort((x, y) => y.messages - x.messages),
          unanswered_questions: unanswered,
          channels_scanned: scope.length,
          note: scope.length >= a.max_channels ? `Scanned your first ${a.max_channels} channels; pass channels or max_channels for more.` : undefined,
          all_channels_known: (await channels()).length,
        };
      }),
  );
}
