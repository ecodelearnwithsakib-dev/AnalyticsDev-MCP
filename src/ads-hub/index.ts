#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { closeChildren, daysBetween, pct, PRESETS, previousWindow, round, window, ymd } from "../shared/hub.js";
import { run, startStdio } from "../shared/server.js";
import { ADAPTERS } from "./adapters.js";
import { add, byPlatform, collect, emptyTotals, matches, METRICS, normalize, pickAdapters, ratios, revenue, targetCurrency, type Rule } from "./core.js";

const server = new McpServer(
  { name: "ads-hub", version: "0.1.0" },
  {
    instructions:
      "Cross-platform ads: one currency across Meta, Google Ads, Microsoft Ads, OpenAI Ads, Reddit and any other connected ads server. ads_report = blended totals, platform split, top campaigns, MER vs store revenue; ads_daily = trends; ads_rules = find (and optionally pause) campaigns that break rules, dry-run by default; ads_pacing = month-to-date spend vs budget. Platforms that aren't configured are skipped and listed.",
  },
);

const common = {
  platforms: z.array(z.string()).optional().describe("Default: every configured platform (see ads_platforms)"),
  preset: z.enum(PRESETS).optional().describe("Default last_7_days (complete days)"),
  from: z.string().optional().describe("YYYY-MM-DD"),
  to: z.string().optional().describe("YYYY-MM-DD"),
  currency: z.string().length(3).optional().describe("Report currency, e.g. BDT or USD (default ADS_HUB_CURRENCY or the first platform's)"),
  conversion: z.enum(["purchase", "lead", "primary"]).default("purchase").describe("Which conversions to count where the platform lets us choose (Meta); others use their primary conversions"),
};

server.registerTool(
  "ads_platforms",
  {
    title: "Connected ad platforms",
    description: "Which ad platforms are connected (keys present in .env / the active profile) and which aren't, with the variables each needs.",
    inputSchema: {},
  },
  () =>
    run(async () =>
      ADAPTERS.map((a) => ({ platform: a.key, name: a.title, server: a.dir, connected: a.isConfigured() })),
    ),
);

server.registerTool(
  "ads_report",
  {
    title: "Blended ads report",
    description:
      "One report across every connected ad platform in a single currency: blended spend, impressions, clicks, conversions, value, CTR, CPC, CPA, ROAS; per-platform split with share of spend; top campaigns across platforms; change vs the previous period; and MER / blended ROAS against real store revenue from GA4, Shopify or WooCommerce.",
    inputSchema: {
      ...common,
      level: z.enum(["account", "campaign"]).default("campaign"),
      compare: z.boolean().default(true),
      revenue_source: z.enum(["none", "ga4", "shopify", "woocommerce"]).default("none").describe("Store revenue for MER (marketing efficiency ratio)"),
      top: z.number().int().min(0).max(200).default(15),
      sort_by: z.enum(["spend", "conversions", "value", "roas", "cpa"]).default("spend"),
    },
  },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const adapters = pickAdapters(a.platforms);
      if (!adapters.length) throw new Error("No ad platform is configured — see ads_platforms");
      const [now, before] = await Promise.all([
        collect(adapters, { ...w, level: a.level, daily: false, conversion: a.conversion }),
        a.compare ? collect(adapters, { ...previousWindow(w), level: "account", daily: false, conversion: a.conversion }) : undefined,
      ]);
      const currency = targetCurrency(a.currency, now.rows);
      const rows = await normalize(now.rows, currency);
      const prev = before ? await normalize(before.rows, currency) : [];
      const total = rows.reduce((t, r) => add(t, r), emptyTotals());
      const prevTotal = prev.reduce((t, r) => add(t, r), emptyTotals());
      const split = [...byPlatform(rows)].map(([p, t]) => ({ platform: p, ...ratios(t), share_of_spend_pct: total.spend ? round((t.spend / total.spend) * 100, 1) : 0 })).sort((x, y) => y.spend - x.spend);
      const rev = a.revenue_source !== "none" ? await revenue(a.revenue_source, w.from, w.to, currency).catch((e: Error) => ({ source: a.revenue_source as string, revenue: 0, orders: undefined as number | undefined, note: e.message })) : undefined;
      const blended = ratios(total);
      const campaigns = a.level === "campaign"
        ? rows
            .map((r) => ({ platform: r.platform, id: r.id, name: r.name, status: r.status, ...ratios(r) }))
            .sort((x, y) => (a.sort_by === "cpa" ? (x.cpa ?? Infinity) - (y.cpa ?? Infinity) : Number(y[a.sort_by] ?? 0) - Number(x[a.sort_by] ?? 0)))
            .slice(0, a.top)
        : undefined;
      return {
        window: w,
        currency,
        blended,
        change_vs_previous: before
          ? { previous: previousWindow(w), spend_pct: pct(total.spend, prevTotal.spend), conversions_pct: pct(total.conversions, prevTotal.conversions), value_pct: pct(total.value, prevTotal.value), cpa_pct: blended.cpa && prevTotal.conversions ? pct(blended.cpa, prevTotal.spend / prevTotal.conversions) : null, roas_pct: blended.roas && prevTotal.spend ? pct(blended.roas, prevTotal.value / prevTotal.spend) : null }
          : undefined,
        store_revenue: rev && { ...rev, mer: total.spend ? round(rev.revenue / total.spend) : null, blended_cac: rev.orders && total.spend ? round(total.spend / rev.orders) : null, platform_reported_value_vs_revenue_pct: rev.revenue ? round((total.value / rev.revenue) * 100, 1) : null },
        platforms: split,
        top_campaigns: campaigns,
        not_connected: ADAPTERS.filter((x) => !x.isConfigured()).map((x) => x.key),
        errors: Object.keys(now.errors).length ? now.errors : undefined,
        notes: ["Conversions and value are each platform's own attribution (they overlap); use store_revenue / MER for the true total.", ...(rows.some((r) => r.native_currency !== currency) ? [`Converted to ${currency} at today's rates (override with FX_RATES).`] : [])],
      };
    }),
);

