#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { restClient } from "../shared/rest.js";
import { run, startStdio } from "../shared/server.js";

/** Notion API with an internal integration token (share pages/databases with the integration). */
const api = restClient({ name: "Notion", base: () => "https://api.notion.com/v1", headers: () => ({ Authorization: `Bearer ${requireEnv("NOTION_TOKEN")}`, "Notion-Version": optionalEnv("NOTION_VERSION", "2022-06-28") }), hints: { 401: "check NOTION_TOKEN", 404: "not found — share the page/database with your integration (••• → Connections)" } });

type Rec = Record<string, unknown>;
const text = (rt: unknown) => ((rt as { plain_text: string }[]) ?? []).map((t) => t.plain_text).join("");
const id = (v: string) => (v.match(/[0-9a-f]{32}|[0-9a-f-]{36}/i)?.[0] ?? v).replace(/-/g, "");

/** Flatten a Notion property value into something readable. */
function prop(p: Rec): unknown {
  const v = p[p.type as string] as unknown;
  switch (p.type) {
    case "title":
    case "rich_text":
      return text(v);
    case "select":
    case "status":
      return (v as Rec | null)?.name ?? null;
    case "multi_select":
      return (v as Rec[]).map((x) => x.name);
    case "date":
      return v ? `${(v as Rec).start}${(v as Rec).end ? ` → ${(v as Rec).end}` : ""}` : null;
    case "people":
      return (v as Rec[]).map((x) => x.name ?? x.id);
    case "relation":
      return (v as Rec[]).map((x) => x.id);
    case "formula":
    case "rollup": {
      const f = v as Rec;
      return f[f.type as string];
    }
    case "files":
      return (v as Rec[]).map((x) => x.name);
    default:
      return v;
  }
}
const flat = (page: Rec) => ({ id: page.id, url: page.url, ...Object.fromEntries(Object.entries((page.properties ?? {}) as Record<string, Rec>).map(([k, v]) => [k, prop(v)])) });

/** Build Notion property payloads from plain values using the database schema. */
async function toProps(dbId: string, values: Rec) {
  const db = (await api(`databases/${id(dbId)}`)) as { properties: Record<string, { type: string }> };
  const out: Rec = {};
  for (const [k, v] of Object.entries(values)) {
    const t = db.properties[k]?.type;
    if (!t) throw new Error(`Unknown property "${k}". Properties: ${Object.keys(db.properties).join(", ")}`);
    out[k] =
      t === "title" ? { title: [{ text: { content: String(v) } }] }
      : t === "rich_text" ? { rich_text: [{ text: { content: String(v) } }] }
      : t === "number" ? { number: v === null ? null : Number(v) }
      : t === "select" ? { select: v ? { name: String(v) } : null }
      : t === "status" ? { status: { name: String(v) } }
      : t === "multi_select" ? { multi_select: (Array.isArray(v) ? v : String(v).split(",")).map((x) => ({ name: String(x).trim() })) }
      : t === "date" ? { date: v ? { start: String(v) } : null }
      : t === "checkbox" ? { checkbox: Boolean(v) }
      : t === "url" ? { url: v } : t === "email" ? { email: v } : t === "phone_number" ? { phone_number: v }
      : t === "relation" ? { relation: (Array.isArray(v) ? v : [v]).map((x) => ({ id: id(String(x)) })) }
      : t === "people" ? { people: (Array.isArray(v) ? v : [v]).map((x) => ({ id: String(x) })) }
      : { [t]: v };
  }
  return out;
}
/** Markdown-ish text → paragraph/heading/bullet/todo blocks. */
const blocks = (md: string) =>
  md.split("\n").filter((l) => l.trim()).map((l) => {
    const m = l.match(/^(#{1,3}) (.*)/);
    if (m) return { type: `heading_${m[1].length}`, [`heading_${m[1].length}`]: { rich_text: [{ text: { content: m[2] } }] } };
    if (/^- \[( |x)\] /.test(l)) return { type: "to_do", to_do: { checked: l[3] === "x", rich_text: [{ text: { content: l.slice(6) } }] } };
    if (/^[-*] /.test(l)) return { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ text: { content: l.slice(2) } }] } };
    if (/^\d+\. /.test(l)) return { type: "numbered_list_item", numbered_list_item: { rich_text: [{ text: { content: l.replace(/^\d+\. /, "") } }] } };
    return { type: "paragraph", paragraph: { rich_text: [{ text: { content: l.slice(0, 2000) } }] } };
  });

