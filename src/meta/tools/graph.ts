import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { graph, graphList, pageToken, schema } from "../client.js";

export function registerGraphTools(server: McpServer): void {
  server.registerTool(
    "meta_graph_request",
    {
      title: "Meta Graph API request",
      description:
        "Call ANY Graph / Marketing / Instagram API endpoint directly. Use when no dedicated tool fits. Path is relative to the API version, e.g. 'me/adaccounts' or '<AD_ID>/previews'.",
      inputSchema: {
        method: z.enum(["GET", "POST", "DELETE"]).default("GET"),
        path: z.string(),
        params: z.record(z.unknown()).optional().describe("Query params (GET/DELETE) or form fields (POST)"),
        use_page_token_for: z.string().optional().describe("Page ID whose Page access token should be used"),
      },
    },
    ({ method, path, params, use_page_token_for }) =>
      run(async () => {
        const token = use_page_token_for ? await pageToken(use_page_token_for) : undefined;
        return graph(method, path, params ?? {}, token);
      }),
  );

  server.registerTool(
    "meta_whoami",
    {
      title: "Meta token info",
      description: "Show who the access token belongs to and which permissions are granted.",
      inputSchema: {},
    },
    () =>
      run(async () => ({
        me: await graph("GET", "me", { fields: "id,name" }),
        permissions: await graph("GET", "me/permissions"),
      })),
  );

  server.registerTool(
    "meta_list_businesses",
    {
      title: "List Business Managers",
      description: "List Business Manager accounts the token can access.",
      inputSchema: { fields: schema.fields("id,name,verification_status,created_time"), limit: schema.limit },
    },
    ({ fields, limit }) => run(() => graphList("me/businesses", { fields }, limit)),
  );
}
