#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profile } from "../shared/env.js";
import { closeChildren, PRESETS } from "../shared/hub.js";
import { run, startStdio } from "../shared/server.js";
import { projectRoot } from "../shared/servers.js";
import { runCheck, runReport } from "./actions.js";

const server = new McpServer(
  { name: "monitor", version: "0.1.0" },
  {
    instructions:
      "Anomaly alerts and scheduled reports across every connected ad platform and GA4. monitor_check compares yesterday with the median of the previous 14 days (spend spikes/drops, zero conversions, CPA/ROAS swings, GA4 sessions/purchases collapsing). monitor_report builds a period report (Markdown/HTML, Slack, Google Sheets). monitor_schedule writes a macOS launchd job or cron line so both run automatically. Posting to Slack/Sheets needs confirm: true.",
  },
);

const thresholds = z
  .object({ spend_spike_pct: z.number(), spend_drop_pct: z.number(), cpa_jump_pct: z.number(), roas_drop_pct: z.number(), conversions_drop_pct: z.number(), sessions_drop_pct: z.number(), min_baseline_spend: z.number() })
  .partial()
  .optional()
  .describe("Defaults: spend +50% / −60%, CPA +40%, ROAS −40%, conversions −60%, GA4 sessions −40%, ignore platforms under 10/day");

server.registerTool(
  "monitor_check",
  {
    title: "Anomaly check",
    description:
      "Yesterday vs the usual day (median of the previous 14): spend spikes and drops (incl. a platform that stopped spending), spend with zero conversions (tracking break), conversion drops, CPA jumps, ROAS drops, and GA4 sessions or purchases collapsing. Returns alerts and a ready Slack message; posts it with slack_channel + confirm.",
    inputSchema: { platforms: z.array(z.string()).optional(), currency: z.string().length(3).optional(), baseline_days: z.number().int().min(3).max(60).default(14), thresholds, ga4: z.boolean().default(true), slack_channel: z.string().optional().describe("#channel to post to"), only_if_alerts: z.boolean().default(false), confirm: z.boolean().default(false) },
  },
  (a) => run(() => runCheck({ ...a, send: a.confirm })),
);

server.registerTool(
  "monitor_report",
  {
    title: "Period report",
    description:
      "Report for a period vs the previous one: blended spend, conversions, value, CPA, ROAS with change, store revenue and MER, platform split, best and highest-CPA campaigns, GA4 comparison. Returns Markdown; can save Markdown/HTML under reports/, post a summary to Slack, or append a row to Google Sheets (posting needs confirm).",
    inputSchema: {
      preset: z.enum(PRESETS).optional().describe("Default last_7_days"),
      from: z.string().optional(),
      to: z.string().optional(),
      currency: z.string().length(3).optional(),
      revenue_source: z.enum(["none", "ga4", "shopify", "woocommerce"]).default("none"),
      top: z.number().int().min(1).max(50).default(5),
      format: z.enum(["markdown", "html"]).default("markdown"),
      save: z.boolean().default(false),
      title: z.string().optional(),
      slack_channel: z.string().optional(),
      sheet: z.object({ spreadsheet_id: z.string(), tab: z.string().optional() }).optional(),
      confirm: z.boolean().default(false),
    },
  },
  (a) => run(() => runReport({ ...a, send: a.confirm })),
);

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

server.registerTool(
  "monitor_schedule",
  {
    title: "Schedule checks and reports",
    description:
      "Creates a macOS launchd job (and prints the equivalent cron line) that runs the anomaly check daily or the report weekly, posting to Slack. It writes the job file under schedules/ and shows the one command to activate it — nothing is installed automatically.",
    inputSchema: {
      job: z.enum(["check", "report"]),
      when: z.string().describe("\"daily 09:00\" or \"weekly monday 09:00\""),
      slack_channel: z.string().optional(),
      revenue_source: z.enum(["none", "ga4", "shopify", "woocommerce"]).default("none"),
      save_html: z.boolean().default(false).describe("report: also save an HTML file under reports/"),
      only_if_alerts: z.boolean().default(true).describe("check: post only when something is wrong"),
    },
  },
  (a) =>
    run(async () => {
      const m = a.when.trim().toLowerCase().match(/^(daily|weekly)(?:\s+(\w+))?\s+(\d{1,2}):(\d{2})$/);
      if (!m) throw new Error('Use "daily HH:MM" or "weekly <weekday> HH:MM"');
      const [, freq, dayName, hh, mm] = m;
      const weekday = freq === "weekly" ? DAYS.indexOf(dayName ?? "") : -1;
      if (freq === "weekly" && weekday < 0) throw new Error("Weekly schedules need a weekday, e.g. weekly monday 09:00");
      const label = `com.analyticsdev.mcp.${a.job}${profile ? `.${profile}` : ""}`;
      const args = [process.execPath, resolve(projectRoot, "dist/monitor/cli.js"), a.job, "--send", ...(a.slack_channel ? ["--slack", a.slack_channel] : []), ...(a.job === "check" && a.only_if_alerts ? ["--only-if-alerts"] : []), ...(a.job === "report" ? ["--revenue", a.revenue_source, ...(a.save_html ? ["--save", "--html"] : [])] : [])];
      const cal = `<dict><key>Hour</key><integer>${Number(hh)}</integer><key>Minute</key><integer>${Number(mm)}</integer>${weekday >= 0 ? `<key>Weekday</key><integer>${weekday}</integer>` : ""}</dict>`;
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((x) => `<string>${x.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${projectRoot}</string>
${profile ? `<key>EnvironmentVariables</key><dict><key>MCP_PROFILE</key><string>${profile}</string></dict>` : ""}
<key>StartCalendarInterval</key>${cal}
<key>StandardOutPath</key><string>${resolve(projectRoot, "schedules", `${label}.log`)}</string>
<key>StandardErrorPath</key><string>${resolve(projectRoot, "schedules", `${label}.log`)}</string>
</dict></plist>
`;
      const dir = resolve(projectRoot, "schedules");
      mkdirSync(dir, { recursive: true });
      const file = resolve(dir, `${label}.plist`);
      writeFileSync(file, plist);
      const cron = `${Number(mm)} ${Number(hh)} * * ${weekday >= 0 ? weekday : "*"} cd ${JSON.stringify(projectRoot)} && ${profile ? `MCP_PROFILE=${profile} ` : ""}${args.map((x) => JSON.stringify(x)).join(" ")}`;
      return {
        written: file,
        activate_macos: `cp ${JSON.stringify(file)} ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`,
        deactivate_macos: `launchctl bootout gui/$(id -u)/${label} && rm ~/Library/LaunchAgents/${label}.plist`,
        cron_alternative: cron,
        test_now: args.filter((x) => x !== "--send").map((x) => JSON.stringify(x)).join(" "),
        note: "Scheduled runs post without asking (that's what scheduling means) — run the test_now command first to see the output.",
      };
    }),
);

process.stdin.on("close", () => void closeChildren());
await startStdio(server, "monitor");