server.registerTool(
  "ads_daily",
  {
    title: "Daily trend across platforms",
    description: "Day-by-day spend, conversions, value, CPA and ROAS per platform and blended, in one currency — for charts, anomaly spotting and pacing.",
    inputSchema: { ...common, preset: z.enum(PRESETS).optional().describe("Default last_14_days") },
  },
  (a) =>
    run(async () => {
      const w = window(a.preset ?? "last_14_days", a.from, a.to);
      const got = await collect(pickAdapters(a.platforms), { ...w, level: "account", daily: true, conversion: a.conversion });
      const currency = targetCurrency(a.currency, got.rows);
      const rows = await normalize(got.rows, currency);
      const days = new Map<string, Map<string, ReturnType<typeof emptyTotals>>>();
      for (const r of rows) {
        const d = r.date ?? "unknown";
        const m = days.get(d) ?? days.set(d, new Map()).get(d)!;
        add(m.get(r.platform) ?? m.set(r.platform, emptyTotals()).get(r.platform)!, r);
      }
      return {
        window: w,
        currency,
        days: [...days.keys()].sort().map((d) => {
          const per = days.get(d)!;
          const blended = [...per.values()].reduce((t, x) => add(t, x), emptyTotals());
          return { date: d, ...ratios(blended), by_platform: Object.fromEntries([...per].map(([p, t]) => [p, { spend: round(t.spend), conversions: round(t.conversions), value: round(t.value) }])) };
        }),
        errors: Object.keys(got.errors).length ? got.errors : undefined,
      };
    }),
);

const condition = z.object({ metric: z.enum(METRICS), op: z.enum([">", ">=", "<", "<=", "==", "!="]), value: z.number() });
const ruleSchema = z.object({
  name: z.string(),
  when: z.array(condition).min(1).describe("All conditions must hold (AND). Money in the report currency; ctr/cvr in %"),
  min_spend: z.number().optional().describe("Ignore campaigns that spent less"),
  platforms: z.array(z.string()).optional(),
  action: z.enum(["pause", "flag"]).default("flag"),
});

