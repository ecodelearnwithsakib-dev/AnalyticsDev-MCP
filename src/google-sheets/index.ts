#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleClient, googleRequest, PROFILES } from "../shared/google-auth.js";
import { run, startStdio } from "../shared/server.js";

const getClient = googleClient(PROFILES.sheets);
type Method = "GET" | "POST" | "PUT" | "DELETE";
const g = (method: Method, url: string, data?: unknown, params?: Record<string, unknown>) => googleRequest(getClient, { method, url, data, params });
const S = "https://sheets.googleapis.com/v4/spreadsheets";
const idOf = (s: string) => s.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] ?? s;

const server = new McpServer(
  { name: "google-sheets", version: "0.1.0" },
  { instructions: "Google Sheets: find spreadsheets, read ranges as rows or objects (first row = headers), append rows, update ranges, clear, create spreadsheets and tabs. Spreadsheet IDs or full URLs both work. Ranges use A1 notation, e.g. Weekly!A1:F." },
);

server.registerTool(
  "sheets_find",
  { title: "Find spreadsheets", description: "Search your Google Drive for spreadsheets by name (newest first).", inputSchema: { name: z.string().optional(), limit: z.number().int().min(1).max(200).default(25) } },
  (a) =>
    run(async () => {
      const q = [`mimeType='application/vnd.google-apps.spreadsheet'`, "trashed=false", ...(a.name ? [`name contains '${a.name.replace(/'/g, "\\'")}'`] : [])].join(" and ");
      const r = (await g("GET", "https://www.googleapis.com/drive/v3/files", undefined, { q, pageSize: a.limit, orderBy: "modifiedTime desc", fields: "files(id,name,modifiedTime,owners(emailAddress),webViewLink)" })) as { files?: unknown[] };
      return r.files ?? [];
    }),
);

server.registerTool(
  "sheets_info",
  { title: "Spreadsheet info", description: "Title, tabs (name, id, rows × columns) and named ranges of a spreadsheet.", inputSchema: { spreadsheet: z.string() } },
  (a) =>
    run(async () => {
      const r = (await g("GET", `${S}/${idOf(a.spreadsheet)}`, undefined, { fields: "properties.title,sheets.properties,namedRanges,spreadsheetUrl" })) as { properties?: { title?: string }; sheets?: { properties: Record<string, unknown> }[]; namedRanges?: unknown[]; spreadsheetUrl?: string };
      return { title: r.properties?.title, url: r.spreadsheetUrl, tabs: r.sheets?.map((s) => ({ name: s.properties.title, id: s.properties.sheetId, rows: (s.properties.gridProperties as Record<string, number>)?.rowCount, columns: (s.properties.gridProperties as Record<string, number>)?.columnCount })), named_ranges: r.namedRanges };
    }),
);

server.registerTool(
  "sheets_read",
  { title: "Read a range", description: "Read a range (e.g. Sheet1!A1:Z1000 or just a tab name). as_objects uses the first row as headers and returns one object per row.", inputSchema: { spreadsheet: z.string(), range: z.string(), as_objects: z.boolean().default(true), render: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).default("FORMATTED_VALUE"), limit: z.number().int().min(1).max(100000).default(1000) } },
  (a) =>
    run(async () => {
      const r = (await g("GET", `${S}/${idOf(a.spreadsheet)}/values/${encodeURIComponent(a.range)}`, undefined, { valueRenderOption: a.render })) as { values?: unknown[][]; range?: string };
      const values = r.values ?? [];
      if (!a.as_objects || values.length < 2) return { range: r.range, rows: values.slice(0, a.limit) };
      const [head, ...body] = values;
      return { range: r.range, count: body.length, rows: body.slice(0, a.limit).map((row) => Object.fromEntries(head.map((h, i) => [String(h), row[i] ?? ""]))) };
    }),
);

