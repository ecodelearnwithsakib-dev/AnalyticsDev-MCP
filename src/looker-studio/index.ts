#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { googleClient, googleRequest, PROFILES } from "../shared/google-auth.js";
import { run, startStdio } from "../shared/server.js";

const UI = "https://lookerstudio.google.com";
const API = "https://datastudio.googleapis.com/v1";
const getClient = googleClient(PROFILES["looker-studio"]);

const api = (method: "GET" | "POST" | "PATCH", path: string, data?: unknown, params?: Record<string, unknown>) =>
  googleRequest(getClient, { url: `${API}/${path}`, method, data, params });

type Role = "OWNER" | "EDITOR" | "VIEWER" | "LINK_VIEWER" | "LINK_EDITOR";
type Permissions = { permissions?: Partial<Record<Role, { members?: string[] }>>; etag?: string };

/** Accept bare emails and domains; the API wants user:/group:/domain:/serviceAccount: prefixes. */
function member(value: string): string {
  if (value === "allUsers" || /^(user|group|domain|serviceAccount):/.test(value)) return value;
  if (value.endsWith(".gserviceaccount.com")) return `serviceAccount:${value}`;
  return value.includes("@") ? `user:${value}` : `domain:${value}`;
}

const assetUrl = (type: string, id: string) => (type === "DATA_SOURCE" ? `${UI}/datasources/${id}` : `${UI}/reporting/${id}`);

// ---------- Linking API (works for any Google account, no API access needed) ----------

const connectors = ["googleAnalytics", "bigQuery", "googleSheets", "searchConsole", "cloudSpanner", "googleCloudStorage", "looker", "community"] as const;

const dataSourceInput = z.object({
  alias: z.string().optional().describe("Template data source alias (ds0, ds1, ...). Omit for a blank report with one source"),
  connector: z.enum(connectors).optional().describe("Omit to keep the template's connector and only override params"),
  params: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .default({})
    .describe(
      "Connector params. googleAnalytics: accountId, propertyId. bigQuery: type=TABLE + projectId, datasetId, tableId (or type=CUSTOM_QUERY + sql), billingProjectId. googleSheets: spreadsheetId, worksheetId, range, hasHeader. searchConsole: siteUrl (sc-domain:example.com), tableType SITE_IMPRESSION|URL_IMPRESSION, searchType WEB|IMAGE|VIDEO|NEWS. looker: instanceUrl, model, explore. community: connectorId, parameters",
    ),
  datasource_name: z.string().optional(),
  keep_datasource_name: z.boolean().optional(),
  refresh_fields: z.boolean().optional(),
});

function linkingUrls(args: {
  template_report_id?: string;
  report_name?: string;
  mode: "view" | "edit";
  page_id?: string;
  explain?: boolean;
  data_sources: z.infer<typeof dataSourceInput>[];
}) {
  const query = new URLSearchParams();
  const set = (key: string, value: unknown) => value !== undefined && query.set(key, String(value));
  set("c.reportId", args.template_report_id);
  set("c.pageId", args.page_id);
  set("c.mode", args.mode);
  set("c.explain", args.explain || undefined);
  set("r.reportName", args.report_name);
  args.data_sources.forEach((ds, i) => {
    const alias = ds.alias ?? (args.data_sources.length > 1 ? `ds${i}` : undefined);
    const prefix = alias ? `ds.${alias}.` : "ds.";
    set(`${prefix}connector`, ds.connector);
    set(`${prefix}datasourceName`, ds.datasource_name);
    set(`${prefix}keepDatasourceName`, ds.keep_datasource_name);
    set(`${prefix}refreshFields`, ds.refresh_fields);
    for (const [key, value] of Object.entries(ds.params)) set(`${prefix}${key}`, value);
  });
  return {
    create_url: `${UI}/reporting/create?${query}`,
    embed_create_url: `${UI}/embed/reporting/create?${query}`,
    note: "Opening the link shows a preview; the report is saved to the viewer's account when they click 'Edit and share' / 'Save'.",
  };
}

const server = new McpServer({ name: "looker-studio", version: "0.1.0" });

