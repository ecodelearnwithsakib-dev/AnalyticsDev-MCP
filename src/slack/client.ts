import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";

type Params = Record<string, unknown>;
export type SlackResponse = { ok: boolean; error?: string; needed?: string; response_metadata?: { next_cursor?: string; messages?: string[] }; [key: string]: unknown };

/** User token (xoxp) by default — acts as you and can search; the bot token (xoxb) is used when asked and configured. */
export function token(asBot = false): string {
  if (asBot) {
    const bot = optionalEnv("SLACK_BOT_TOKEN");
    if (!bot) throw new Error("SLACK_BOT_TOKEN is not set; post as yourself or add the bot token to .env");
    return bot;
  }
  return optionalEnv("SLACK_USER_TOKEN") || requireEnv("SLACK_BOT_TOKEN");
}

/** Calls a Slack Web API method (form-encoded; objects/arrays sent as JSON); waits out 429 Retry-After. */
export async function slack(method: string, params: Params = {}, opts: { asBot?: boolean } = {}): Promise<SlackResponse> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token(opts.asBot)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get("retry-after")) || 2 ** attempt, 60) * 1000));
      continue;
    }
    const data = (await res.json().catch(async () => ({ ok: false, error: `HTTP ${res.status}` }))) as SlackResponse;
    if (!data.ok) {
      const hint =
        data.error === "missing_scope"
          ? ` — the token needs scope ${data.needed}; add it in your Slack app (OAuth & Permissions) and reinstall`
          : data.error === "not_in_channel"
            ? " — invite yourself/the app to the channel first (slack_channels action=join)"
            : data.error === "invalid_auth" || data.error === "not_authed"
              ? " — check SLACK_USER_TOKEN in .env"
              : "";
      const detail = data.response_metadata?.messages?.length ? ` (${data.response_metadata.messages.join("; ")})` : "";
      throw new Error(`Slack ${method}: ${data.error}${detail}${hint}`);
    }
    return data;
  }
}

/** Follow next_cursor pages of a list method, collecting `key`. */
export async function paginate<T>(method: string, key: string, params: Params = {}, limit = 1000): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const res = await slack(method, { ...params, limit: Math.min(200, limit - out.length) || 1, cursor });
    out.push(...((res[key] as T[]) ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor && out.length < limit);
  return out.slice(0, limit);
}

export type User = { id: string; name: string; real_name?: string; deleted?: boolean; is_bot?: boolean; profile?: { email?: string; display_name?: string; real_name?: string; title?: string }; tz?: string };
export type Channel = { id: string; name?: string; is_private?: boolean; is_archived?: boolean; is_im?: boolean; is_mpim?: boolean; user?: string; num_members?: number; topic?: { value?: string }; purpose?: { value?: string } };

let usersCache: Promise<User[]> | undefined;
let channelsCache: Promise<Channel[]> | undefined;
export const users = () => (usersCache ??= paginate<User>("users.list", "members", {}, 20000));
export const channels = (refresh = false) => {
  if (refresh) channelsCache = undefined;
  return (channelsCache ??= paginate<Channel>("conversations.list", "channels", { types: "public_channel,private_channel", exclude_archived: false }, 20000));
};

let me: Promise<{ user_id: string; user: string; team: string; team_id: string }> | undefined;
export const whoami = () => (me ??= slack("auth.test").then((r) => r as unknown as { user_id: string; user: string; team: string; team_id: string }));

const displayName = (u?: User) => u?.profile?.display_name || u?.real_name || u?.name;

/** "me", U123…, @handle, display/real name or email → user ID. */
export async function userId(who: string): Promise<string> {
  const q = who.trim().replace(/^@/, "").toLowerCase();
  if (q === "me") return (await whoami()).user_id;
  if (/^[uw][a-z0-9]{6,}$/i.test(who.trim())) return who.trim().toUpperCase();
  if (q.includes("@")) {
    const hit = (await users()).find((u) => u.profile?.email?.toLowerCase() === q);
    if (hit) return hit.id;
    return ((await slack("users.lookupByEmail", { email: q })).user as User).id;
  }
  const all = (await users()).filter((u) => !u.deleted);
  const exact = all.filter((u) => [u.name, u.profile?.display_name, u.real_name].some((n) => n?.toLowerCase() === q));
  const hits = exact.length ? exact : all.filter((u) => [u.name, u.profile?.display_name, u.real_name].some((n) => n?.toLowerCase().includes(q)));
  if (hits.length !== 1) throw new Error(hits.length ? `"${who}" matches several people: ${hits.slice(0, 8).map((u) => `${displayName(u)} (@${u.name})`).join(", ")}` : `No Slack user matches "${who}"`);
  return hits[0].id;
}