const server = new McpServer(
  { name: "notion", version: "0.1.0" },
  { instructions: "Notion via an internal integration: search pages/databases, query databases with filters (results flattened to plain values), read page content as text, create pages or database rows from plain values and markdown, update properties, append content, archive (confirm). Pages must be shared with the integration. Notion's official remote MCP can be used alongside." },
);

server.registerTool(
  "notion_search",
  { title: "Search", description: "Search page and database titles the integration can see.", inputSchema: { query: z.string().default(""), type: z.enum(["page", "database"]).optional(), limit: z.number().int().min(1).max(100).default(20) } },
  (a) =>
    run(async () => {
      const r = (await api("search", { body: { query: a.query, filter: a.type ? { property: "object", value: a.type } : undefined, page_size: a.limit } })) as { results: Rec[] };
      return r.results.map((x) => ({ id: x.id, type: x.object, title: x.object === "database" ? text(x.title) : text((Object.values((x.properties ?? {}) as Record<string, Rec>).find((p) => p.type === "title") as Rec)?.title), url: x.url, edited: x.last_edited_time }));
    }),
);

server.registerTool(
  "notion_query",
  { title: "Query database", description: "Query a database with a Notion filter object (or a simple equals map) and sorts; returns rows as plain values. Also returns the schema when schema: true.", inputSchema: { database: z.string().describe("Database ID or URL"), where: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Simple equals filters {Property: value}"), filter: z.record(z.unknown()).optional().describe("Raw Notion filter object"), sorts: z.array(z.record(z.unknown())).optional(), limit: z.number().int().min(1).max(5000).default(100), schema: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      const dbId = id(a.database);
      const db = (await api(`databases/${dbId}`)) as { title: unknown; properties: Record<string, Rec> };
      let filter = a.filter;
      if (!filter && a.where) {
        const and = Object.entries(a.where).map(([k, v]) => {
          const t = db.properties[k]?.type as string;
          const op = t === "title" || t === "rich_text" ? { equals: String(v) } : t === "multi_select" ? { contains: String(v) } : t === "checkbox" ? { equals: Boolean(v) } : t === "number" ? { equals: Number(v) } : { equals: v };
          return { property: k, [t === "title" || t === "rich_text" ? t : t]: op };
        });
        filter = and.length === 1 ? and[0] : { and };
      }
      const out: Rec[] = [];
      let cursor: string | undefined;
      do {
        const r = (await api(`databases/${dbId}/query`, { body: { filter, sorts: a.sorts, page_size: Math.min(100, a.limit - out.length), start_cursor: cursor } })) as { results: Rec[]; next_cursor?: string; has_more: boolean };
        out.push(...r.results.map(flat));
        cursor = r.has_more ? r.next_cursor : undefined;
      } while (cursor && out.length < a.limit);
      return { database: text(db.title), schema: a.schema ? Object.fromEntries(Object.entries(db.properties).map(([k, v]) => [k, { type: v.type, options: ((v[v.type as string] as Rec)?.options as Rec[])?.map((o) => o.name) }])) : undefined, rows: out };
    }),
);

