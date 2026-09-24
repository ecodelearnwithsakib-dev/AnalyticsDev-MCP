import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { gtm, ids, param, workspacePath } from "../client.js";

const ALL_PAGES_TRIGGER = "2147479553";

const common = {
  ...ids,
  name: z.string(),
  folder_id: z.string().optional().describe("parentFolderId"),
  notes: z.string().optional(),
};

const firing = {
  trigger_ids: z.array(z.string()).default([ALL_PAGES_TRIGGER]).describe(`Firing trigger IDs; ${ALL_PAGES_TRIGGER} = built-in All Pages`),
  blocking_trigger_ids: z.array(z.string()).optional(),
  paused: z.boolean().optional(),
};

const condition = z.object({
  variable: z.string().describe("e.g. {{Page Path}}, {{Click URL}}, {{Page Hostname}}, {{_event}}"),
  operator: z.enum(["equals", "contains", "startsWith", "endsWith", "matchRegex", "cssSelector", "urlMatches", "greater", "greaterOrEquals", "less", "lessOrEquals"]),
  value: z.string(),
  negate: z.boolean().default(false),
  ignore_case: z.boolean().default(false),
});

function toFilter(c: z.infer<typeof condition>) {
  const parameter = [param.template("arg0", c.variable), param.template("arg1", c.value)];
  if (c.negate) parameter.push(param.boolean("negate", true));
  if (c.ignore_case) parameter.push(param.boolean("ignore_case", true));
  return { type: c.operator, parameter };
}

async function createTag(args: z.infer<z.ZodObject<typeof common & typeof firing>>, type: string, parameter: unknown[]) {
  return gtm("POST", `${await workspacePath(args)}/tags`, {
    name: args.name,
    type,
    parameter,
    firingTriggerId: args.trigger_ids,
    blockingTriggerId: args.blocking_trigger_ids,
    parentFolderId: args.folder_id,
    paused: args.paused,
    notes: args.notes,
  });
}