/** #channel, channel name, C/G/D ID, or a person (@name / email) → conversation ID (opening a DM when needed). */
export async function conversationId(where: string): Promise<string> {
  const w = where.trim();
  if (/^[CGD][A-Z0-9]{6,}$/.test(w)) return w;
  if (w.startsWith("@") || w.includes("@") || /^[UW][A-Z0-9]{6,}$/.test(w) || w.toLowerCase() === "me") {
    const uid = await userId(w);
    return ((await slack("conversations.open", { users: uid })).channel as Channel).id;
  }
  const name = w.replace(/^#/, "").toLowerCase();
  let hit = (await channels()).find((c) => c.name?.toLowerCase() === name);
  hit ??= (await channels(true)).find((c) => c.name?.toLowerCase() === name);
  if (!hit) throw new Error(`No channel named #${name} (or the token can't see it)`);
  return hit.id;
}

/** Friendly names for user IDs in results. */
export async function nameOf(id?: string): Promise<string | undefined> {
  if (!id) return undefined;
  return displayName((await users()).find((u) => u.id === id)) ?? id;
}

/** Replace <@U123> mentions with @names so messages read naturally. */
export async function readable(text?: string): Promise<string | undefined> {
  if (!text) return text;
  const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((m) => m[1]))];
  let out = text;
  for (const id of ids) out = out.replaceAll(`<@${id}>`, `@${await nameOf(id)}`);
  return out;
}

/** "2026-10-01", ISO, "yesterday", "-2h"/"-3d", or a Slack ts → Unix seconds (string, as Slack wants). */
export function toTs(value: string): string {
  const v = value.trim().toLowerCase();
  if (/^\d{9,10}(\.\d+)?$/.test(v)) return v;
  const rel = v.match(/^([+-]?\d+)([mhdw])$/);
  if (rel) {
    const mult = { m: 60, h: 3600, d: 86400, w: 604800 }[rel[2] as "m" | "h" | "d" | "w"];
    return String(Math.floor(Date.now() / 1000) + Number(rel[1]) * mult);
  }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const named: Record<string, number> = { today: 0, yesterday: -1, tomorrow: 1 };
  if (v in named) return String(Math.floor(start.getTime() / 1000) + named[v] * 86400);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : value);
  if (Number.isNaN(ms)) throw new Error(`Can't read time "${value}" — use YYYY-MM-DD, ISO datetime, today/yesterday, or -2h / -3d / +30m`);
  return String(Math.floor(ms / 1000));
}

export const iso = (ts?: string) => (ts ? new Date(Number(ts) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined);

type Message = { ts: string; user?: string; bot_id?: string; username?: string; text?: string; thread_ts?: string; reply_count?: number; reactions?: { name: string; count: number }[]; files?: { name?: string }[]; subtype?: string };

/** Compact message with names resolved. */
export async function compactMessage(m: Message) {
  return {
    ts: m.ts,
    at: iso(m.ts),
    from: m.user ? await nameOf(m.user) : m.username ?? m.bot_id,
    text: await readable(m.text),
    thread_ts: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined,
    replies: m.reply_count || undefined,
    reactions: m.reactions?.length ? m.reactions.map((r) => `${r.name}×${r.count}`) : undefined,
    files: m.files?.length ? m.files.map((f) => f.name) : undefined,
    subtype: m.subtype,
  };
}

export const schema = {
  channel: z.string().describe("#channel, channel name, channel ID, or a person (@name / email / \"me\") for a DM"),
  when: z.string().optional().describe("YYYY-MM-DD, ISO datetime, today/yesterday, or relative like -2h / -3d"),
  confirm: z.boolean().default(false).describe("Required for permanent actions (delete, archive, kick)"),
  as_bot: z.boolean().default(false).describe("Post/act as the app's bot (needs SLACK_BOT_TOKEN) instead of as you"),
};
