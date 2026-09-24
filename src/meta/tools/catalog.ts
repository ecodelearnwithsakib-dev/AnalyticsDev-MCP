import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireEnv } from "../../shared/env.js";
import { run } from "../../shared/server.js";
import { graph, graphList, schema } from "../client.js";

export function registerCatalogTools(server: McpServer): void {
  server.registerTool(
    "meta_list_catalogs",
    {
      title: "List product catalogs",
      description: "List product catalogs owned by a Business Manager.",
      inputSchema: {
        business_id: z.string().optional().describe("Defaults to META_BUSINESS_ID"),
        fields: schema.fields("id,name,product_count,vertical"),
        limit: schema.limit,
      },
    },
    ({ business_id, fields, limit }) =>
      run(() => graphList(`${business_id ?? requireEnv("META_BUSINESS_ID")}/owned_product_catalogs`, { fields }, limit)),
  );

  server.registerTool(
    "meta_list_products",
    {
      title: "List catalog products",
      description: "List products in a catalog. filter example: {\"availability\":{\"eq\":\"in stock\"}}",
      inputSchema: {
        catalog_id: z.string(),
        filter: z.record(z.unknown()).optional(),
        fields: schema.fields("id,retailer_id,name,price,sale_price,availability,image_url,url,review_status"),
        limit: schema.limit,
      },
    },
    ({ catalog_id, filter, fields, limit }) => run(() => graphList(`${catalog_id}/products`, { fields, filter }, limit)),
  );

  server.registerTool(
    "meta_catalog_batch",
    {
      title: "Create/update/delete products",
      description:
        "Batch-upsert or delete catalog items. Each request: {\"method\":\"UPDATE\"|\"CREATE\"|\"DELETE\",\"data\":{\"id\":\"SKU1\",\"title\":\"...\",\"price\":\"1500 BDT\",\"availability\":\"in stock\",\"link\":\"...\",\"image_link\":\"...\",\"description\":\"...\",\"brand\":\"...\",\"condition\":\"new\"}}",
      inputSchema: {
        catalog_id: z.string(),
        requests: z.array(z.object({ method: z.enum(["CREATE", "UPDATE", "DELETE"]), data: z.record(z.unknown()) })).min(1),
      },
    },
    ({ catalog_id, requests }) =>
      run(() => graph("POST", `${catalog_id}/items_batch`, { item_type: "PRODUCT_ITEM", requests })),
  );
}
