#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv } from "../shared/env.js";
import { googleClient, googleRequest, PROFILES } from "../shared/google-auth.js";
import { pct, PRESETS, previousWindow, window } from "../shared/hub.js";
import { run, startStdio } from "../shared/server.js";

const getClient = googleClient(PROFILES.youtube);
const yt = (url: string, params?: Record<string, unknown>) => googleRequest(getClient, { method: "GET", url, params });
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";
const DATA = "https://www.googleapis.com/youtube/v3";
const channelIds = (c?: string) => `channel==${c ?? (optionalEnv("YOUTUBE_CHANNEL_ID") || "MINE")}`;

type Report = { columnHeaders?: { name: string }[]; rows?: unknown[][] };
const table = (r: Report) => (r.rows ?? []).map((row) => Object.fromEntries((r.columnHeaders ?? []).map((h, i) => [h.name, row[i]])));

async function titles(ids: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const r = (await yt(`${DATA}/videos`, { part: "snippet", id: ids.slice(i, i + 50).join(",") })) as { items?: { id: string; snippet: { title: string } }[] };
    for (const v of r.items ?? []) m.set(v.id, v.snippet.title);
  }
  return m;
}

const server = new McpServer(
  { name: "youtube-analytics", version: "0.1.0" },
  { instructions: "YouTube channel analytics (YouTube Analytics API v2 + Data API v3): channel overview with comparison, top videos, traffic sources, audience (age/gender/country/device), retention for a video, revenue (if monetised), and any custom report. Data lags ~2 days." },
);

const common = { channel: z.string().optional().describe("Channel ID (default your channel / YOUTUBE_CHANNEL_ID)"), preset: z.enum(PRESETS).optional().describe("Default last_30_days"), from: z.string().optional(), to: z.string().optional() };
const METRICS = "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares";

server.registerTool(
  "yt_channel",
  { title: "Channel overview", description: "Your channel(s): title, subscribers, total views and videos, plus the period's views, watch time, average view duration, subscribers gained/lost, likes, comments and shares vs the previous period.", inputSchema: common },
  (a) =>
    run(async () => {
      const w = window(a.preset ?? "last_30_days", a.from, a.to);
      const p = previousWindow(w);
      const [info, now, before] = await Promise.all([
        yt(`${DATA}/channels`, { part: "snippet,statistics", ...(a.channel ? { id: a.channel } : { mine: true }) }) as Promise<{ items?: { id: string; snippet: { title: string }; statistics: Record<string, string> }[] }>,
        yt(ANALYTICS, { ids: channelIds(a.channel), startDate: w.from, endDate: w.to, metrics: METRICS }) as Promise<Report>,
        yt(ANALYTICS, { ids: channelIds(a.channel), startDate: p.from, endDate: p.to, metrics: METRICS }) as Promise<Report>,
      ]);
      const n = table(now)[0] ?? {};
      const b = table(before)[0] ?? {};
      return {
        channel: info.items?.map((c) => ({ id: c.id, title: c.snippet.title, subscribers: Number(c.statistics.subscriberCount), total_views: Number(c.statistics.viewCount), videos: Number(c.statistics.videoCount) })),
        window: w,
        period: n,
        change_pct: Object.fromEntries(Object.keys(n).map((k) => [k, pct(Number(n[k]), Number(b[k]))])),
      };
    }),
);

server.registerTool(
  "yt_top_videos",
  { title: "Top videos", description: "Top videos for the period by views, watch time, subscribers gained or shares — with titles, average view duration and percentage viewed.", inputSchema: { ...common, sort: z.enum(["views", "estimatedMinutesWatched", "subscribersGained", "shares", "likes"]).default("views"), limit: z.number().int().min(1).max(200).default(25) } },
  (a) =>
    run(async () => {
      const w = window(a.preset ?? "last_30_days", a.from, a.to);
      const r = table((await yt(ANALYTICS, { ids: channelIds(a.channel), startDate: w.from, endDate: w.to, dimensions: "video", metrics: METRICS, sort: `-${a.sort}`, maxResults: a.limit })) as Report);
      const names = await titles(r.map((x) => String(x.video)));
      return { window: w, videos: r.map((x) => ({ title: names.get(String(x.video)), url: `https://youtu.be/${x.video}`, ...x })) };
    }),
);

