import { zoho } from "./client.js";

type User = { id: string; full_name: string; email: string; status?: string; role?: { name?: string }; profile?: { name?: string } };
let users: Promise<User[]> | undefined;

export function allUsers(): Promise<User[]> {
  users ??= (async () => {
    const out: User[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await zoho<{ users?: User[]; info?: { more_records?: boolean } }>("users", { query: { type: "AllUsers", page, per_page: 200 } });
      out.push(...(res.users ?? []));
      if (!res.info?.more_records) break;
    }
    return out;
  })();
  users.catch(() => (users = undefined));
  return users;
}

let me: Promise<User> | undefined;
export function currentUser(): Promise<User> {
  me ??= zoho<{ users: User[] }>("users", { query: { type: "CurrentUser" } }).then((r) => r.users[0]);
  me.catch(() => (me = undefined));
  return me;
}

/** "me", an email, a name or an ID → user ID. */
export async function userId(who: string): Promise<string> {
  if (/^\d{10,}$/.test(who)) return who;
  if (who.toLowerCase() === "me") return (await currentUser()).id;
  const q = who.toLowerCase().replace(/^@/, "");
  const list = await allUsers();
  const hit = list.find((u) => u.email?.toLowerCase() === q) ?? list.find((u) => u.full_name?.toLowerCase() === q) ?? list.filter((u) => u.full_name?.toLowerCase().includes(q));
  if (Array.isArray(hit)) {
    if (hit.length === 1) return hit[0].id;
    throw new Error(hit.length ? `"${who}" matches ${hit.map((u) => u.full_name).join(", ")} — be more specific` : `No CRM user matches "${who}"`);
  }
  return hit.id;
}

export async function userName(id?: string): Promise<string | undefined> {
  if (!id) return undefined;
  return (await allUsers().catch(() => [] as User[])).find((u) => u.id === id)?.full_name ?? id;
}
