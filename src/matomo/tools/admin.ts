import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv } from "../../shared/env.js";
import { run } from "../../shared/server.js";
import { baseUrl, matomo, range, schema, siteId } from "../client.js";

const need = <T>(v: T | undefined, name: string): T => {
  if (v === undefined || v === null || v === "") throw new Error(`${name} is required`);
  return v;
};

const decodeHtml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&");

export function registerAdminTools(server: McpServer): void {
  server.registerTool(
    "matomo_sites",
    {
      title: "Sites & tracking code",
      description:
        "Websites (measurables): list the ones you can access, get one, add a site (URLs, timezone, currency, ecommerce, site search, excluded IPs/params), update settings, get the JavaScript tracking code, or delete a site (confirm — deletes all its data).",
      inputSchema: {
        action: z.enum(["list", "get", "add", "update", "tracking_code", "delete"]).default("list"),
        site_id: schema.site_id,
        name: z.string().optional(),
        urls: z.array(z.string().url()).optional(),
        timezone: z.string().optional().describe("e.g. Asia/Dhaka"),
        currency: z.string().length(3).optional().describe("e.g. BDT, USD"),
        ecommerce: z.boolean().optional(),
        site_search: z.boolean().optional(),
        excluded_ips: z.array(z.string()).optional(),
        excluded_parameters: z.array(z.string()).optional(),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const settings = {
          siteName: a.name,
          urls: a.urls,
          timezone: a.timezone,
          currency: a.currency,
          ecommerce: a.ecommerce,
          siteSearch: a.site_search,
          excludedIps: a.excluded_ips?.join(","),
          excludedParameters: a.excluded_parameters?.join(","),
        };
        switch (a.action) {
          case "list": {
            const sites = (await matomo("SitesManager.getSitesWithAtLeastViewAccess")) as Record<string, unknown>[];
            return sites.map((s) => ({ id: s.idsite, name: s.name, url: s.main_url, timezone: s.timezone, currency: s.currency, ecommerce: s.ecommerce === 1 || s.ecommerce === "1", created: s.ts_created }));
          }
          case "get":
            return matomo("SitesManager.getSiteFromId", { idSite: siteId(a.site_id) });
          case "add":
            return { id: await matomo("SitesManager.addSite", { ...settings, siteName: need(a.name, "name"), urls: need(a.urls, "urls") }) };
          case "update":
            return matomo("SitesManager.updateSite", { idSite: siteId(a.site_id), ...settings });
          case "tracking_code": {
            const res = (await matomo("SitesManager.getJavascriptTag", { idSite: siteId(a.site_id), piwikUrl: baseUrl() })) as { value?: string } | string;
            return { site: siteId(a.site_id), code: decodeHtml(typeof res === "string" ? res : res.value ?? "") };
          }
          case "delete":
            if (!a.confirm) throw new Error("Deleting a site erases all of its analytics data; set confirm: true");
            return matomo("SitesManager.deleteSite", { idSite: need(a.site_id, "site_id") });
        }
      }),
  );

  server.registerTool(
    "matomo_goals",
    {
      title: "Goals",
      description:
        "List goals, or create/update one: match a URL, page title, event (category/action/name), download, outlink, visit duration or pages per visit, with contains/exact/regex, revenue, multiple conversions per visit. Delete with confirm.",
      inputSchema: {
        action: z.enum(["list", "add", "update", "delete"]).default("list"),
        site_id: schema.site_id,
        goal_id: z.union([z.string(), z.number()]).optional(),
        name: z.string().optional(),
        match: z.enum(["url", "title", "event_category", "event_action", "event_name", "file", "external_website", "manually", "visit_duration", "visit_nb_pageviews"]).optional(),
        pattern: z.string().optional().describe("What to match, e.g. /thank-you or purchase"),
        pattern_type: z.enum(["contains", "exact", "regex", "greater_than"]).default("contains"),
        case_sensitive: z.boolean().default(false),
        revenue: z.number().nonnegative().optional(),
        use_event_value: z.boolean().default(false).describe("Event goals: use the event value as revenue"),
        allow_multiple: z.boolean().default(false),
        description: z.string().optional(),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const idSite = siteId(a.site_id);
        if (a.action === "list") return matomo("Goals.getGoals", { idSite });
        if (a.action === "delete") {
          if (!a.confirm) throw new Error("Deleting a goal removes its conversion reports; set confirm: true");
          return matomo("Goals.deleteGoal", { idSite, idGoal: need(a.goal_id, "goal_id") });
        }
        const body = {
          idSite,
          name: need(a.name, "name"),
          matchAttribute: need(a.match, "match"),
          pattern: a.pattern ?? "",
          patternType: a.pattern_type,
          caseSensitive: a.case_sensitive,
          revenue: a.revenue ?? 0,
          allowMultipleConversionsPerVisit: a.allow_multiple,
          description: a.description ?? "",
          useEventValueAsRevenue: a.use_event_value,
        };
        if (a.action === "add") return { goal_id: await matomo("Goals.addGoal", body) };
        return matomo("Goals.updateGoal", { ...body, idGoal: need(a.goal_id, "goal_id") });
      }),
  );

  server.registerTool(
    "matomo_segments",
    {
      title: "Segments",
      description:
        "Saved segments: list, create, update or delete (confirm); list every dimension you can segment on (with example values). Definitions use Matomo syntax, e.g. referrerType==campaign;deviceType==smartphone or pageUrl=@/checkout.",
      inputSchema: {
        action: z.enum(["list", "dimensions", "add", "update", "delete"]).default("list"),
        site_id: schema.site_id,
        segment_id: z.union([z.string(), z.number()]).optional(),
        name: z.string().optional(),
        definition: z.string().optional(),
        all_sites: z.boolean().default(false),
        share_with_all_users: z.boolean().default(false),
        pre_process: z.boolean().default(true).describe("Archive in the background for fast reports"),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        switch (a.action) {
          case "list":
            return matomo("SegmentEditor.getAll", { idSite: a.site_id ?? optionalEnv("MATOMO_SITE_ID") });
          case "dimensions": {
            const dims = (await matomo("API.getSegmentsMetadata", { idSites: [siteId(a.site_id)] })) as Record<string, unknown>[];
            return dims.map((d) => ({ segment: d.segment, name: d.name, category: d.category, type: d.type, example: d.acceptedValues }));
          }
          case "add":
          case "update": {
            const body = {
              name: need(a.name, "name"),
              definition: need(a.definition, "definition"),
              idSite: a.all_sites ? 0 : siteId(a.site_id),
              autoArchive: a.pre_process,
              enabledAllUsers: a.share_with_all_users,
            };
            if (a.action === "add") return { segment_id: await matomo("SegmentEditor.add", body) };
            return matomo("SegmentEditor.update", { ...body, idSegment: need(a.segment_id, "segment_id") });
          }
          case "delete":
            if (!a.confirm) throw new Error("Deleting a saved segment is permanent; set confirm: true");
            return matomo("SegmentEditor.delete", { idSegment: need(a.segment_id, "segment_id") });
        }
      }),
  );

  server.registerTool(
    "matomo_annotations",
    {
      title: "Annotations",
      description: "Timeline notes on the evolution graph (campaign launches, site changes, outages): list for a date range, add one (optionally starred), or delete one (confirm).",
      inputSchema: {
        action: z.enum(["list", "add", "delete"]).default("list"),
        site_id: schema.site_id,
        date: z.string().optional().describe("add: YYYY-MM-DD"),
        note: z.string().optional(),
        starred: z.boolean().default(false),
        note_id: z.union([z.string(), z.number()]).optional(),
        preset: schema.preset,
        from: schema.from,
        to: schema.to,
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const idSite = siteId(a.site_id);
        if (a.action === "add") return matomo("Annotations.add", { idSite, date: need(a.date, "date"), note: need(a.note, "note"), starred: a.starred });
        if (a.action === "delete") {
          if (!a.confirm) throw new Error("Deleting an annotation is permanent; set confirm: true");
          return matomo("Annotations.delete", { idSite, idNote: need(a.note_id, "note_id") });
        }
        const r = range(a.preset ?? "last_90_days", a.from, a.to);
        return matomo("Annotations.getAll", { idSite, period: "range", date: `${r.from},${r.to}` });
      }),
  );

  server.registerTool(
    "matomo_users",
    {
      title: "Users & access",
      description: "List users with their role on a site, invite a user by email (with initial site access), or set someone's access (view, write, admin, noaccess) on sites. Some changes need the Matomo password confirmation and must then be done in the UI.",
      inputSchema: {
        action: z.enum(["list", "invite", "set_access"]).default("list"),
        site_id: schema.site_id,
        login: z.string().optional(),
        email: z.string().email().optional(),
        access: z.enum(["view", "write", "admin", "noaccess"]).default("view"),
        site_ids: z.array(z.union([z.string(), z.number()])).optional(),
      },
    },
    (a) =>
      run(async () => {
        switch (a.action) {
          case "list":
            return matomo("UsersManager.getUsersPlusRole", { idSite: siteId(a.site_id), limit: 500 });
          case "invite":
            return matomo("UsersManager.inviteUser", { userLogin: need(a.login, "login"), email: need(a.email, "email"), initialIdSite: siteId(a.site_id) });
          case "set_access":
            return matomo("UsersManager.setUserAccess", { userLogin: need(a.login, "login"), access: a.access, idSites: (a.site_ids ?? [siteId(a.site_id)]).map(String) });
        }
      }),
  );

  server.registerTool(
    "matomo_tag_manager",
    {
      title: "Tag Manager & custom dimensions",
      description:
        "Matomo Tag Manager: list containers, list a container's draft tags/triggers/variables, create a version from the draft and publish it to an environment (e.g. live), get the container embed code. Also list or create custom dimensions (visit or action scope).",
      inputSchema: {
        action: z.enum(["containers", "draft", "publish", "embed_code", "dimensions", "add_dimension"]).default("containers"),
        site_id: schema.site_id,
        container_id: z.string().optional(),
        version_name: z.string().optional(),
        environment: z.string().default("live"),
        dimension_name: z.string().optional(),
        scope: z.enum(["visit", "action"]).default("visit"),
      },
    },
    (a) =>
      run(async () => {
        const idSite = siteId(a.site_id);
        switch (a.action) {
          case "containers":
            return matomo("TagManager.getContainers", { idSite });
          case "draft": {
            const container = (await matomo("TagManager.getContainer", { idSite, idContainer: need(a.container_id, "container_id") })) as { draft?: { idcontainerversion?: number } };
            const idContainerVersion = container.draft?.idcontainerversion;
            const args = { idSite, idContainer: a.container_id, idContainerVersion };
            const [tags, triggers, variables] = await Promise.all([
              matomo("TagManager.getContainerTags", args),
              matomo("TagManager.getContainerTriggers", args),
              matomo("TagManager.getContainerVariables", args),
            ]);
            return { draft_version: idContainerVersion, tags, triggers, variables };
          }
          case "publish": {
            const idContainer = need(a.container_id, "container_id");
            const version = await matomo("TagManager.createContainerVersion", { idSite, idContainer, name: a.version_name ?? `MCP ${new Date().toISOString().slice(0, 16)}` });
            await matomo("TagManager.publishContainerVersion", { idSite, idContainer, idContainerVersion: version, environment: a.environment });
            return { published_version: version, environment: a.environment };
          }
          case "embed_code":
            return matomo("TagManager.getContainerEmbedCode", { idSite, idContainer: need(a.container_id, "container_id"), environment: a.environment });
          case "dimensions":
            return matomo("CustomDimensions.getConfiguredCustomDimensions", { idSite });
          case "add_dimension":
            return { dimension_id: await matomo("CustomDimensions.configureNewCustomDimension", { idSite, name: need(a.dimension_name, "dimension_name"), scope: a.scope, active: 1 }) };
        }
      }),
  );

  server.registerTool(
    "matomo_health",
    {
      title: "Connection & health",
      description: "Check the connection: Matomo version, your access (super user or not), sites you can see, and whether the official MCP Server plugin endpoint answers with your token.",
      inputSchema: {},
    },
    () =>
      run(async () => {
        const [version, superUser, sites] = await Promise.all([
          matomo("API.getMatomoVersion").catch((e: Error) => e.message),
          matomo("UsersManager.hasSuperUserAccess").catch(() => undefined),
          matomo("SitesManager.getSitesIdWithAtLeastViewAccess").catch((e: Error) => e.message),
        ]);
        let plugin: unknown;
        try {
          const res = await fetch(`${baseUrl()}/index.php?module=API&method=McpServer.mcp&format=mcp`, {
            method: "POST",
            headers: { Authorization: `Bearer ${optionalEnv("MATOMO_TOKEN")}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "health", version: "1" } } }),
          });
          const text = await res.text();
          plugin = { http: res.status, installed: res.ok && text.includes("jsonrpc") };
        } catch (error) {
          plugin = { error: error instanceof Error ? error.message : String(error) };
        }
        return { url: baseUrl(), version, super_user: superUser, site_ids: sites, default_site: optionalEnv("MATOMO_SITE_ID") || undefined, official_mcp_plugin: plugin };
      }),
  );
}
