import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { accountsUrl, apiDomain, apiName, fields, moduleName, schema, writeResults, zoho } from "../client.js";
import { allUsers, currentUser } from "../people.js";

type Rec = Record<string, unknown>;

export function registerAdminTools(server: McpServer): void {
  server.registerTool(
    "zoho_crm_metadata",
    {
      title: "Modules, fields, layouts & org setup",
      description:
        "Read the CRM's setup: modules (incl. custom), fields of a module with types and picklist values, layouts, custom views, related lists, pipelines and stages, users (active/all with roles), roles, profiles, territories, currencies, tags, email templates, and org details. Use it before writing to learn exact field API names and allowed picklist values.",
      inputSchema: {
        what: z.enum(["modules", "fields", "picklists", "layouts", "custom_views", "related_lists", "pipelines", "users", "roles", "profiles", "territories", "currencies", "tags", "email_templates", "org"]),
        module: schema.module.optional(),
      },
    },
    (a) =>
      run(async () => {
        const module = a.module ? await moduleName(a.module) : undefined;
        const needModule = () => {
          if (!module) throw new Error("module is required");
          return module;
        };
        switch (a.what) {
          case "modules": {
            const res = await zoho<{ modules?: Rec[] }>("settings/modules");
            return (res.modules ?? []).filter((m) => m.api_supported).map((m) => ({ api_name: m.api_name, label: m.plural_label, custom: m.generated_type === "custom", creatable: m.creatable, visible: m.visible }));
          }
          case "fields":
            return (await fields(needModule())).map((f) => ({ api_name: f.api_name, label: f.field_label, type: f.data_type, required: f.system_mandatory || undefined, read_only: f.read_only || undefined, lookup: f.lookup?.module?.api_name, picklist: f.pick_list_values?.map((p) => p.actual_value) }));
          case "picklists":
            return Object.fromEntries((await fields(needModule())).filter((f) => f.pick_list_values?.length).map((f) => [f.api_name, f.pick_list_values!.map((p) => p.actual_value)]));
          case "layouts": {
            const res = await zoho<{ layouts?: Rec[] }>("settings/layouts", { query: { module: needModule() } });
            return (res.layouts ?? []).map((l) => ({ id: l.id, name: l.name, status: l.status, sections: (l.sections as { display_label?: string; fields?: { api_name?: string }[] }[] | undefined)?.map((s) => ({ section: s.display_label, fields: s.fields?.map((f) => f.api_name) })) }));
          }
          case "custom_views": {
            const res = await zoho<{ custom_views?: Rec[] }>("settings/custom_views", { query: { module: needModule() } });
            return (res.custom_views ?? []).map((v) => ({ id: v.id, name: v.display_value ?? v.name, default: v.default, system: v.system_defined }));
          }
          case "related_lists": {
            const res = await zoho<{ related_lists?: Rec[] }>("settings/related_lists", { query: { module: needModule() } });
            return (res.related_lists ?? []).map((r) => ({ api_name: r.api_name, label: r.display_label, module: (r.module as { api_name?: string })?.api_name }));
          }
          case "pipelines": {
            const layouts = await zoho<{ layouts?: Rec[] }>("settings/layouts", { query: { module: "Deals" } });
            const out = [];
            for (const l of layouts.layouts ?? []) {
              const res = await zoho<{ pipeline?: Rec[] }>("settings/pipeline", { query: { layout_id: l.id as string } }).catch(() => ({ pipeline: [] }));
              for (const p of res.pipeline ?? [])
                out.push({ layout: l.name, pipeline: p.display_value, id: p.id, default: p.default, stages: (p.maps as { display_value?: string; forecast_category?: { name?: string } }[] | undefined)?.map((s) => s.display_value) });
            }
            return out;
          }
          case "users":
            return (await allUsers()).map((u) => ({ id: u.id, name: u.full_name, email: u.email, status: u.status, role: u.role?.name, profile: u.profile?.name }));
          case "roles":
            return ((await zoho<{ roles?: Rec[] }>("settings/roles")).roles ?? []).map((r) => ({ id: r.id, name: r.name, reporting_to: (r.reporting_to as { name?: string })?.name }));
          case "profiles":
            return ((await zoho<{ profiles?: Rec[] }>("settings/profiles")).profiles ?? []).map((p) => ({ id: p.id, name: p.name, description: p.description }));
          case "territories":
            return (await zoho<{ territories?: Rec[] }>("settings/territories")).territories ?? [];
          case "currencies":
            return (await zoho<{ currencies?: Rec[] }>("org/currencies")).currencies ?? [];
          case "tags":
            return ((await zoho<{ tags?: Rec[] }>("settings/tags", { query: { module: needModule() } })).tags ?? []).map((t) => ({ id: t.id, name: t.name }));
          case "email_templates":
            return ((await zoho<{ email_templates?: Rec[] }>("settings/email_templates", { query: { module: needModule() } })).email_templates ?? []).map((t) => ({ id: t.id, name: t.name, subject: t.subject, folder: (t.folder as { name?: string })?.name }));
          case "org":
            return (await zoho<{ org?: Rec[] }>("org")).org?.[0];
        }
      }),
  );

  server.registerTool(
    "zoho_crm_email",
    {
      title: "Email from a record",
      description:
        "Emails tied to a record: list the emails sent/received on a lead/contact/deal, or send an email from the CRM (plain text/HTML or an email template), logged on the record. Sending needs confirm: true.",
      inputSchema: {
        action: z.enum(["list", "send"]),
        module: schema.module,
        id: z.string(),
        to: z.array(z.string().email()).optional().describe("Default: the record's Email"),
        cc: z.array(z.string().email()).optional(),
        subject: z.string().optional(),
        content: z.string().optional(),
        html: z.boolean().default(true),
        template_id: z.string().optional(),
        from: z.string().email().optional().describe("Default: your CRM email"),
        confirm: schema.confirm,
      },
    },
    (a) =>
      run(async () => {
        const module = await moduleName(a.module);
        if (a.action === "list") {
          const res = await zoho<{ email_related_list?: Rec[] }>(`${module}/${a.id}/Emails`);
          return (res.email_related_list ?? []).map((e) => ({ id: e.message_id, subject: e.subject, from: (e.from as { email?: string })?.email, to: (e.to as { email?: string }[] | undefined)?.map((t) => t.email), sent_at: e.sent_time ?? e.time, status: (e.status as { type?: string }[] | undefined)?.[0]?.type, opened: e.read }));
        }
        if (!a.template_id && (!a.subject || !a.content)) throw new Error("subject and content (or template_id) are required");
        const me = await currentUser();
        let to = a.to;
        if (!to?.length) {
          const rec = await zoho<{ data?: Rec[] }>(`${module}/${a.id}`, { query: { fields: "Email,Full_Name" } });
          const email = rec.data?.[0]?.Email as string | undefined;
          if (!email) throw new Error("The record has no Email; pass to");
          to = [email];
        }
        const mail: Rec = {
          from: { user_name: me.full_name, email: a.from ?? me.email },
          to: to.map((email) => ({ email })),
          cc: a.cc?.map((email) => ({ email })),
          subject: a.subject,
          content: a.content,
          mail_format: a.html ? "html" : "text",
          template: a.template_id ? { id: a.template_id } : undefined,
        };
        if (!a.confirm) return { preview: true, would_send: mail, note: "Nothing sent. Pass confirm: true to send." };
        return writeResults(await zoho(`${module}/${a.id}/actions/send_mail`, { body: { data: [mail] } }));
      }),
  );

  server.registerTool(
    "zoho_crm_bulk_export",
    {
      title: "Bulk export (up to 200k records)",
      description: "Export a whole module (or a filtered part) to CSV with the Bulk Read API: start a job, check it, and download + unzip the CSV to a local folder when done.",
      inputSchema: {
        action: z.enum(["start", "status", "download"]),
        module: schema.module.optional(),
        fields: schema.fields,
        criteria: z
          .object({ field: z.string(), comparator: z.enum(["equal", "not_equal", "in", "not_in", "less_than", "less_equal", "greater_than", "greater_equal", "contains", "not_contains", "starts_with", "ends_with", "between"]), value: z.unknown() })
          .optional(),
        job_id: z.string().optional(),
        output_dir: z.string().default("./exports"),
      },
    },
    (a) =>
      run(async () => {
        if (a.action === "start") {
          if (!a.module) throw new Error("module is required");
          const module = await moduleName(a.module);
          const query: Rec = { module: { api_name: module } };
          if (a.fields?.length) query.fields = await Promise.all(a.fields.map((f) => apiName(module, f)));
          if (a.criteria) query.criteria = { field: { api_name: await apiName(module, a.criteria.field) }, comparator: a.criteria.comparator, value: a.criteria.value };
          const res = await zoho<{ data?: { details?: { id?: string } }[] }>("/crm/bulk/v8/read", { body: { query, file_type: "csv" } });
          return { job_id: res.data?.[0]?.details?.id, next: "Check with action status; download when state is COMPLETED." };
        }
        if (!a.job_id) throw new Error("job_id is required");
        const status = await zoho<{ data?: Rec[] }>(`/crm/bulk/v8/read/${a.job_id}`);
        const job = status.data?.[0] ?? {};
        if (a.action === "status") return { state: job.state, result: job.result, module: (job.query as { module?: { api_name?: string } })?.module?.api_name };
        if (job.state !== "COMPLETED") throw new Error(`Job is ${job.state}; try again shortly`);
        const res = (await zoho(`/crm/bulk/v8/read/${a.job_id}/result`, { rawResponse: true })) as unknown as Response;
        const dir = resolve(a.output_dir);
        await mkdir(dir, { recursive: true });
        const zip = join(dir, `zoho-bulk-${a.job_id}.zip`);
        await writeFile(zip, Buffer.from(await res.arrayBuffer()));
        const unzipped = await promisify(execFile)("unzip", ["-o", zip, "-d", dir]).then(() => true).catch(() => false);
        return { saved: zip, unzipped_to: unzipped ? dir : undefined, records: (job.result as { count?: number })?.count };
      }),
  );

  server.registerTool(
    "zoho_crm_automation",
    {
      title: "Blueprint, workflows & webhooks",
      description:
        "Automation: see which Blueprint transitions a record can take now and perform one (with required fields), list workflow rules, assignment rules and webhooks for a module.",
      inputSchema: {
        action: z.enum(["blueprint", "transition", "workflow_rules", "assignment_rules", "webhooks"]),
        module: schema.module.optional(),
        id: z.string().optional(),
        transition_id: z.string().optional(),
        data: z.record(z.unknown()).optional().describe("Fields required by the transition"),
      },
    },
    (a) =>
      run(async () => {
        const module = a.module ? await moduleName(a.module) : undefined;
        switch (a.action) {
          case "blueprint": {
            if (!module || !a.id) throw new Error("module and id are required");
            const res = await zoho<{ blueprint?: { process_info?: Rec; transitions?: Rec[] } }>(`${module}/${a.id}/actions/blueprint`);
            return {
              process: res.blueprint?.process_info?.name,
              current_state: (res.blueprint?.process_info as { field_value?: string })?.field_value,
              transitions: res.blueprint?.transitions?.map((t) => ({ id: t.id, name: t.name, next_state: t.next_field_value, required_fields: (t.fields as { api_name?: string }[] | undefined)?.map((f) => f.api_name) })),
            };
          }
          case "transition":
            if (!module || !a.id || !a.transition_id) throw new Error("module, id and transition_id are required");
            return zoho(`${module}/${a.id}/actions/blueprint`, { method: "PUT", body: { blueprint: [{ transition_id: a.transition_id, data: a.data ?? {} }] } });
          case "workflow_rules": {
            const res = await zoho<{ workflow_rules?: Rec[] }>("settings/automation/workflow_rules", { query: { module } });
            return (res.workflow_rules ?? []).map((w) => ({ id: w.id, name: w.name, module: (w.module as { api_name?: string })?.api_name, active: w.status ? (w.status as { active?: boolean }).active : undefined, trigger: (w.execute_when as { type?: string })?.type }));
          }
          case "assignment_rules":
            return (await zoho<{ assignment_rules?: Rec[] }>("settings/automation/assignment_rules", { query: { module } })).assignment_rules ?? [];
          case "webhooks":
            return ((await zoho<{ webhooks?: Rec[] }>("settings/automation/webhooks", { query: { module } })).webhooks ?? []).map((w) => ({ id: w.id, name: w.name, url: w.url, method: w.http_method, module: (w.module as { api_name?: string })?.api_name }));
        }
      }),
  );

  server.registerTool(
    "zoho_crm_health",
    {
      title: "Connection check",
      description: "Check the connection: organization, edition, your user and role, data center / API domain, and how many modules and users are visible.",
      inputSchema: {},
    },
    () =>
      run(async () => {
        const [org, me, modules] = await Promise.all([
          zoho<{ org?: Rec[] }>("org").then((r) => r.org?.[0]),
          currentUser(),
          zoho<{ modules?: Rec[] }>("settings/modules").then((r) => (r.modules ?? []).filter((m) => m.api_supported).length),
        ]);
        return {
          org: org && { name: org.company_name, id: org.id, edition: (org.license_details as { paid_type?: string })?.paid_type ?? org.type, currency: org.currency, time_zone: org.time_zone, country: org.country },
          you: { name: me.full_name, email: me.email, role: me.role?.name, profile: me.profile?.name },
          api_domain: apiDomain(),
          accounts: accountsUrl(),
          modules,
          users: (await allUsers()).length,
        };
      }),
  );
}
