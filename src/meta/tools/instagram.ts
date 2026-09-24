import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { graph, graphList, schema } from "../client.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function registerInstagramTools(server: McpServer): void {
  server.registerTool(
    "meta_ig_accounts",
    {
      title: "List Instagram accounts",
      description: "List Instagram professional accounts linked to the token's Pages.",
      inputSchema: { limit: schema.limit },
    },
    ({ limit }) =>
      run(async () => {
        const pages = await graphList(
          "me/accounts",
          { fields: "id,name,instagram_business_account{id,username,name,followers_count,media_count}" },
          limit,
        );
        return (pages.data as { id: string; name: string; instagram_business_account?: unknown }[])
          .filter((p) => p.instagram_business_account)
          .map((p) => ({ page_id: p.id, page_name: p.name, instagram: p.instagram_business_account }));
      }),
  );

  server.registerTool(
    "meta_ig_list_media",
    {
      title: "List Instagram media",
      description: "List recent posts/reels of an Instagram account.",
      inputSchema: {
        ig_user_id: z.string(),
        fields: schema.fields("id,caption,media_type,media_product_type,media_url,permalink,timestamp,like_count,comments_count"),
        limit: schema.limit,
      },
    },
    ({ ig_user_id, fields, limit }) => run(() => graphList(`${ig_user_id}/media`, { fields }, limit)),
  );

  server.registerTool(
    "meta_ig_publish",
    {
      title: "Publish to Instagram",
      description:
        "Publish an image post, reel or story to Instagram. Media must be a public URL (JPEG for images, MP4 for video). Carousels: use meta_graph_request.",
      inputSchema: {
        ig_user_id: z.string(),
        media_type: z.enum(["IMAGE", "REELS", "STORIES"]).default("IMAGE"),
        image_url: z.string().url().optional(),
        video_url: z.string().url().optional(),
        caption: z.string().optional(),
        share_to_feed: z.boolean().optional().describe("Reels only"),
      },
    },
    ({ ig_user_id, media_type, image_url, video_url, caption, share_to_feed }) =>
      run(async () => {
        if (!image_url && !video_url) throw new Error("Provide image_url or video_url");
        const container = (await graph("POST", `${ig_user_id}/media`, {
          media_type: media_type === "IMAGE" ? undefined : media_type,
          image_url,
          video_url,
          caption,
          share_to_feed,
        })) as { id: string };

        // Videos are processed asynchronously; wait until the container is ready (max ~2 min).
        for (let i = 0; i < 24; i++) {
          const { status_code } = (await graph("GET", container.id, { fields: "status_code" })) as { status_code?: string };
          if (status_code === "FINISHED" || !status_code) break;
          if (status_code === "ERROR" || status_code === "EXPIRED") throw new Error(`Media container ${status_code}`);
          await sleep(5000);
        }
        return graph("POST", `${ig_user_id}/media_publish`, { creation_id: container.id });
      }),
  );

  server.registerTool(
    "meta_ig_insights",
    {
      title: "Instagram insights",
      description:
        "Insights for an Instagram account (e.g. reach, follower_count, profile_views, accounts_engaged) or a media item (e.g. reach, likes, comments, saved, shares, views).",
      inputSchema: {
        object_id: z.string().describe("IG user ID or media ID"),
        metric: z.string(),
        period: z.enum(["day", "week", "days_28", "lifetime"]).optional(),
        metric_type: z.enum(["time_series", "total_value"]).optional(),
        breakdown: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
      },
    },
    ({ object_id, ...params }) => run(() => graph("GET", `${object_id}/insights`, params)),
  );
}