server.registerTool(
  "yt_report",
  {
    title: "Breakdown report",
    description:
      "Views and watch time by traffic source (search, suggested, external, playlists…), search terms, country, device, operating system, playback location, subscribed status, age group × gender, or day — for the channel or one video.",
    inputSchema: {
      ...common,
      by: z.enum(["insightTrafficSourceType", "insightTrafficSourceDetail", "country", "deviceType", "operatingSystem", "insightPlaybackLocationType", "subscribedStatus", "ageGroup,gender", "day", "month", "sharingService"]).default("insightTrafficSourceType"),
      video_id: z.string().optional(),
      traffic_source: z.string().optional().describe("With insightTrafficSourceDetail: YT_SEARCH (search terms), EXT_URL, RELATED_VIDEO…"),
      limit: z.number().int().min(1).max(200).default(50),
    },
  },
  (a) =>
    run(async () => {
      const w = window(a.preset ?? "last_30_days", a.from, a.to);
      const demographic = a.by === "ageGroup,gender";
      const filters = [a.video_id ? `video==${a.video_id}` : "", a.by === "insightTrafficSourceDetail" ? `insightTrafficSourceType==${a.traffic_source ?? "YT_SEARCH"}` : ""].filter(Boolean).join(";");
      const r = (await yt(ANALYTICS, { ids: channelIds(a.channel), startDate: w.from, endDate: w.to, dimensions: a.by, metrics: demographic ? "viewerPercentage" : "views,estimatedMinutesWatched,averageViewDuration", filters: filters || undefined, sort: demographic || /day|month/.test(a.by) ? undefined : "-views", maxResults: /day|month|ageGroup/.test(a.by) ? undefined : a.limit })) as Report;
      return { window: w, by: a.by, rows: table(r) };
    }),
);

server.registerTool(
  "yt_retention",
  { title: "Audience retention", description: "Retention curve for one video: share of viewers still watching at each point (elapsed video ratio) and relative retention vs similar videos — find where people drop off.", inputSchema: { ...common, video_id: z.string() } },
  (a) =>
    run(async () => {
      const w = window(a.preset ?? "last_90_days", a.from, a.to);
      const r = table((await yt(ANALYTICS, { ids: channelIds(a.channel), startDate: w.from, endDate: w.to, dimensions: "elapsedVideoTimeRatio", metrics: "audienceWatchRatio,relativeRetentionPerformance", filters: `video==${a.video_id}` })) as Report);
      const drops = r.slice(1).map((x, i) => ({ at_pct: Math.round(Number(x.elapsedVideoTimeRatio) * 100), drop: Number(r[i].audienceWatchRatio) - Number(x.audienceWatchRatio) })).sort((x, y) => y.drop - x.drop).slice(0, 5);
      return { video: `https://youtu.be/${a.video_id}`, curve: r, biggest_drop_offs: drops };
    }),
);

server.registerTool(
  "yt_revenue",
  { title: "Revenue (monetised channels)", description: "Estimated revenue, ad revenue, YouTube Premium revenue, RPM, CPM and monetised playbacks by day or video.", inputSchema: { ...common, by: z.enum(["day", "video", "country"]).default("day"), limit: z.number().int().min(1).max(200).default(50) } },
  (a) =>
    run(async () => {
      const w = window(a.preset ?? "last_30_days", a.from, a.to);
      return table((await yt(ANALYTICS, { ids: channelIds(a.channel), startDate: w.from, endDate: w.to, dimensions: a.by, metrics: "estimatedRevenue,estimatedAdRevenue,estimatedRedPartnerRevenue,grossRevenue,cpm,playbackBasedCpm,monetizedPlaybacks", sort: a.by === "day" ? "day" : "-estimatedRevenue", maxResults: a.by === "day" ? undefined : a.limit })) as Report);
    }),
);

server.registerTool(
  "yt_api",
  { title: "YouTube API call", description: "Custom YouTube Analytics report (pass params to https://youtubeanalytics.googleapis.com/v2/reports) or any YouTube Data API v3 GET (e.g. https://www.googleapis.com/youtube/v3/playlists).", inputSchema: { url: z.string().url().default(ANALYTICS), params: z.record(z.unknown()) } },
  (a) => run(() => yt(a.url, a.params)),
);

await startStdio(server, "youtube-analytics");
