import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { adAccount, graph, graphList, hash, schema } from "../client.js";

const userSchemas = {
  EMAIL: { schema: "EMAIL_SHA256", normalize: (v: string) => v },
  PHONE: { schema: "PHONE_SHA256", normalize: (v: string) => v.replace(/\D/g, "") },
  EXTERN_ID: { schema: "EXTERN_ID", normalize: (v: string) => v },
} as const;

export function registerAudienceTools(server: McpServer): void {
  server.registerTool(
    "meta_list_audiences",
    {
      title: "List custom audiences",
      description: "List custom and lookalike audiences in an ad account.",
      inputSchema: {
        ad_account_id: schema.adAccountId,
        fields: schema.fields(
          "id,name,subtype,description,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status,time_updated",
        ),
        limit: schema.limit,
      },
    },
    ({ ad_account_id, fields, limit }) => run(() => graphList(`${adAccount(ad_account_id)}/customaudiences`, { fields }, limit)),
  );

  server.registerTool(
    "meta_create_custom_audience",
    {
      title: "Create custom audience",
      description:
        "Create a customer-list (CUSTOM), website (WEBSITE, needs rule with the pixel), or engagement audience. Website rule example: {\"inclusions\":{\"operator\":\"or\",\"rules\":[{\"event_sources\":[{\"id\":\"<PIXEL_ID>\",\"type\":\"pixel\"}],\"retention_seconds\":2592000,\"filter\":{\"operator\":\"and\",\"filters\":[{\"field\":\"event\",\"operator\":\"eq\",\"value\":\"AddToCart\"}]}}]}}",
      inputSchema: {
        ad_account_id: schema.adAccountId,
        name: z.string(),
        subtype: z.enum(["CUSTOM", "WEBSITE", "ENGAGEMENT", "APP", "OFFLINE_CONVERSION"]).default("CUSTOM"),
        description: z.string().optional(),
        customer_file_source: z
          .enum(["USER_PROVIDED_ONLY", "PARTNER_PROVIDED_ONLY", "BOTH_USER_AND_PARTNER_PROVIDED"])
          .optional()
          .describe("Required for CUSTOM customer-list audiences"),
        rule: z.record(z.unknown()).optional(),
        prefill: z.boolean().optional().describe("Include past matching activity for website audiences"),
        extra: schema.extra,
      },
    },
    ({ ad_account_id, extra, ...fields }) =>
      run(() =>
        graph("POST", `${adAccount(ad_account_id)}/customaudiences`, {
          ...fields,
          customer_file_source: fields.customer_file_source ?? (fields.subtype === "CUSTOM" ? "USER_PROVIDED_ONLY" : undefined),
          ...extra,
        }),
      ),
  );

  server.registerTool(
    "meta_audience_users",
    {
      title: "Add/remove audience users",
      description: "Add or remove customers from a customer-list audience. Values are normalized and SHA-256 hashed before upload.",
      inputSchema: {
        audience_id: z.string(),
        key: z.enum(["EMAIL", "PHONE", "EXTERN_ID"]),
        values: z.array(z.string()).min(1).max(10000),
        action: z.enum(["add", "remove"]).default("add"),
      },
    },
    ({ audience_id, key, values, action }) =>
      run(() => {
        const { schema: schemaName, normalize } = userSchemas[key];
        const payload = { schema: schemaName, data: values.map((v) => hash(normalize(v))) };
        return graph(action === "add" ? "POST" : "DELETE", `${audience_id}/users`, { payload });
      }),
  );

  server.registerTool(
    "meta_create_lookalike",
    {
      title: "Create lookalike audience",
      description: "Create a lookalike from a source audience. ratio 0.01 = top 1% most similar.",
      inputSchema: {
        ad_account_id: schema.adAccountId,
        name: z.string(),
        origin_audience_id: z.string(),
        country: z.string().length(2).describe("ISO country code, e.g. BD"),
        ratio: z.number().min(0.01).max(0.2).default(0.01),
      },
    },
    ({ ad_account_id, name, origin_audience_id, country, ratio }) =>
      run(() =>
        graph("POST", `${adAccount(ad_account_id)}/customaudiences`, {
          name,
          subtype: "LOOKALIKE",
          origin_audience_id,
          lookalike_spec: { country, ratio, type: "similarity" },
        }),
      ),
  );
}
