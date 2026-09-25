import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { confirm, fullname, reddit, subredditName, type Rec } from "../client.js";

type Thing = { kind: string; data: Rec };
type Listing = { data: { children: Thing[]; after?: string | null } };

const iso = (utc: unknown) => (utc ? new Date(Number(utc) * 1000).toISOString() : undefined);
const post = (p: Rec) => ({
  id: p.name,
  subreddit: p.subreddit_name_prefixed,
  title: p.title,
  author: p.author,
  score: p.score,
  upvote_ratio: p.upvote_ratio,
  comments: p.num_comments,
  created: iso(p.created_utc),
  flair: p.link_flair_text ?? undefined,
  url: p.is_self ? undefined : p.url,
  permalink: `https://www.reddit.com${p.permalink}`,
  text: p.selftext ? String(p.selftext).slice(0, 500) : undefined,
});
const comment = (c: Rec, depth = 0) => ({ id: c.name, author: c.author, score: c.score, depth, created: iso(c.created_utc), text: String(c.body ?? "").slice(0, 1000) });

/** Pages a listing endpoint up to `limit` items. */
async function listing(path: string, query: Record<string, string | number | undefined>, limit: number): Promise<Thing[]> {
  const out: Thing[] = [];
  let after: string | undefined;
  while (out.length < limit) {
    const res = await reddit<Listing>(path, { query: { ...query, limit: Math.min(100, limit - out.length), after } });
    out.push(...(res.data?.children ?? []));
    after = res.data?.after ?? undefined;
    if (!after) break;
  }
  return out;
}

function submitResult(res: Rec) {
  const json = res.json as { errors?: [string, string, string][]; data?: Rec } | undefined;
  if (json?.errors?.length) throw new Error(`Reddit refused: ${json.errors.map((e) => e.slice(0, 2).join(" ")).join("; ")}`);
  return json?.data ?? res;
}