server.registerTool(
  "sheets_append",
  { title: "Append rows", description: "Append rows after the last row of a table (e.g. a weekly KPI log). Rows are arrays of cell values, or objects matched to the header row.", inputSchema: { spreadsheet_id: z.string(), range: z.string().describe("Tab or table range, e.g. Weekly!A1"), rows: z.array(z.union([z.array(z.unknown()), z.record(z.unknown())])).min(1), raw: z.boolean().default(false).describe("true = store exactly as given; false = parse like typing (dates, numbers, formulas)") } },
  (a) =>
    run(async () => {
      const id = idOf(a.spreadsheet_id);
      let values = a.rows as unknown[][];
      if (a.rows.some((r) => !Array.isArray(r))) {
        const tab = a.range.split("!")[0];
        const head = (((await g("GET", `${S}/${id}/values/${encodeURIComponent(`${tab}!1:1`)}`)) as { values?: string[][] }).values?.[0]) ?? [];
        if (!head.length) throw new Error("Object rows need a header row in row 1");
        values = a.rows.map((r) => (Array.isArray(r) ? r : head.map((h) => (r as Record<string, unknown>)[h] ?? "")));
      }
      const r = (await g("POST", `${S}/${id}/values/${encodeURIComponent(a.range)}:append`, { values }, { valueInputOption: a.raw ? "RAW" : "USER_ENTERED", insertDataOption: "INSERT_ROWS" })) as { updates?: Record<string, unknown> };
      return { appended: r.updates?.updatedRows, range: r.updates?.updatedRange };
    }),
);

server.registerTool(
  "sheets_write",
  { title: "Update / clear a range", description: "Overwrite a range with values (2-D array), or clear it (confirm). Overwrites need confirm when they replace more than 100 cells.", inputSchema: { spreadsheet: z.string(), range: z.string(), values: z.array(z.array(z.unknown())).optional(), clear: z.boolean().default(false), confirm: z.boolean().default(false) } },
  (a) =>
    run(async () => {
      const id = idOf(a.spreadsheet);
      if (a.clear) {
        if (!a.confirm) throw new Error(`Clearing ${a.range}; set confirm: true`);
        return g("POST", `${S}/${id}/values/${encodeURIComponent(a.range)}:clear`, {});
      }
      if (!a.values) throw new Error("values is required");
      const cells = a.values.reduce((n, r) => n + r.length, 0);
      if (cells > 100 && !a.confirm) throw new Error(`This overwrites ${cells} cells in ${a.range}; set confirm: true`);
      return g("PUT", `${S}/${id}/values/${encodeURIComponent(a.range)}`, { values: a.values }, { valueInputOption: "USER_ENTERED" });
    }),
);

server.registerTool(
  "sheets_create",
  { title: "Create spreadsheet or tab", description: "Create a new spreadsheet (optionally with tabs and a header row), or add a tab to an existing one.", inputSchema: { title: z.string(), spreadsheet: z.string().optional().describe("Add a tab to this spreadsheet instead"), tabs: z.array(z.string()).optional(), headers: z.array(z.string()).optional() } },
  (a) =>
    run(async () => {
      if (a.spreadsheet) {
        const id = idOf(a.spreadsheet);
        await g("POST", `${S}/${id}:batchUpdate`, { requests: [{ addSheet: { properties: { title: a.title } } }] });
        if (a.headers?.length) await g("PUT", `${S}/${id}/values/${encodeURIComponent(`${a.title}!A1`)}`, { values: [a.headers] }, { valueInputOption: "RAW" });
        return { added_tab: a.title };
      }
      const r = (await g("POST", S, { properties: { title: a.title }, sheets: (a.tabs ?? ["Sheet1"]).map((t) => ({ properties: { title: t } })) })) as { spreadsheetId: string; spreadsheetUrl: string };
      if (a.headers?.length) await g("PUT", `${S}/${r.spreadsheetId}/values/${encodeURIComponent(`${(a.tabs ?? ["Sheet1"])[0]}!A1`)}`, { values: [a.headers] }, { valueInputOption: "RAW" });
      return { spreadsheet_id: r.spreadsheetId, url: r.spreadsheetUrl };
    }),
);

server.registerTool(
  "sheets_api",
  { title: "Sheets API call", description: "Any Sheets API v4 call, e.g. POST {id}:batchUpdate with formatting, charts, filters or protected ranges.", inputSchema: { method: z.enum(["GET", "POST", "PUT"]).default("POST"), path: z.string().describe("Relative to https://sheets.googleapis.com/v4/spreadsheets/, e.g. {id}:batchUpdate"), body: z.unknown().optional(), params: z.record(z.unknown()).optional() } },
  (a) => run(() => g(a.method, `${S}/${a.path.replace(/^\/+/, "")}`, a.body, a.params)),
);

await startStdio(server, "google-sheets");