server.registerTool(
  "ads_rules",
  {
    title: "Rules engine across platforms",
    description:
      "Evaluate rules on every campaign across platforms in one currency, e.g. “CPA > 500 BDT with spend ≥ 1,000 → pause”, “ROAS < 1.5 over 14 days → flag”, “spend > 0 and conversions == 0 → flag”. Always shows matches first (dry run); pausing happens only with apply: true and confirm: true, per platform.",
    inputSchema: { ...common, rules: z.array(ruleSchema).min(1), apply: z.boolean().default(false), confirm: z.boolean().default(false) },
  },
  (a) =>
    run(async () => {
      const w = window(a.preset, a.from, a.to);
      const adapters = pickAdapters(a.platforms);
      const got = await collect(adapters, { ...w, level: "campaign", daily: false, conversion: a.conversion });
      const currency = targetCurrency(a.currency, got.rows);
      const rows = await normalize(got.rows, currency);
      const hits: { rule: string; action: string; platform: string; id: string; name: string; metrics: ReturnType<typeof ratios>; row: (typeof rows)[number] }[] = [];
      for (const rule of a.rules as Rule[])
        for (const r of rows) {
          if (rule.platforms?.length && !rule.platforms.includes(r.platform)) continue;
          if (rule.min_spend !== undefined && r.spend < rule.min_spend) continue;
          if (r.status && /PAUSED|REMOVED|ARCHIVED|DELETED/i.test(r.status)) continue;
          const m = ratios(r);
          if (rule.when.every((c) => matches(m, c))) hits.push({ rule: rule.name, action: rule.action, platform: r.platform, id: r.id, name: r.name, metrics: m, row: r });
        }
      const toPause = hits.filter((h) => h.action === "pause");
      let applied: Record<string, unknown> | undefined;
      if (a.apply) {
        if (!a.confirm) throw new Error(`${toPause.length} campaign(s) would be paused — review the dry run, then pass apply: true and confirm: true`);
        applied = {};
        for (const ad of adapters) {
          const mine = [...new Map(toPause.filter((h) => h.platform === ad.key).map((h) => [h.id, h.row])).values()];
          if (!mine.length) continue;
          applied[ad.key] = ad.pause ? await ad.pause(mine).catch((e: Error) => ({ error: e.message })) : { error: "pausing isn't supported for this platform" };
        }
      }
      return {
        window: w,
        currency,
        dry_run: !a.apply,
        evaluated_campaigns: rows.length,
        matches: hits.map(({ row: _r, ...h }) => h),
        would_pause: a.apply ? undefined : toPause.map((h) => `${h.platform}: ${h.name}`),
        applied,
        errors: Object.keys(got.errors).length ? got.errors : undefined,
      };
    }),
);

server.registerTool(
  "ads_pacing",
  {
    title: "Budget pacing",
    description:
      "Month-to-date spend vs monthly budget, per platform and in total: days elapsed and left, projected month-end spend at the current daily rate, over/under pace, and the daily spend needed to land on budget.",
    inputSchema: {
      platforms: common.platforms,
      currency: common.currency,
      budgets: z.record(z.number()).describe("Monthly budget per platform in the report currency, e.g. {\"meta\": 300000, \"google\": 200000} or {\"total\": 500000}"),
      month: z.string().optional().describe("YYYY-MM (default this month)"),
    },
  },
  (a) =>
    run(async () => {
      const now = new Date();
      const [y, m] = (a.month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`).split("-").map(Number);
      const first = ymd(new Date(y, m - 1, 1));
      const last = ymd(new Date(y, m, 0));
      const today = ymd(now);
      const to = today < last ? ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)) : last;
      const daysInMonth = daysBetween(first, last);
      const elapsed = to < first ? 0 : daysBetween(first, to);
      const left = daysInMonth - elapsed;
      const got = await collect(pickAdapters(a.platforms), { from: first, to: to < first ? first : to, level: "account", daily: false, conversion: "primary" });
      const currency = targetCurrency(a.currency, got.rows);
      const rows = await normalize(got.rows, currency);
      const spent = byPlatform(rows);
      const line = (name: string, sp: number, budget?: number) => {
        const daily = elapsed ? sp / elapsed : 0;
        const projected = sp + daily * left;
        return {
          platform: name,
          budget: budget ?? null,
          spent: round(sp),
          spent_pct: budget ? round((sp / budget) * 100, 1) : null,
          expected_pct_by_now: round((elapsed / daysInMonth) * 100, 1),
          projected_month_end: round(projected),
          projected_vs_budget_pct: budget ? round((projected / budget) * 100, 1) : null,
          status: !budget ? "no budget set" : projected > budget * 1.05 ? "over pace" : projected < budget * 0.9 ? "under pace" : "on pace",
          daily_needed: budget && left ? round(Math.max(0, budget - sp) / left) : null,
          current_daily: round(daily),
        };
      };
      const total = [...spent.values()].reduce((s, t) => s + t.spend, 0);
      return {
        month: `${y}-${String(m).padStart(2, "0")}`,
        through: to,
        days: { in_month: daysInMonth, elapsed, left },
        currency,
        platforms: [...spent].map(([p, t]) => line(p, t.spend, a.budgets[p])),
        total: line("total", total, a.budgets.total ?? (Object.keys(a.budgets).length ? Object.values(a.budgets).reduce((s, v) => s + v, 0) : undefined)),
        errors: Object.keys(got.errors).length ? got.errors : undefined,
      };
    }),
);

process.on("SIGTERM", () => void closeChildren().then(() => process.exit(0)));
process.stdin.on("close", () => void closeChildren());

await startStdio(server, "ads-hub");