export function registerCommunityTools(server: McpServer): void {
  server.registerTool(
    "reddit_search",
    {
      title: "Search & brand listening",
      description:
        "Search Reddit posts (all of Reddit or one subreddit) by keyword with sort (relevance, new, top, comments) and time window, or find subreddits. mention_summary adds a quick listening digest: mentions per subreddit, top posts by engagement, and posts from the last 24h.",
      inputSchema: {
        query: z.string().describe("Supports Reddit syntax: \"exact phrase\", OR, -exclude, title:, site:, author:, flair:"),
        subreddit: z.string().optional(),
        kind: z.enum(["posts", "subreddits"]).default("posts"),
        sort: z.enum(["relevance", "new", "top", "comments", "hot"]).default("relevance"),
        time: z.enum(["hour", "day", "week", "month", "year", "all"]).default("month"),
        limit: z.number().int().min(1).max(500).default(50),
        mention_summary: z.boolean().default(false),
      },
    },
    (a) =>
      run(async () => {
        if (a.kind === "subreddits") {
          const res = await listing("/subreddits/search", { q: a.query }, a.limit);
          return res.map(({ data: s }) => ({ name: s.display_name_prefixed, subscribers: s.subscribers, active: s.active_user_count ?? undefined, nsfw: s.over18 || undefined, description: String(s.public_description ?? "").slice(0, 200) }));
        }
        const path = a.subreddit ? `/r/${subredditName(a.subreddit)}/search` : "/search";
        const items = (await listing(path, { q: a.query, sort: a.sort, t: a.time, restrict_sr: a.subreddit ? 1 : undefined, type: "link" }, a.limit)).map(({ data }) => post(data));
        if (!a.mention_summary) return { count: items.length, posts: items };
        const bySub: Record<string, number> = {};
        for (const p of items) bySub[String(p.subreddit)] = (bySub[String(p.subreddit)] ?? 0) + 1;
        const day = Date.now() - 86_400_000;
        return {
          query: a.query,
          window: a.time,
          mentions: items.length,
          by_subreddit: Object.fromEntries(Object.entries(bySub).sort((x, y) => y[1] - x[1])),
          top_by_engagement: [...items].sort((x, y) => (Number(y.score) + 2 * Number(y.comments)) - (Number(x.score) + 2 * Number(x.comments))).slice(0, 10),
          last_24h: items.filter((p) => p.created && Date.parse(p.created) > day),
        };
      }),
  );

  server.registerTool(
    "reddit_subreddit",
    {
      title: "Subreddits",
      description: "Research a community: about (subscribers, active users, created, description), rules, posting requirements, flairs, and hot/new/top/rising/controversial posts for a time window — to find what works before posting or advertising.",
      inputSchema: {
        subreddit: z.string(),
        what: z.enum(["about", "rules", "flairs", "requirements", "hot", "new", "top", "rising", "controversial"]).default("about"),
        time: z.enum(["hour", "day", "week", "month", "year", "all"]).default("week"),
        limit: z.number().int().min(1).max(500).default(25),
      },
    },
    (a) =>
      run(async () => {
        const sr = subredditName(a.subreddit);
        switch (a.what) {
          case "about": {
            const s = (await reddit<{ data: Rec }>(`/r/${sr}/about`)).data;
            return { name: s.display_name_prefixed, title: s.title, subscribers: s.subscribers, active_now: s.active_user_count ?? s.accounts_active, created: iso(s.created_utc), nsfw: s.over18, type: s.subreddit_type, submission_type: s.submission_type, description: s.public_description, url: `https://www.reddit.com${s.url}` };
          }
          case "rules":
            return ((await reddit<{ rules?: Rec[] }>(`/r/${sr}/about/rules`)).rules ?? []).map((r) => ({ rule: r.short_name, applies_to: r.kind, details: String(r.description ?? "").slice(0, 400) }));
          case "flairs":
            return ((await reddit<Rec[]>(`/r/${sr}/api/link_flair_v2`)) ?? []).map((f) => ({ id: f.id, text: f.text, mod_only: f.mod_only || undefined }));
          case "requirements":
            return reddit(`/api/v1/${sr}/post_requirements`);
          default: {
            const items = await listing(`/r/${sr}/${a.what}`, { t: ["top", "controversial"].includes(a.what) ? a.time : undefined }, a.limit);
            return items.map(({ data }) => post(data));
          }
        }
      }),
  );

  server.registerTool(
    "reddit_thread",
    {
      title: "Read a thread",
      description: "Read a post and its comments (from a URL or post id): the post, then comments flattened with depth and score, sorted by top/new/controversial/best, with a cap on how many.",
      inputSchema: {
        post: z.string().describe("Post URL, t3_ id or bare id"),
        sort: z.enum(["confidence", "top", "new", "controversial", "old", "qa"]).default("top"),
        limit: z.number().int().min(1).max(500).default(100),
        depth: z.number().int().min(1).max(10).default(4),
      },
    },
    (a) =>
      run(async () => {
        const id = fullname(a.post, "t3").slice(3);
        const [postList, comments] = await reddit<[Listing, Listing]>(`/comments/${id}`, { query: { sort: a.sort, limit: a.limit, depth: a.depth } });
        const flatList: ReturnType<typeof comment>[] = [];
        const walk = (things: Thing[], d: number) => {
          for (const t of things) {
            if (t.kind !== "t1" || flatList.length >= a.limit) continue;
            flatList.push(comment(t.data, d));
            const replies = t.data.replies as Listing | "" | undefined;
            if (replies && typeof replies === "object") walk(replies.data.children, d + 1);
          }
        };
        walk(comments.data.children, 0);
        return { post: post(postList.data.children[0]?.data ?? {}), comments: flatList };
      }),
  );

  server.registerTool(
    "reddit_post",
    {
      title: "Post, comment, edit, delete",
      description:
        "Act as the signed-in user: submit a text or link post (with flair, NSFW/spoiler), comment on a post or reply to a comment, edit your own post/comment, delete your own content, save/unsave. Posting, commenting and deleting show a preview unless confirm: true. Check the subreddit's rules first (reddit_subreddit what=rules).",
      inputSchema: {
        action: z.enum(["submit", "comment", "edit", "delete", "save", "unsave"]),
        subreddit: z.string().optional(),
        title: z.string().max(300).optional(),
        text: z.string().optional().describe("Markdown body (submit text post, comment, edit)"),
        url: z.string().url().optional().describe("Link post URL"),
        flair_id: z.string().optional(),
        nsfw: z.boolean().default(false),
        spoiler: z.boolean().default(false),
        target: z.string().optional().describe("comment: post/comment URL or id to reply to; edit/delete/save: the thing"),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        switch (a.action) {
          case "submit": {
            if (!a.subreddit || !a.title) throw new Error("subreddit and title are required");
            const form = { sr: subredditName(a.subreddit), title: a.title, kind: a.url ? "link" : "self", url: a.url, text: a.url ? undefined : a.text ?? "", flair_id: a.flair_id, nsfw: String(a.nsfw), spoiler: String(a.spoiler), api_type: "json", resubmit: "true" };
            if (!a.confirm) return { preview: true, would_post: form, note: "Nothing posted. Pass confirm: true to publish publicly." };
            return submitResult(await reddit<Rec>("/api/submit", { form }));
          }
          case "comment": {
            if (!a.target || !a.text) throw new Error("target and text are required");
            const thing = /comments\/[a-z0-9]+\/[^/]*\/[a-z0-9]+/i.test(a.target) || a.target.startsWith("t1_") ? fullname(a.target, "t1") : fullname(a.target, "t3");
            if (!a.confirm) return { preview: true, reply_to: thing, text: a.text, note: "Nothing posted. Pass confirm: true to publish." };
            return submitResult(await reddit<Rec>("/api/comment", { form: { thing_id: thing, text: a.text, api_type: "json" } }));
          }
          case "edit": {
            if (!a.target || !a.text) throw new Error("target and text are required");
            const thing = a.target.startsWith("t1_") || a.target.startsWith("t3_") ? a.target : fullname(a.target, "t3");
            return submitResult(await reddit<Rec>("/api/editusertext", { form: { thing_id: thing, text: a.text, api_type: "json" } }));
          }
          case "delete":
            if (!a.target) throw new Error("target is required");
            if (!a.confirm) throw new Error("Deleting your post/comment can't be undone; set confirm: true");
            await reddit("/api/del", { form: { id: a.target.startsWith("t") ? a.target : fullname(a.target, "t3") } });
            return { deleted: a.target };
          case "save":
          case "unsave":
            if (!a.target) throw new Error("target is required");
            await reddit(`/api/${a.action}`, { form: { id: a.target.startsWith("t") ? a.target : fullname(a.target, "t3") } });
            return { [a.action === "save" ? "saved" : "unsaved"]: a.target };
        }
      }),
  );

  server.registerTool(
    "reddit_me",
    {
      title: "My account & inbox",
      description: "The signed-in account: profile and karma (by subreddit), your recent posts, comments and saved items, subscribed/moderated subreddits, inbox (unread, messages, mentions), mark read, and send a private message (confirm).",
      inputSchema: {
        what: z.enum(["profile", "karma", "posts", "comments", "saved", "subscribed", "moderated", "unread", "inbox", "mentions", "mark_read", "send_message"]),
        to: z.string().optional().describe("send_message: username (without u/)"),
        subject: z.string().optional(),
        text: z.string().optional(),
        ids: z.array(z.string()).optional().describe("mark_read: message fullnames (t4_…/t1_…)"),
        limit: z.number().int().min(1).max(500).default(25),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        const me = async () => (await reddit<Rec>("/api/v1/me")).name as string;
        const msg = ({ data: m }: Thing) => ({ id: m.name, from: m.author, subject: m.subject, subreddit: m.subreddit ?? undefined, text: String(m.body ?? "").slice(0, 500), created: iso(m.created_utc), unread: m.new, context: m.context ? `https://www.reddit.com${m.context}` : undefined });
        switch (a.what) {
          case "profile": {
            const u = await reddit<Rec>("/api/v1/me");
            return { name: u.name, link_karma: u.link_karma, comment_karma: u.comment_karma, total_karma: u.total_karma, created: iso(u.created_utc), verified_email: u.has_verified_email, is_mod: u.is_mod, inbox_unread: u.inbox_count };
          }
          case "karma":
            return ((await reddit<{ data?: Rec[] }>("/api/v1/me/karma")).data ?? []).map((k) => ({ subreddit: k.sr, post_karma: k.link_karma, comment_karma: k.comment_karma }));
          case "posts":
            return (await listing(`/user/${await me()}/submitted`, { sort: "new" }, a.limit)).map(({ data }) => post(data));
          case "comments":
            return (await listing(`/user/${await me()}/comments`, { sort: "new" }, a.limit)).map(({ data }) => ({ ...comment(data), post: data.link_title, subreddit: data.subreddit_name_prefixed, permalink: `https://www.reddit.com${data.permalink}` }));
          case "saved":
            return (await listing(`/user/${await me()}/saved`, {}, a.limit)).map(({ kind, data }) => (kind === "t3" ? post(data) : comment(data)));
          case "subscribed":
          case "moderated":
            return (await listing(`/subreddits/mine/${a.what === "subscribed" ? "subscriber" : "moderator"}`, {}, a.limit)).map(({ data: s }) => ({ name: s.display_name_prefixed, subscribers: s.subscribers }));
          case "unread":
          case "inbox":
          case "mentions":
            return (await listing(`/message/${a.what === "mentions" ? "mentions" : a.what}`, {}, a.limit)).map(msg);
          case "mark_read":
            if (!a.ids?.length) throw new Error("ids is required");
            await reddit("/api/read_message", { form: { id: a.ids.join(",") } });
            return { read: a.ids };
          case "send_message": {
            if (!a.to || !a.subject || !a.text) throw new Error("to, subject and text are required");
            const form = { to: a.to.replace(/^\/?u\//, ""), subject: a.subject, text: a.text, api_type: "json" };
            if (!a.confirm) return { preview: true, would_send: form, note: "Nothing sent. Pass confirm: true to send." };
            return submitResult(await reddit<Rec>("/api/compose", { form }));
          }
        }
      }),
  );

  server.registerTool(
    "reddit_moderation",
    {
      title: "Moderation",
      description: "For subreddits you moderate: mod queue, reported items, unmoderated and spam, mod log, and approve or remove (as spam or not) items — removals need confirm.",
      inputSchema: {
        subreddit: z.string(),
        what: z.enum(["modqueue", "reports", "unmoderated", "spam", "log", "approve", "remove"]),
        ids: z.array(z.string()).optional().describe("approve/remove: fullnames (t3_…/t1_…)"),
        spam: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(50),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        const sr = subredditName(a.subreddit);
        if (a.what === "approve" || a.what === "remove") {
          if (!a.ids?.length) throw new Error("ids is required");
          if (a.what === "remove" && !a.confirm) throw new Error(`Removing ${a.ids.length} item(s) from r/${sr}; set confirm: true`);
          for (const id of a.ids) await reddit(`/api/${a.what}`, { form: { id, spam: a.what === "remove" ? String(a.spam) : undefined } });
          return { [a.what === "approve" ? "approved" : "removed"]: a.ids };
        }
        if (a.what === "log") return (await listing(`/r/${sr}/about/log`, {}, a.limit)).map(({ data: l }) => ({ at: iso(l.created_utc), mod: l.mod, action: l.action, target: l.target_title ?? l.target_body, author: l.target_author, details: l.details }));
        return (await listing(`/r/${sr}/about/${a.what}`, {}, a.limit)).map(({ kind, data }) => ({ ...(kind === "t3" ? post(data) : comment(data)), reports: [...((data.user_reports as unknown[]) ?? []), ...((data.mod_reports as unknown[]) ?? [])] }));
      }),
  );

  server.registerTool(
    "reddit_api",
    {
      title: "Reddit Data API call",
      description: "Call ANY Reddit Data API endpoint on https://oauth.reddit.com (GET with query, or POST form fields), e.g. /r/{sub}/wiki/index, /api/info, /user/{name}/about.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
        path: z.string(),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        form: z.record(z.string()).optional(),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        if (a.method !== "GET" && !a.confirm) throw new Error("Write calls act publicly as you; set confirm: true");
        return reddit(a.path, { method: a.method, query: a.query, form: a.form });
      }),
  );
}
