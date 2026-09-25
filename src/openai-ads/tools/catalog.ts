import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { listAll, oai, toMinor } from "../client.js";

export function registerCatalogTools(server: McpServer): void {
  server.registerTool(
    "oai_ads_product_feeds",
    {
      title: "Product feeds",
      description:
        "Product catalogs for product-feed campaigns: list feeds, recent uploads, create or archive a feed, query products (to preview an ad group's product set), and view/activate/pause the feed's SFTP access.",
      inputSchema: {
        action: z.enum(["list", "uploads", "create", "archive", "query_products", "sftp_status", "sftp_activate", "sftp_pause"]).default("list"),
        feed_id: z.string().optional(),
        name: z.string().optional(),
        countries: z.array(z.string()).optional().describe("create: countries the feed serves"),
        filters: z
          .array(z.object({ field: z.string(), operator: z.enum(["in", "not_in", "gt", "gte", "lt", "lte", "contains", "not_contains", "starts_with"]), values: z.array(z.string()) }))
          .optional(),
        limit: z.number().int().min(1).max(500).default(50),
        confirm_archive: z.boolean().default(false),
      },
    },
    (a) =>
      run(async () => {
        const feed = () => {
          if (!a.feed_id) throw new Error("feed_id is required");
          return `feeds/${a.feed_id}`;
        };
        switch (a.action) {
          case "list":
            return listAll("feeds", {}, a.limit);
          case "uploads":
            return oai("GET", "feeds/uploads", { query: { limit: a.limit } });
          case "create":
            if (!a.name) throw new Error("name is required");
            return oai("POST", "feeds", { body: { name: a.name, countries: a.countries?.map((c) => c.toUpperCase()) } });
          case "archive":
            if (!a.confirm_archive) throw new Error("Archiving a feed stops its product ads; set confirm_archive: true");
            return oai("POST", `${feed()}/archive`);
          case "query_products":
            return oai("POST", `${feed()}/products/query`, { body: { filters: a.filters, limit: a.limit } });
          case "sftp_status":
            return oai("GET", `${feed()}/sftp_access`);
          case "sftp_activate":
            return oai("POST", `${feed()}/sftp_access/activate`);
          case "sftp_pause":
            return oai("POST", `${feed()}/sftp_access/pause`);
        }
      }),
  );

  server.registerTool(
    "oai_ads_update_products",
    {
      title: "Update product price / stock",
      description:
        "Delta Feeds API: change price, title or availability of existing variants in a product feed without re-uploading the catalog. Prices are in currency units.",
      inputSchema: {
        feed_id: z.string(),
        updates: z
          .array(
            z.object({
              product_id: z.string().describe("Parent product ID from the catalog"),
              variant_id: z.string().describe("Variant/item ID from the catalog"),
              price: z.number().nonnegative().optional(),
              currency: z.string().length(3).optional(),
              in_stock: z.boolean().optional(),
              availability_status: z.string().optional().describe("Explicit status, e.g. in_stock, out_of_stock, preorder"),
              title: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    ({ feed_id, updates }) =>
      run(async () => {
        const products = new Map<string, Record<string, unknown>[]>();
        for (const u of updates) {
          if (u.price !== undefined && !u.currency) throw new Error(`Variant ${u.variant_id}: price needs currency`);
          const variant = {
            id: u.variant_id,
            ...(u.title && { title: u.title }),
            ...(u.price !== undefined && u.currency && { price: { amount: toMinor(u.price, u.currency), currency: u.currency.toUpperCase() } }),
            ...((u.in_stock !== undefined || u.availability_status) && {
              availability: { ...(u.in_stock !== undefined && { available: u.in_stock }), ...(u.availability_status && { status: u.availability_status }) },
            }),
          };
          products.set(u.product_id, [...(products.get(u.product_id) ?? []), variant]);
        }
        const body = { products: [...products].map(([id, variants]) => ({ id, variants })) };
        const res = (await oai("PATCH", `feeds/${feed_id}/products`, { body })) as { accepted?: boolean };
        if (res && res.accepted === false) throw new Error(`Feed processing did not accept the update: ${JSON.stringify(res)}`);
        return res;
      }),
  );
}
