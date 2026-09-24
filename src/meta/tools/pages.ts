import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { graph, graphList, pageToken, schema } from "../client.js";

export function registerPageTools(server: McpServer): void {
  server.registerTool(
    "meta_list_pages",
    {
      title: "List Facebook Pages",
      description: "List Pages the token manages, with their linked Instagram account.",
      inputSchema: {
        fields: schema.fields("id,name,category,fan_count,followers_count,link,instagram_business_account{id,username}"),
        limit: schema.limit,
      },
    },
    ({ fields, limit }) => run(() => graphList("me/accounts", { fields }, limit)),
  );

  server.registerTool(
    "meta_page_post",
    {
      title: "Publish Page post",
      description: "Publish (or schedule) a text, link or photo post on a Facebook Page.",
      inputSchema: {
        page_id: z.string(),
        message: z.string().optional(),
        link: z.string().url().optional(),
        image_url: z.string().url().optional().describe("Posts a photo instead of a link post"),
        published: z.boolean().default(true),
        scheduled_publish_time: z.number().int().optional().describe("Unix timestamp 10 min–30 days ahead; requires published=false"),
      },
    },
    ({ page_id, image_url, message, ...rest }) =>
      run(async () => {
        const token = await pageToken(page_id);
        if (image_url) {
          return graph("POST", `${page_id}/photos`, { url: image_url, caption: message, ...rest, link: undefined }, token);
        }
        return graph("POST", `${page_id}/feed`, { message, ...rest }, token);
      }),
  );

  server.registerTool(
    "meta_list_page_posts",
    {
      title: "List Page posts",
      description: "List recent posts on a Page.",
      inputSchema: {
        page_id: z.string(),
        fields: schema.fields("id,message,created_time,permalink_url,status_type,shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)"),
        limit: schema.limit,
      },
    },
    ({ page_id, fields, limit }) => run(async () => graphList(`${page_id}/posts`, { fields }, limit, await pageToken(page_id))),
  );

  server.registerTool(
    "meta_page_insights",
    {
      title: "Page / post insights",
      description: "Read insights metrics for a Page or a Page post (e.g. page_impressions_unique, page_post_engagements, post_impressions_unique).",
      inputSchema: {
        page_id: z.string().describe("Page used for the access token"),
        object_id: z.string().optional().describe("Post ID; defaults to the Page itself"),
        metric: z.string().describe("Comma-separated metrics"),
        period: z.enum(["day", "week", "days_28", "month", "lifetime", "total_over_range"]).optional(),
        since: z.string().optional(),
        until: z.string().optional(),
      },
    },
    ({ page_id, object_id, ...params }) =>
      run(async () => graph("GET", `${object_id ?? page_id}/insights`, params, await pageToken(page_id))),
  );

  server.registerTool(
    "meta_list_comments",
    {
      title: "List comments",
      description: "List comments on a Page post, ad post or Instagram media.",
      inputSchema: {
        page_id: z.string().describe("Page used for the access token"),
        object_id: z.string().describe("Post or comment ID"),
        fields: schema.fields("id,from,message,created_time,like_count,comment_count,is_hidden"),
        limit: schema.limit,
      },
    },
    ({ page_id, object_id, fields, limit }) =>
      run(async () => graphList(`${object_id}/comments`, { fields, order: "reverse_chronological" }, limit, await pageToken(page_id))),
  );

  server.registerTool(
    "meta_manage_comment",
    {
      title: "Reply to / hide a comment",
      description: "Reply to, hide or unhide a Facebook comment as the Page.",
      inputSchema: {
        page_id: z.string(),
        comment_id: z.string(),
        action: z.enum(["reply", "hide", "unhide"]),
        message: z.string().optional().describe("Required for reply"),
      },
    },
    ({ page_id, comment_id, action, message }) =>
      run(async () => {
        const token = await pageToken(page_id);
        if (action === "reply") {
          if (!message) throw new Error("message is required to reply");
          return graph("POST", `${comment_id}/comments`, { message }, token);
        }
        return graph("POST", comment_id, { is_hidden: action === "hide" }, token);
      }),
  );

  server.registerTool(
    "meta_list_lead_forms",
    {
      title: "List lead forms",
      description: "List Instant Forms (lead gen forms) on a Page.",
      inputSchema: {
        page_id: z.string(),
        fields: schema.fields("id,name,status,leads_count,created_time,questions"),
        limit: schema.limit,
      },
    },
    ({ page_id, fields, limit }) => run(async () => graphList(`${page_id}/leadgen_forms`, { fields }, limit, await pageToken(page_id))),
  );

  server.registerTool(
    "meta_get_leads",
    {
      title: "Get leads",
      description: "Download submitted leads from a lead form (or an ad).",
      inputSchema: {
        page_id: z.string().describe("Page that owns the form"),
        form_id: z.string().describe("Lead form ID or ad ID"),
        since: z.number().int().optional().describe("Only leads created after this Unix timestamp"),
        fields: schema.fields("id,created_time,field_data,ad_id,ad_name,campaign_name,form_id,platform"),
        limit: schema.limit,
      },
    },
    ({ page_id, form_id, since, fields, limit }) =>
      run(async () =>
        graphList(
          `${form_id}/leads`,
          { fields, filtering: since ? [{ field: "time_created", operator: "GREATER_THAN", value: since }] : undefined },
          limit,
          await pageToken(page_id),
        ),
      ),
  );
}
