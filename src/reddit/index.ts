#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { optionalEnv } from "../shared/env.js";
import { run, startStdio } from "../shared/server.js";
import { ads, reddit } from "./client.js";
import { registerAdsTools } from "./tools/ads.js";
import { registerCommunityTools } from "./tools/community.js";

const server = new McpServer(
  { name: "reddit", version: "0.1.0" },
  {
    instructions:
      "Reddit with one sign-in: reddit_ads_* use the Reddit Ads API v3 (reports, campaigns, targeting, Conversions API, audiences); the other tools use the Data API as the signed-in user (search/listening, subreddits, threads, posting, inbox, moderation). Money in Ads is shown in account currency (converted from micros). Posting, commenting, messaging, removals and real conversion events need confirm: true — always show the user the text before posting publicly and respect subreddit rules.",
  },
);

registerAdsTools(server);
registerCommunityTools(server);

server.registerTool(
  "reddit_health",
  { title: "Connection check", description: "Check the Reddit sign-in: account name and karma (Data API) and Ads API access (businesses, default ad account).", inputSchema: {} },
  () =>
    run(async () => {
      const [me, adsMe] = await Promise.all([
        reddit<Record<string, unknown>>("/api/v1/me").then((u) => ({ name: u.name, karma: u.total_karma })).catch((e: Error) => ({ error: e.message })),
        ads<{ data?: Record<string, unknown>[] }>("/me/businesses").then((r) => ({ businesses: (r.data ?? []).map((b) => ({ id: b.id, name: b.name })) })).catch((e: Error) => ({ error: e.message })),
      ]);
      return { community_api: me, ads_api: adsMe, default_ad_account: optionalEnv("REDDIT_AD_ACCOUNT_ID") || undefined, default_pixel: optionalEnv("REDDIT_PIXEL_ID") || undefined };
    }),
);

await startStdio(server, "reddit");
