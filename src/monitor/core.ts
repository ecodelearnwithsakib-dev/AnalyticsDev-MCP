import { add, byPlatform, collect, emptyTotals, normalize, pickAdapters, ratios, revenue, targetCurrency } from "../ads-hub/core.js";
import { addDays, callTool, configured, pct, previousWindow, round, window, ymd } from "../shared/hub.js";

export type Alert = { severity: "critical" | "high" | "medium" | "info"; source: string; metric: string; message: string; yesterday: number | null; baseline: number | null; change_pct: number | null };

export type Thresholds = { spend_spike_pct: number; spend_drop_pct: number; cpa_jump_pct: number; roas_drop_pct: number; conversions_drop_pct: number; sessions_drop_pct: number; min_baseline_spend: number };
export const DEFAULT_THRESHOLDS: Thresholds = { spend_spike_pct: 50, spend_drop_pct: 60, cpa_jump_pct: 40, roas_drop_pct: 40, conversions_drop_pct: 60, sessions_drop_pct: 40, min_baseline_spend: 10 };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** Yesterday vs the median of the previous `baselineDays` days, per platform and for GA4. */
export async function check(o: { platforms?: string[]; currency?: string; baselineDays: number; t: Thresholds; ga4: boolean; day?: string }) {
  const day = o.day ?? addDays(ymd(new Date()), -1);
  const from = addDays(day, -o.baselineDays);
  const alerts: Alert[] = [];
  const adapters = pickAdapters(o.platforms);
  const got = adapters.length ? await collect(adapters, { from, to: day, level: "account", daily: true, conversion: "purchase" }) : { rows: [], errors: {}, platforms: [] };
  const currency = targetCurrency(o.currency, got.rows);
  const rows = await normalize(got.rows, currency);
  const series = new Map<string, Map<string, ReturnType<typeof emptyTotals>>>();
  for (const r of rows) {
    const s = series.get(r.platform) ?? series.set(r.platform, new Map()).get(r.platform)!;
    add(s.get(r.date ?? "") ?? s.set(r.date ?? "", emptyTotals()).get(r.date ?? "")!, r);
  }
  const push = (a: Omit<Alert, "change_pct">) => alerts.push({ ...a, change_pct: a.baseline ? round(((Number(a.yesterday) - a.baseline) / a.baseline) * 100, 1) : null });
  for (const [platform, days] of series) {
    const y = days.get(day) ?? emptyTotals();
    const base = [...days.entries()].filter(([d]) => d !== day).map(([, t]) => t);
    const spendB = median(base.map((t) => t.spend));
    const convB = median(base.map((t) => t.conversions));
    const cpaB = median(base.filter((t) => t.conversions).map((t) => t.spend / t.conversions));
    const roasB = median(base.filter((t) => t.spend).map((t) => t.value / t.spend));
    if (spendB >= o.t.min_baseline_spend) {
      if (y.spend > spendB * (1 + o.t.spend_spike_pct / 100)) push({ severity: "high", source: platform, metric: "spend", message: `Spend spiked on ${platform}`, yesterday: round(y.spend), baseline: round(spendB) });
      if (y.spend < spendB * (1 - o.t.spend_drop_pct / 100)) push({ severity: y.spend === 0 ? "critical" : "medium", source: platform, metric: "spend", message: y.spend === 0 ? `${platform} stopped spending (billing, disapprovals or paused campaigns?)` : `Spend dropped on ${platform}`, yesterday: round(y.spend), baseline: round(spendB) });
      if (convB >= 1 && y.conversions === 0 && y.spend > 0) push({ severity: "critical", source: platform, metric: "conversions", message: `${platform} spent but recorded zero conversions — possible tracking break`, yesterday: 0, baseline: round(convB) });
      else if (convB >= 3 && y.conversions < convB * (1 - o.t.conversions_drop_pct / 100)) push({ severity: "high", source: platform, metric: "conversions", message: `Conversions fell on ${platform}`, yesterday: round(y.conversions), baseline: round(convB) });
      if (cpaB && y.conversions && y.spend / y.conversions > cpaB * (1 + o.t.cpa_jump_pct / 100)) push({ severity: "medium", source: platform, metric: "cpa", message: `CPA jumped on ${platform}`, yesterday: round(y.spend / y.conversions), baseline: round(cpaB) });
      if (roasB && y.spend && y.value / y.spend < roasB * (1 - o.t.roas_drop_pct / 100)) push({ severity: "medium", source: platform, metric: "roas", message: `ROAS dropped on ${platform}`, yesterday: round(y.value / y.spend), baseline: round(roasB) });
    }
  }
  let ga4: Record<string, unknown> | undefined;
  if (o.ga4 && configured("GA4_PROPERTY_ID")) {
    try {
      const r = await callTool<{ rows?: Record<string, string>[] }>("ga4", "ga4_run_report", { dimensions: ["date"], metrics: ["sessions", "transactions", "purchaseRevenue", "keyEvents"], start_date: from, end_date: day, limit: 100, order_by: "date", order_desc: false });
      const byDay = new Map((r.rows ?? []).map((x) => [`${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}`, x]));
      const y = byDay.get(day);
      const base = [...byDay.entries()].filter(([d]) => d !== day).map(([, x]) => x);
      const sB = median(base.map((x) => Number(x.sessions)));
      const tB = median(base.map((x) => Number(x.transactions)));
      const ys = Number(y?.sessions ?? 0);
      const yt = Number(y?.transactions ?? 0);
      if (sB > 20 && ys < sB * (1 - o.t.sessions_drop_pct / 100)) push({ severity: ys === 0 ? "critical" : "high", source: "ga4", metric: "sessions", message: ys === 0 ? "GA4 recorded no sessions — the tag may be broken or removed" : "GA4 sessions dropped sharply (tracking or traffic issue)", yesterday: ys, baseline: round(sB) });
      if (tB >= 1 && yt === 0) push({ severity: "critical", source: "ga4", metric: "transactions", message: "GA4 recorded zero purchases — check the purchase event / checkout", yesterday: 0, baseline: round(tB) });
      ga4 = { yesterday: y, baseline: { sessions: round(sB), transactions: round(tB) } };
    } catch (e) {
      ga4 = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  const order = ["critical", "high", "medium", "info"];
  alerts.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const today = [...series].map(([p, d]) => ({ platform: p, ...ratios(d.get(day) ?? emptyTotals()) }));
  return { day, baseline: { from, to: addDays(day, -1), method: "median" }, currency, alerts, yesterday: today, ga4, errors: Object.keys(got.errors).length ? got.errors : undefined };
}

export function alertText(r: Awaited<ReturnType<typeof check>>, title = "Ads & tracking monitor") {
  const icon = { critical: "🔴", high: "🟠", medium: "🟡", info: "🔵" };
  const lines = [`*${title} — ${r.day}*`];
  if (!r.alerts.length) lines.push("✅ No anomalies against the last-14-day baseline.");
  for (const a of r.alerts) lines.push(`${icon[a.severity]} ${a.message}: ${a.yesterday}${a.baseline !== null ? ` vs ${a.baseline} usual` : ""}${a.change_pct !== null ? ` (${a.change_pct > 0 ? "+" : ""}${a.change_pct}%)` : ""}`);
  const spend = r.yesterday.reduce((s, p) => s + p.spend, 0);
  if (r.yesterday.length) lines.push(`Spend yesterday: ${round(spend).toLocaleString("en-US")} ${r.currency} across ${r.yesterday.map((p) => p.platform).join(", ")}`);
  return lines.join("\n");
}

/** Weekly (or any period) report: blended KPIs with change, platform split, top and bottom campaigns, GA4 and store revenue. */
export async function report(o: { preset?: string; from?: string; to?: string; currency?: string; revenue_source: string; top: number }) {
  const w = window(o.preset ?? "last_7_days", o.from, o.to);
  const prevW = previousWindow(w);
  const adapters = pickAdapters();
  const [now, before] = await Promise.all([collect(adapters, { ...w, level: "campaign", daily: false, conversion: "purchase" }), collect(adapters, { ...prevW, level: "account", daily: false, conversion: "purchase" })]);
  const currency = targetCurrency(o.currency, now.rows);
  const rows = await normalize(now.rows, currency);
  const prev = await normalize(before.rows, currency);
  const t = rows.reduce((s, r) => add(s, r), emptyTotals());
  const p = prev.reduce((s, r) => add(s, r), emptyTotals());
  const k = ratios(t);
  const kp = ratios(p);
  const rev = o.revenue_source !== "none" ? await revenue(o.revenue_source, w.from, w.to, currency).catch(() => undefined) : undefined;
  const revPrev = o.revenue_source !== "none" ? await revenue(o.revenue_source, prevW.from, prevW.to, currency).catch(() => undefined) : undefined;
  let ga4: Record<string, unknown> | undefined;
  if (configured("GA4_PROPERTY_ID")) {
    const g = await callTool<{ rows?: Record<string, string>[] }>("ga4", "ga4_run_report", { dimensions: [], metrics: ["sessions", "totalUsers", "keyEvents", "transactions", "purchaseRevenue"], start_date: w.from, end_date: w.to, compare_start_date: prevW.from, compare_end_date: prevW.to, limit: 5 }).catch(() => undefined);
    if (g?.rows) ga4 = { rows: g.rows };
  }
  const campaigns = rows.map((r) => ({ platform: r.platform, name: r.name, ...ratios(r) }));
  return {
    window: w,
    previous: prevW,
    currency,
    kpis: k,
    change_pct: { spend: pct(k.spend, kp.spend), conversions: pct(k.conversions, kp.conversions), value: pct(k.value, kp.value), cpa: k.cpa && kp.cpa ? pct(k.cpa, kp.cpa) : null, roas: k.roas && kp.roas ? pct(k.roas, kp.roas) : null },
    revenue: rev && { ...rev, mer: t.spend ? round(rev.revenue / t.spend) : null, change_pct: revPrev ? pct(rev.revenue, revPrev.revenue) : null },
    platforms: [...byPlatform(rows)].map(([pl, tt]) => ({ platform: pl, ...ratios(tt), share_pct: t.spend ? round((tt.spend / t.spend) * 100, 1) : 0 })).sort((a, b) => b.spend - a.spend),
    top_campaigns: [...campaigns].sort((a, b) => b.value - a.value || b.conversions - a.conversions).slice(0, o.top),
    worst_campaigns: campaigns.filter((c) => c.spend > 0).sort((a, b) => (b.cpa ?? Infinity) - (a.cpa ?? Infinity) || b.spend - a.spend).slice(0, o.top),
    ga4,
    errors: Object.keys(now.errors).length ? now.errors : undefined,
  };
}

const money = (n: number | null | undefined, c: string) => (n === null || n === undefined ? "—" : `${Math.round(n).toLocaleString("en-US")} ${c}`);
const chg = (n: number | null | undefined) => (n === null || n === undefined ? "" : ` (${n > 0 ? "+" : ""}${n}%)`);

export function reportMarkdown(r: Awaited<ReturnType<typeof report>>, title: string) {
  const c = r.currency;
  const L = [`# ${title}`, `${r.window.from} → ${r.window.to} · vs ${r.previous.from} → ${r.previous.to}`, "", "## Headline", `- Spend: **${money(r.kpis.spend, c)}**${chg(r.change_pct.spend)}`, `- Conversions: **${r.kpis.conversions}**${chg(r.change_pct.conversions)}`, `- Conversion value: **${money(r.kpis.value, c)}**${chg(r.change_pct.value)}`, `- CPA: **${money(r.kpis.cpa, c)}**${chg(r.change_pct.cpa)} · ROAS: **${r.kpis.roas ?? "—"}**${chg(r.change_pct.roas)}`];
  if (r.revenue) L.push(`- Store revenue (${r.revenue.source}): **${money(r.revenue.revenue, c)}**${chg(r.revenue.change_pct)} · MER **${r.revenue.mer ?? "—"}**`);
  L.push("", "## By platform", "| Platform | Spend | Share | Conv. | CPA | ROAS |", "|---|---:|---:|---:|---:|---:|");
  for (const p of r.platforms) L.push(`| ${p.platform} | ${money(p.spend, c)} | ${p.share_pct}% | ${p.conversions} | ${money(p.cpa, c)} | ${p.roas ?? "—"} |`);
  L.push("", "## Best campaigns", "| Platform | Campaign | Spend | Conv. | Value | ROAS |", "|---|---|---:|---:|---:|---:|");
  for (const x of r.top_campaigns) L.push(`| ${x.platform} | ${x.name} | ${money(x.spend, c)} | ${x.conversions} | ${money(x.value, c)} | ${x.roas ?? "—"} |`);
  L.push("", "## Needs attention (highest CPA)", "| Platform | Campaign | Spend | Conv. | CPA |", "|---|---|---:|---:|---:|");
  for (const x of r.worst_campaigns) L.push(`| ${x.platform} | ${x.name} | ${money(x.spend, c)} | ${x.conversions} | ${money(x.cpa, c)} |`);
  L.push("", "_Platform conversions use each platform's attribution and overlap; MER uses real store revenue._");
  return L.join("\n");
}

export function reportHtml(md: string, title: string) {
  const esc = (s: string) => s.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!);
  const lines = md.split("\n");
  const out: string[] = [];
  let table: string[][] | undefined;
  const flush = () => {
    if (!table) return;
    const [head, , ...body] = table;
    out.push(`<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    table = undefined;
  };
  for (const l of lines) {
    if (l.startsWith("|")) {
      (table ??= []).push(l.split("|").slice(1, -1).map((c) => c.trim()));
      continue;
    }
    flush();
    const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/_(.+?)_/g, "<em>$1</em>");
    if (l.startsWith("# ")) out.push(`<h1>${inline(l.slice(2))}</h1>`);
    else if (l.startsWith("## ")) out.push(`<h2>${inline(l.slice(3))}</h2>`);
    else if (l.startsWith("- ")) out.push(`<li>${inline(l.slice(2))}</li>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  flush();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#17202c}h1{font-size:26px}h2{font-size:18px;margin-top:28px}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid #dde3ea;padding:6px 8px;text-align:left}td:nth-child(n+3){text-align:right;font-variant-numeric:tabular-nums}li{margin:2px 0}</style></head><body>${out.join("\n")}</body></html>`;
}