export function registerBuilderTools(server: McpServer): void {
  server.registerTool(
    "gtm_add_google_tag",
    {
      title: "Add Google tag (gtag)",
      description: "Add a Google tag for GA4 (G-XXXX) or Google Ads (AW-XXXX), firing on All Pages by default.",
      inputSchema: {
        ...common,
        ...firing,
        tag_id: z.string().describe("G-XXXX or AW-XXXX"),
        config_settings: z.record(z.string()).default({}).describe("e.g. {\"send_page_view\":\"true\",\"server_container_url\":\"https://sgtm.example.com\"}"),
      },
    },
    ({ tag_id, config_settings, ...args }) =>
      run(() => {
        const parameter: unknown[] = [param.template("tagId", tag_id)];
        if (Object.keys(config_settings).length) parameter.push(param.table("configSettingsTable", config_settings, "parameter", "parameterValue"));
        return createTag(args, "googtag", parameter);
      }),
  );

  server.registerTool(
    "gtm_add_ga4_event_tag",
    {
      title: "Add GA4 event tag",
      description:
        "Add a GA4 event tag. Params can reference variables, e.g. {\"value\":\"{{DLV - ecommerce.value}}\",\"currency\":\"BDT\"}.",
      inputSchema: {
        ...common,
        ...firing,
        measurement_id: z.string().describe("G-XXXX"),
        event_name: z.string(),
        params: z.record(z.string()).default({}),
        user_properties: z.record(z.string()).default({}),
        send_ecommerce_data: z.boolean().default(false).describe("Send the dataLayer ecommerce object"),
      },
    },
    ({ measurement_id, event_name, params, user_properties, send_ecommerce_data, ...args }) =>
      run(() => {
        const parameter: unknown[] = [param.template("eventName", event_name), param.template("measurementIdOverride", measurement_id)];
        if (Object.keys(params).length) parameter.push(param.table("eventSettingsTable", params, "parameter", "parameterValue"));
        if (Object.keys(user_properties).length) parameter.push(param.table("userProperties", user_properties, "name", "value"));
        if (send_ecommerce_data) parameter.push(param.boolean("sendEcommerceData", true), param.template("getEcommerceDataFrom", "dataLayer"));
        return createTag(args, "gaawe", parameter);
      }),
  );

  server.registerTool(
    "gtm_add_custom_html_tag",
    {
      title: "Add Custom HTML tag",
      description: "Add a Custom HTML tag (e.g. a pixel or script snippet).",
      inputSchema: {
        ...common,
        ...firing,
        html: z.string(),
        support_document_write: z.boolean().default(false),
      },
    },
    ({ html, support_document_write, ...args }) =>
      run(() => createTag(args, "html", [param.template("html", html), param.boolean("supportDocumentWrite", support_document_write)])),
  );

  server.registerTool(
    "gtm_add_trigger",
    {
      title: "Add trigger",
      description:
        "Add a trigger. Types: pageview, domReady, windowLoaded, customEvent (needs custom_event_name), click (all elements), linkClick, formSubmission, historyChange, jsError, scrollDepth, elementVisibility, timer, youTubeVideo. Conditions are AND-ed ('Some ... events').",
      inputSchema: {
        ...ids,
        name: z.string(),
        type: z.enum(["pageview", "domReady", "windowLoaded", "customEvent", "click", "linkClick", "formSubmission", "historyChange", "jsError", "scrollDepth", "elementVisibility", "timer", "youTubeVideo"]),
        custom_event_name: z.string().optional(),
        custom_event_regex: z.boolean().default(false),
        conditions: z.array(condition).default([]),
        folder_id: z.string().optional(),
        extra: z.record(z.unknown()).optional().describe("Other trigger fields, e.g. {\"waitForTags\":{...}} or scroll/visibility parameters"),
      },
    },
    ({ name, type, custom_event_name, custom_event_regex, conditions, folder_id, extra, ...args }) =>
      run(async () => {
        if (type === "customEvent" && !custom_event_name) throw new Error("custom_event_name is required for customEvent triggers");
        const body: Record<string, unknown> = {
          name,
          type,
          parentFolderId: folder_id,
          filter: conditions.length ? conditions.map(toFilter) : undefined,
          ...extra,
        };
        if (type === "customEvent") {
          body.customEventFilter = [
            toFilter({
              variable: "{{_event}}",
              operator: custom_event_regex ? "matchRegex" : "equals",
              value: custom_event_name!,
              negate: false,
              ignore_case: false,
            }),
          ];
        }
        return gtm("POST", `${await workspacePath(args)}/triggers`, body);
      }),
  );

  server.registerTool(
    "gtm_add_variable",
    {
      title: "Add variable",
      description:
        "Add a user-defined variable: dataLayer (value = key path, e.g. ecommerce.value), constant, jsVariable (global name), customJavaScript (function source), cookie (cookie name), urlQuery (query key), domElement (CSS selector).",
      inputSchema: {
        ...ids,
        name: z.string(),
        kind: z.enum(["dataLayer", "constant", "jsVariable", "customJavaScript", "cookie", "urlQuery", "domElement"]),
        value: z.string(),
        default_value: z.string().optional().describe("dataLayer only"),
        folder_id: z.string().optional(),
      },
    },
    ({ name, kind, value, default_value, folder_id, ...args }) =>
      run(async () => {
        const specs: Record<typeof kind, { type: string; parameter: unknown[] }> = {
          dataLayer: {
            type: "v",
            parameter: [
              param.integer("dataLayerVersion", 2),
              param.template("name", value),
              ...(default_value !== undefined ? [param.boolean("setDefaultValue", true), param.template("defaultValue", default_value)] : []),
            ],
          },
          constant: { type: "c", parameter: [param.template("value", value)] },
          jsVariable: { type: "j", parameter: [param.template("name", value)] },
          customJavaScript: { type: "jsm", parameter: [param.template("javascript", value)] },
          cookie: { type: "k", parameter: [param.template("name", value), param.boolean("decodeCookie", true)] },
          urlQuery: { type: "u", parameter: [param.template("component", "QUERY"), param.template("queryKey", value)] },
          domElement: {
            type: "d",
            parameter: [param.template("selectorType", "CSS"), param.template("elementSelector", value)],
          },
        };
        return gtm("POST", `${await workspacePath(args)}/variables`, { name, parentFolderId: folder_id, ...specs[kind] });
      }),
  );

  server.registerTool(
    "gtm_add_folder",
    {
      title: "Add folder",
      description: "Create a folder to organize tags, triggers and variables.",
      inputSchema: { ...ids, name: z.string() },
    },
    ({ name, ...args }) => run(async () => gtm("POST", `${await workspacePath(args)}/folders`, { name })),
  );
}
