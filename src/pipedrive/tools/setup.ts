import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { all, baseUrl, confirm, fields, me, pd, pipelines, stages, users, type Entity, type Rec } from "../client.js";

export function registerSetupTools(server: McpServer): void {
  server.registerTool(
    "pipedrive_search",
    {
      title: "Search everything",
      description: "One search across deals, people, organizations, products, leads, files and projects (name, email, phone, notes, custom fields). Returns type, id, title and the matched field.",
      inputSchema: {
        term: z.string().min(2),
        types: z.array(z.enum(["deal", "person", "organization", "product", "lead", "file", "mail_attachment", "project"])).optional(),
        exact: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    (a) =>
      run(async () => {
        const res = await pd<{ data?: { items?: { item: Rec; result_score?: number }[] } }>("v2/itemSearch", { query: { term: a.term, item_types: a.types?.join(","), exact_match: a.exact, limit: a.limit } });
        return (res.data?.items ?? []).map(({ item, result_score }) => ({ type: item.type, id: item.id, title: item.title ?? item.name, value: item.value ?? undefined, status: item.status ?? undefined, person: (item.person as Rec)?.name, organization: (item.organization as Rec)?.name, score: result_score }));
      }),
  );

  server.registerTool(
    "pipedrive_setup",
    {
      title: "Pipelines, fields, users & settings",
      description:
        "Account setup: pipelines with stages (probability, rotting days), custom fields of deals/people/organizations/products/activities with option labels, create a custom field, users and roles, activity types, currencies, saved filters, lead labels, and goals.",
      inputSchema: {
        what: z.enum(["pipelines", "fields", "create_field", "users", "activity_types", "currencies", "filters", "lead_labels", "goals"]),
        entity: z.enum(["deal", "person", "organization", "product", "activity"]).default("deal"),
        name: z.string().optional(),
        field_type: z.enum(["varchar", "text", "double", "monetary", "date", "enum", "set", "phone", "user", "org", "people", "address", "time", "daterange"]).optional(),
        options: z.array(z.string()).optional(),
      },
    },
    (a) =>
      run(async () => {
        switch (a.what) {
          case "pipelines": {
            const [p, s] = await Promise.all([pipelines(), stages()]);
            return p.map((x) => ({ id: x.id, name: x.name, stages: s.filter((st) => st.pipeline_id === x.id).sort((m, n) => (m.order_nr ?? 0) - (n.order_nr ?? 0)).map((st) => ({ id: st.id, name: st.name, probability: st.deal_probability, rotting_days: st.rotten_days ?? undefined })) }));
          }
          case "fields":
            return (await fields(a.entity as Entity)).filter((f) => f.edit_flag !== false || /[0-9a-f]{40}/.test(f.key)).map((f) => ({ key: f.key, name: f.name, type: f.field_type, custom: /^[0-9a-f]{40}$/.test(f.key) || undefined, options: f.options?.map((o) => o.label) }));
          case "create_field":
            if (!a.name || !a.field_type) throw new Error("name and field_type are required");
            return (await pd<{ data: Rec }>(`v1/${a.entity}Fields`, { body: { name: a.name, field_type: a.field_type, options: a.options?.map((label) => ({ label })) } })).data;
          case "users":
            return (await users()).map((u) => ({ id: u.id, name: u.name, email: u.email, active: u.active_flag, admin: !!u.is_admin }));
          case "activity_types":
            return ((await pd<{ data: Rec[] }>("v1/activityTypes")).data ?? []).filter((t) => t.active_flag).map((t) => ({ key: t.key_string, name: t.name }));
          case "currencies":
            return ((await pd<{ data: Rec[] }>("v1/currencies")).data ?? []).filter((c) => c.is_custom_flag || ["USD", "EUR", "GBP", "BDT", "INR"].includes(String(c.code))).map((c) => ({ code: c.code, name: c.name, symbol: c.symbol }));
          case "filters":
            return ((await pd<{ data: Rec[] }>("v1/filters")).data ?? []).map((f) => ({ id: f.id, name: f.name, type: f.type, owner: f.user_id }));
          case "lead_labels":
            return (await pd<{ data: Rec[] }>("v1/leadLabels")).data;
          case "goals":
            return (await pd<{ data: Rec }>("v1/goals/find")).data;
        }
      }),
  );

  server.registerTool(
    "pipedrive_products",
    {
      title: "Products",
      description: "Product catalog: list, search by name/code, get, create (price per currency, code, unit, tax), update, and delete (confirm).",
      inputSchema: {
        action: z.enum(["list", "search", "get", "create", "update", "delete"]),
        id: z.number().int().optional(),
        query: z.string().optional(),
        name: z.string().optional(),
        code: z.string().optional(),
        price: z.number().optional(),
        currency: z.string().default("USD"),
        unit: z.string().optional(),
        tax: z.number().optional(),
        limit: z.number().int().min(1).max(2000).default(100),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        const body = (): Rec => ({ ...(a.name ? { name: a.name } : {}), ...(a.code ? { code: a.code } : {}), ...(a.unit ? { unit: a.unit } : {}), ...(a.tax !== undefined ? { tax: a.tax } : {}), ...(a.price !== undefined ? { prices: [{ price: a.price, currency: a.currency }] } : {}) });
        const brief = (p: Rec) => ({ id: p.id, name: p.name, code: p.code || undefined, unit: p.unit || undefined, prices: (p.prices as Rec[] | undefined)?.map((x) => `${x.price} ${x.currency}`) });
        switch (a.action) {
          case "list":
            return (await all("v2/products", {}, a.limit)).map(brief);
          case "search":
            if (!a.query) throw new Error("query is required");
            return ((await pd<{ data?: { items?: { item: Rec }[] } }>("v2/products/search", { query: { term: a.query, limit: a.limit } })).data?.items ?? []).map(({ item }) => ({ id: item.id, name: item.name, code: item.code }));
          case "get":
            return brief((await pd<{ data: Rec }>(`v2/products/${a.id}`)).data);
          case "create":
            if (!a.name) throw new Error("name is required");
            return { created: (await pd<{ data: Rec }>("v2/products", { body: body() })).data.id };
          case "update":
            if (!a.id) throw new Error("id is required");
            await pd(`v2/products/${a.id}`, { method: "PATCH", body: body() });
            return { updated: a.id };
          case "delete":
            if (!a.id) throw new Error("id is required");
            if (!a.confirm) throw new Error("Deleting a product; set confirm: true");
            await pd(`v2/products/${a.id}`, { method: "DELETE" });
            return { deleted: a.id };
        }
      }),
  );

  server.registerTool(
    "pipedrive_webhooks",
    {
      title: "Webhooks",
      description: "Send Pipedrive events to n8n/Make/Zapier or your server: list webhooks, create one (e.g. deal change / person create / * all) with optional basic auth, delete (confirm).",
      inputSchema: {
        action: z.enum(["list", "create", "delete"]),
        id: z.number().int().optional(),
        url: z.string().url().optional(),
        event_action: z.enum(["create", "change", "delete", "*"]).default("*"),
        event_object: z.enum(["activity", "deal", "lead", "note", "organization", "person", "pipeline", "product", "stage", "user", "*"]).default("deal"),
        http_auth_user: z.string().optional(),
        http_auth_password_env: z.string().optional().describe("Name of a .env variable holding the password (never pasted in chat)"),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        switch (a.action) {
          case "list":
            return ((await pd<{ data: Rec[] }>("v1/webhooks")).data ?? []).map((w) => ({ id: w.id, url: w.subscription_url, event: `${w.event_action}.${w.event_object}`, active: w.is_active, last_status: w.last_http_status, version: w.version }));
          case "create":
            if (!a.url) throw new Error("url is required");
            return (await pd<{ data: Rec }>("v1/webhooks", { body: { subscription_url: a.url, event_action: a.event_action, event_object: a.event_object, version: "2.0", http_auth_user: a.http_auth_user, http_auth_password: a.http_auth_password_env ? process.env[a.http_auth_password_env] : undefined } })).data;
          case "delete":
            if (!a.id) throw new Error("id is required");
            if (!a.confirm) throw new Error("Deleting the webhook stops those events; set confirm: true");
            await pd(`v1/webhooks/${a.id}`, { method: "DELETE" });
            return { deleted: a.id };
        }
      }),
  );

  server.registerTool(
    "pipedrive_api",
    {
      title: "Pipedrive API call",
      description: "Call ANY Pipedrive endpoint: \"v2/...\" for API v2 (deals, persons, organizations, activities, products, pipelines, stages, itemSearch) or \"v1/...\" for v1 (notes, leads, files, mailbox, goals, projects, callLogs, permissionSets, roles…).",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string().describe("e.g. v2/deals/123/followers or v1/projects"),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional(),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        if (a.method === "DELETE" && !a.confirm) throw new Error("DELETE calls need confirm: true");
        return pd(a.path, { method: a.method, query: a.query, body: a.body });
      }),
  );

  server.registerTool(
    "pipedrive_health",
    {
      title: "Connection check",
      description: "Check the connection: company, your user, plan currency and timezone, number of users, pipelines and open deals.",
      inputSchema: {},
    },
    () =>
      run(async () => {
        const u = await me();
        const [p, us, open] = await Promise.all([pipelines(), users(), pd<{ data?: Rec[]; additional_data?: Rec }>("v2/deals", { query: { status: "open", limit: 1 } })]);
        return { url: baseUrl(), company: u.company_name, domain: u.company_domain, you: { id: u.id, name: u.name, email: u.email }, currency: u.default_currency, timezone: u.timezone_name, users: us.length, pipelines: p.map((x) => x.name), has_open_deals: (open.data?.length ?? 0) > 0 };
      }),
  );
}