server.registerTool(
  "notion_page",
  { title: "Read page", description: "A page's properties and its content as plain text/markdown (nested blocks up to depth 2).", inputSchema: { page: z.string().describe("Page ID or URL"), max_blocks: z.number().int().min(1).max(2000).default(300) } },
  (a) =>
    run(async () => {
      const pid = id(a.page);
      const page = (await api(`pages/${pid}`)) as Rec;
      const lines: string[] = [];
      const walk = async (bid: string, depth: number) => {
        let cursor: string | undefined;
        do {
          const r = (await api(`blocks/${bid}/children`, { query: { page_size: 100, start_cursor: cursor } })) as { results: Rec[]; next_cursor?: string; has_more: boolean };
          for (const b of r.results) {
            if (lines.length >= a.max_blocks) return;
            const t = b.type as string;
            const body = b[t] as Rec;
            const s = text(body?.rich_text);
            const pre = "  ".repeat(depth) + (t.startsWith("heading_") ? "#".repeat(Number(t.slice(-1))) + " " : t === "bulleted_list_item" ? "- " : t === "numbered_list_item" ? "1. " : t === "to_do" ? `- [${body.checked ? "x" : " "}] ` : t === "quote" ? "> " : "");
            if (t === "child_database" || t === "child_page") lines.push(`${pre}[${t}: ${body.title}] ${b.id}`);
            else if (t === "code") lines.push("```\n" + s + "\n```");
            else if (s) lines.push(pre + s);
            if (b.has_children && depth < 2 && t !== "child_page" && t !== "child_database") await walk(String(b.id), depth + 1);
          }
          cursor = r.has_more ? r.next_cursor : undefined;
        } while (cursor);
      };
      await walk(pid, 0);
      return { ...flat(page), content: lines.join("\n") };
    }),
);

server.registerTool(
  "notion_write",
  {
    title: "Create / update / append / archive",
    description: "Create a database row (properties as plain values, converted using the schema) or a sub-page under a page, with optional markdown content; update a page's properties; append markdown content; or archive a page (confirm).",
    inputSchema: { action: z.enum(["create", "update", "append", "archive"]), database: z.string().optional(), parent_page: z.string().optional(), page: z.string().optional(), title: z.string().optional(), properties: z.record(z.unknown()).optional(), content: z.string().optional().describe("Markdown-ish: # headings, - bullets, 1. lists, - [ ] todos"), confirm: z.boolean().default(false) },
  },
  (a) =>
    run(async () => {
      if (a.action === "create") {
        if (a.database) {
          const r = (await api("pages", { body: { parent: { database_id: id(a.database) }, properties: await toProps(a.database, a.properties ?? {}), children: a.content ? blocks(a.content).slice(0, 100) : undefined } })) as Rec;
          return flat(r);
        }
        if (!a.parent_page || !a.title) throw new Error("database, or parent_page + title, is required");
        const r = (await api("pages", { body: { parent: { page_id: id(a.parent_page) }, properties: { title: { title: [{ text: { content: a.title } }] } }, children: a.content ? blocks(a.content).slice(0, 100) : undefined } })) as Rec;
        return { id: r.id, url: r.url };
      }
      if (!a.page) throw new Error("page is required");
      const pid = id(a.page);
      if (a.action === "update") {
        const page = (await api(`pages/${pid}`)) as { parent: Rec };
        const dbId = page.parent.database_id as string | undefined;
        if (!dbId) throw new Error("Only database rows have editable properties");
        return flat((await api(`pages/${pid}`, { method: "PATCH", body: { properties: await toProps(dbId, a.properties ?? {}) } })) as Rec);
      }
      if (a.action === "append") {
        const bl = blocks(a.content ?? "");
        for (let i = 0; i < bl.length; i += 100) await api(`blocks/${pid}/children`, { method: "PATCH", body: { children: bl.slice(i, i + 100) } });
        return { appended: bl.length };
      }
      if (!a.confirm) throw new Error("Archiving moves the page to Trash; set confirm: true");
      await api(`pages/${pid}`, { method: "PATCH", body: { archived: true } });
      return { archived: pid };
    }),
);

server.registerTool(
  "notion_api",
  { title: "Notion API call", description: "Call any Notion API endpoint (comments, users, blocks, databases). Writes need confirm.", inputSchema: { method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional(), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      if (a.method !== "GET" && !/\/query$|^\/?search$/.test(a.path) && !a.confirm) throw new Error("Write calls change Notion; set confirm: true");
      return api(a.path.replace(/^\/?(v1\/)?/, ""), { method: a.method, query: a.query, body: a.body });
    }),
);

await startStdio(server, "notion");
