import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { configRoot, profile } from "../shared/env.js";
import { callTool } from "../shared/hub.js";
import { alertText, check, DEFAULT_THRESHOLDS, report, reportHtml, reportMarkdown, type Thresholds } from "./core.js";

export type CheckArgs = { platforms?: string[]; currency?: string; baseline_days?: number; thresholds?: Partial<Thresholds>; ga4?: boolean; slack_channel?: string; send?: boolean; only_if_alerts?: boolean };

export async function runCheck(a: CheckArgs) {
  const r = await check({ platforms: a.platforms, currency: a.currency, baselineDays: a.baseline_days ?? 14, t: { ...DEFAULT_THRESHOLDS, ...a.thresholds }, ga4: a.ga4 ?? true });
  const text = alertText(r, profile ? `Monitor · ${profile}` : undefined);
  let slack: unknown;
  if (a.slack_channel && (!a.only_if_alerts || r.alerts.length)) slack = a.send ? await callTool("slack", "slack_send", { to: a.slack_channel, text, as_bot: true }).catch((e: Error) => ({ error: e.message })) : { preview: true, channel: a.slack_channel, note: "Not sent — pass confirm: true (or --send) to post" };
  return { ...r, message: text, slack };
}

export type ReportArgs = { preset?: string; from?: string; to?: string; currency?: string; revenue_source?: string; top?: number; format?: "markdown" | "html"; save?: boolean; title?: string; slack_channel?: string; sheet?: { spreadsheet_id: string; tab?: string }; send?: boolean };

export async function runReport(a: ReportArgs) {
  const r = await report({ preset: a.preset, from: a.from, to: a.to, currency: a.currency, revenue_source: a.revenue_source ?? "none", top: a.top ?? 5 });
  const title = a.title ?? `Performance report${profile ? ` · ${profile}` : ""}`;
  const md = reportMarkdown(r, title);
  let saved: string | undefined;
  if (a.save) {
    const dir = resolve(configRoot, "reports");
    mkdirSync(dir, { recursive: true });
    saved = resolve(dir, `${r.window.to}${profile ? `-${profile}` : ""}-report.${a.format === "html" ? "html" : "md"}`);
    writeFileSync(saved, a.format === "html" ? reportHtml(md, title) : md);
  }
  const outputs: Record<string, unknown> = {};
  if (a.slack_channel) {
    const summary = md.split("\n## By platform")[0].replace(/^# /, "*").replace(/\n(?=\d{4})/, "*\n").replace(/\*\*/g, "*");
    outputs.slack = a.send ? await callTool("slack", "slack_send", { to: a.slack_channel, text: summary, as_bot: true }).catch((e: Error) => ({ error: e.message })) : { preview: summary };
  }
  if (a.sheet) {
    const row = [r.window.from, r.window.to, r.currency, r.kpis.spend, r.kpis.conversions, r.kpis.value, r.kpis.cpa, r.kpis.roas, r.revenue?.revenue ?? "", r.revenue?.mer ?? ""];
    outputs.sheet = a.send ? await callTool("google-sheets", "sheets_append", { spreadsheet_id: a.sheet.spreadsheet_id, range: `${a.sheet.tab ?? "Weekly"}!A1`, rows: [row] }).catch((e: Error) => ({ error: e.message })) : { preview: row };
  }
  return { report: r, markdown: a.format === "html" ? undefined : md, saved, outputs };
}