server.registerTool(
  "looker_studio_create_report_link",
  {
    title: "Build Looker Studio report link",
    description:
      "Build a Linking API URL that creates a Looker Studio report (optionally from a template report) wired to any data sources — GA4, BigQuery, Sheets, Search Console, Looker, community connectors. Works for any Google account.",
    inputSchema: {
      template_report_id: z.string().optional().describe("ID from the template's URL: lookerstudio.google.com/reporting/<ID>"),
      report_name: z.string().optional(),
      mode: z.enum(["view", "edit"]).default("edit"),
      page_id: z.string().optional(),
      explain: z.boolean().optional().describe("Show the Linking API debug dialog"),
      data_sources: z.array(dataSourceInput).default([]),
    },
  },
  (args) => run(async () => linkingUrls(args)),
);

server.registerTool(
  "looker_studio_ga4_report_link",
  {
    title: "GA4 report link",
    description: "Shortcut: build a link that creates a Looker Studio report on a GA4 property, blank or from a template.",
    inputSchema: {
      property_id: z.string().optional().describe("GA4 property ID; defaults to GA4_PROPERTY_ID"),
      account_id: z.string().optional().describe("GA4 account ID; defaults to GA4_ACCOUNT_ID"),
      template_report_id: z.string().optional(),
      template_alias: z.string().optional().describe("Alias of the template's GA4 data source, e.g. ds0"),
      report_name: z.string().optional(),
      datasource_name: z.string().optional(),
    },
  },
  (args) =>
    run(async () =>
      linkingUrls({
        template_report_id: args.template_report_id,
        report_name: args.report_name,
        mode: "edit",
        data_sources: [
          {
            alias: args.template_alias,
            connector: "googleAnalytics",
            params: {
              accountId: (args.account_id ?? requireEnv("GA4_ACCOUNT_ID")).replace(/^accounts\//, ""),
              propertyId: (args.property_id ?? requireEnv("GA4_PROPERTY_ID")).replace(/^properties\//, ""),
            },
            datasource_name: args.datasource_name,
          },
        ],
      }),
    ),
);

// ---------- Looker Studio API (Google Workspace / Cloud Identity only) ----------

server.registerTool(
  "looker_studio_search_assets",
  {
    title: "Search reports / data sources",
    description:
      "Search Looker Studio reports or data sources you can access. Requires a Google Workspace/Cloud Identity account with the API enabled by an admin.",
    inputSchema: {
      asset_type: z.enum(["REPORT", "DATA_SOURCE"]).default("REPORT"),
      title: z.string().optional().describe("Text matched against title and description"),
      owner: z.string().optional().describe("Owner email"),
      order_by: z.enum(["title", "last_viewed_by_me", "create_time", "last_accessed_time", "id"]).optional(),
      include_trashed: z.boolean().optional().describe("true returns ONLY trashed assets"),
      limit: z.number().int().min(1).max(5000).default(100),
    },
  },
  (args) =>
    run(async () => {
      const assets: { name: string; assetType: string }[] = [];
      let pageToken: string | undefined;
      do {
        const res = (await api("GET", "assets:search", undefined, {
          assetTypes: args.asset_type,
          title: args.title,
          owner: args.owner,
          orderBy: args.order_by,
          includeTrashed: args.include_trashed,
          pageSize: Math.min(args.limit, 1000),
          pageToken,
        })) as { assets?: { name: string; assetType: string }[]; nextPageToken?: string };
        assets.push(...(res.assets ?? []));
        pageToken = res.nextPageToken || undefined;
      } while (pageToken && assets.length < args.limit);
      return assets.slice(0, args.limit).map((a) => ({ ...a, url: assetUrl(a.assetType ?? args.asset_type, a.name) }));
    }),
);

server.registerTool(
  "looker_studio_get_permissions",
  {
    title: "Get sharing permissions",
    description: "Show who owns, edits and views a report or data source, and its link-sharing setting.",
    inputSchema: { asset_id: z.string() },
  },
  ({ asset_id }) => run(() => api("GET", `assets/${asset_id}/permissions`)),
);

server.registerTool(
  "looker_studio_share",
  {
    title: "Share report / data source",
    description: "Add viewers or editors. Members can be emails, domains (example.com), groups (group:x@y.com) or service accounts.",
    inputSchema: {
      asset_id: z.string(),
      role: z.enum(["VIEWER", "EDITOR"]).default("VIEWER"),
      members: z.array(z.string()).min(1),
    },
  },
  ({ asset_id, role, members }) =>
    run(() => api("POST", `assets/${asset_id}/permissions:addMembers`, { role, members: members.map(member) })),
);

server.registerTool(
  "looker_studio_revoke_access",
  {
    title: "Revoke access",
    description: "Remove members from every role on an asset (owners and yourself cannot be removed). Use allUsers to turn off 'anyone with the link'.",
    inputSchema: { asset_id: z.string(), members: z.array(z.string()).min(1) },
  },
  ({ asset_id, members }) =>
    run(() => api("POST", `assets/${asset_id}/permissions:revokeAllPermissions`, { members: members.map(member) })),
);

server.registerTool(
  "looker_studio_link_sharing",
  {
    title: "Set link sharing",
    description: "Turn 'anyone with the link' (or 'anyone in a domain with the link') viewing/editing on or off.",
    inputSchema: {
      asset_id: z.string(),
      access: z.enum(["off", "view", "edit"]),
      audience: z.string().default("allUsers").describe("allUsers, or a domain like example.com for domain-restricted links"),
    },
  },
  ({ asset_id, access, audience }) =>
    run(async () => {
      const target = member(audience);
      if (access === "off") {
        return api("POST", `assets/${asset_id}/permissions:revokeAllPermissions`, { members: [target] });
      }
      const current = (await api("GET", `assets/${asset_id}/permissions`)) as Permissions;
      const { OWNER: _owner, LINK_VIEWER: _viewer, LINK_EDITOR: _editor, ...rest } = current.permissions ?? {};
      // An asset can have LINK_VIEWER or LINK_EDITOR, not both; OWNER cannot be patched.
      const permissions = { ...rest, [access === "view" ? "LINK_VIEWER" : "LINK_EDITOR"]: { members: [target] } };
      return api("PATCH", `assets/${asset_id}/permissions`, { permissions: { permissions } });
    }),
);

server.registerTool(
  "looker_studio_set_permissions",
  {
    title: "Replace permissions",
    description:
      "Replace EDITOR / VIEWER / LINK_VIEWER / LINK_EDITOR members in one call (OWNER cannot be changed). Roles you omit are cleared, so read with looker_studio_get_permissions first.",
    inputSchema: {
      asset_id: z.string(),
      editors: z.array(z.string()).optional(),
      viewers: z.array(z.string()).optional(),
      link_viewers: z.array(z.string()).optional().describe("allUsers or domain:example.com"),
      link_editors: z.array(z.string()).optional(),
    },
  },
  ({ asset_id, editors, viewers, link_viewers, link_editors }) =>
    run(() => {
      const role = (members?: string[]) => (members ? { members: members.map(member) } : undefined);
      const permissions = {
        EDITOR: role(editors),
        VIEWER: role(viewers),
        LINK_VIEWER: role(link_viewers),
        LINK_EDITOR: role(link_editors),
      };
      return api("PATCH", `assets/${asset_id}/permissions`, { permissions: { permissions } });
    }),
);

server.registerTool(
  "looker_studio_api_status",
  {
    title: "Looker Studio API status",
    description: "Check which auth mode is configured and whether the Looker Studio API is reachable for this account.",
    inputSchema: {},
  },
  () =>
    run(async () => {
      const mode = optionalEnv("LOOKER_STUDIO_OAUTH_REFRESH_TOKEN")
        ? "oauth"
        : optionalEnv("LOOKER_STUDIO_IMPERSONATE_USER")
          ? "service account + domain-wide delegation"
          : "application default credentials";
      try {
        await api("GET", "assets:search", undefined, { assetTypes: "REPORT", pageSize: 1 });
        return { mode, api: "ok" };
      } catch (error) {
        return {
          mode,
          api: "unavailable",
          error: error instanceof Error ? error.message : String(error),
          hint: "The Looker Studio API only works for Google Workspace / Cloud Identity users after an admin authorizes the OAuth client via domain-wide delegation. Linking API tools still work.",
        };
      }
    }),
);

await startStdio(server, "looker-studio");
