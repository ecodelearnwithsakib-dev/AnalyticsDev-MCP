#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collect, pickAdapters, revenue } from "../ads-hub/core.js";
import { callTool, closeChildren, configured, convert, PRESETS, round, window } from "../shared/hub.js";
import { run, startStdio } from "../shared/server.js";
import { detectPage, fetchContainer, fetchText, type ContainerFindings, type Issue, type PageFindings } from "./detect.js";

const server = new McpServer(
  { name: "tracking-audit", version: "0.1.0" },
  {
    instructions:
      "Tracking QA for a website and its ad accounts. audit_site crawls pages and published GTM containers for tags, pixels, duplicates, Consent Mode v2, CMPs and server-side tagging; audit_gtm_workspace reviews the GTM workspace itself; audit_conversion_gap compares conversions in ad platforms vs GA4 vs the store; audit_meta_capi checks browser vs server events; audit_full runs everything and returns a scored, prioritized fix list.",
  },
);

const SEV_WEIGHT = { critical: 25, high: 12, medium: 6, low: 2, info: 0 } as const;
const score = (issues: Issue[]) => Math.max(0, 100 - issues.reduce((s, i) => s + SEV_WEIGHT[i.severity], 0));
const order = ["critical", "high", "medium", "low", "info"];
const sortIssues = (i: Issue[]) => [...i].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));

async function siteAudit(url: string, maxPages: number, checkSgtm: boolean) {
  const start = url.startsWith("http") ? url : `https://${url}`;
  const pages: PageFindings[] = [];
  const queue = [start];
  const seen = new Set<string>();
  while (queue.length && pages.length < maxPages) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    try {
      const r = await fetchText(u);
      const p = detectPage(r.finalUrl, r.status, r.text);
      pages.push(p);
      // Prefer key funnel pages when crawling further.
      const next = p.links.filter((l) => /cart|checkout|product|shop|pricing|contact|thank|signup|register|book/i.test(l)).concat(p.links);
      for (const l of next) if (!seen.has(l) && queue.length < 50) queue.push(l);
    } catch (e) {
      pages.push({ ...detectPage(u, 0, ""), status: 0, url: `${u} (${e instanceof Error ? e.message : "fetch failed"})` });
    }
  }
  const union = <K extends keyof PageFindings>(k: K) => [...new Set(pages.flatMap((p) => (Array.isArray(p[k]) ? (p[k] as unknown[]) : [])))] as string[];
  const gtmIds = union("gtm");
  const loaders = pages.flatMap((p) => p.gtm_loaders);
  const containers: (ContainerFindings | { id: string; error: string })[] = [];
  for (const id of gtmIds.slice(0, 5)) {
    const own = loaders.find((l) => l.src.includes(id) && l.first_party);
    containers.push(await fetchContainer(id, own ? new URL(own.src, start).toString() : undefined));
  }
  const ok = containers.filter((c): c is ContainerFindings => !("error" in c));
  const inGtm = (k: "ga4_ids" | "meta_pixels" | "google_ads_ids" | "tiktok_pixels") => new Set(ok.flatMap((c) => c[k]));
  const sgtmUrls = [...new Set([...union("server_container_urls"), ...ok.flatMap((c) => c.server_container_urls)])];

  const issues: Issue[] = [];
  const home = pages[0];
  if (!home || home.status >= 400 || home.status === 0) issues.push({ severity: "critical", area: "Site", finding: `Home page returned ${home?.status ?? "no response"}`, fix: "Check the URL, redirects and bot protection (the audit uses a normal browser user agent)." });
  const spa = pages.some((p) => p.spa || p.js_injected_tags_hint);
  if (!gtmIds.length && !union("gtag_ids").length)
    issues.push(
      spa
        ? { severity: "medium", area: "Tag management", finding: "No GTM/Google tag in the static HTML — the site is a JavaScript app or loads tags through a custom loader, so they're injected at runtime", fix: "Verify in the browser (Tag Assistant / GTM Preview) or run the stape server's sgtm_audit_website, which decodes custom loaders." }
        : { severity: "critical", area: "Tag management", finding: "No Google Tag Manager or Google tag found on the site", fix: "Install GTM (or confirm tags aren't injected only after consent)." },
    );
  if (gtmIds.length > 1) issues.push({ severity: "medium", area: "Tag management", finding: `${gtmIds.length} GTM containers on the site (${gtmIds.join(", ")})`, fix: "Consolidate into one web container unless an agency container is intentional; duplicate containers often double-fire tags." });
  for (const id of union("ga4_ids")) if (inGtm("ga4_ids").has(id)) issues.push({ severity: "high", area: "GA4", finding: `GA4 ${id} is hard-coded on the page AND configured in GTM`, fix: "Remove the hard-coded gtag snippet (or the GTM Google tag) — sessions and events are counted twice." });
  if (union("ga4_ids").length + inGtm("ga4_ids").size === 0 && gtmIds.length) issues.push({ severity: "high", area: "GA4", finding: "No GA4 measurement ID found on the page or in the published container", fix: "Add a Google tag with your G- ID in GTM (or check it's set via a variable / lookup table)." });
  for (const id of union("meta_pixels")) if (inGtm("meta_pixels").has(id)) issues.push({ severity: "high", area: "Meta", finding: `Meta pixel ${id} fires from the page code AND from GTM`, fix: "Keep one browser pixel; send the server copy via CAPI with the same event_id for deduplication." });
  const googleTags = union("gtag_ids").length + ok.reduce((s, c) => s + c.ga4_ids.length + c.google_ads_ids.length, 0) > 0;
  if (googleTags && !pages.some((p) => p.consent_default) && !ok.some((c) => c.consent_mode_template)) issues.push({ severity: "high", area: "Consent", finding: "No Google Consent Mode default command found", fix: "Set gtag('consent','default',{…}) before any Google tag — via your CMP's GTM template or a Consent Initialization tag. Required for EEA/UK ads measurement." });
  else if (googleTags && pages.some((p) => p.consent_default) && !pages.some((p) => p.consent_v2)) issues.push({ severity: "high", area: "Consent", finding: "Consent Mode found but without v2 parameters (ad_user_data, ad_personalization)", fix: "Update the CMP / consent template to Consent Mode v2." });
  const unseen = spa && !gtmIds.length;
  if (!union("cmp").length) issues.push({ severity: unseen ? "low" : "medium", area: "Consent", finding: "No consent management platform detected", fix: "If you have EEA/UK/California visitors, add a certified CMP (Cookiebot, OneTrust, Usercentrics, CookieYes…) wired to Consent Mode." });
  if (gtmIds.length && loaders.length && loaders.every((l) => !l.first_party)) issues.push({ severity: "low", area: "Server-side", finding: "GTM loads from googletagmanager.com", fix: "Serve gtm.js first-party (Stape custom loader / own sGTM domain) to recover data lost to ad blockers and ITP." });
  if (!sgtmUrls.length) issues.push({ severity: unseen ? "low" : "medium", area: "Server-side", finding: "No server-side GTM (server_container_url / transport_url) detected", fix: "Route GA4 and ads events through sGTM on a first-party subdomain and add Meta CAPI / Google Enhanced Conversions from the server." });
  if (ok.some((c) => c.has_universal_analytics)) issues.push({ severity: "low", area: "GTM", finding: "Universal Analytics tags still in the published container", fix: "Delete retired UA tags and their triggers." });
  const html = ok.reduce((s, c) => s + c.custom_html_tags, 0);
  if (html > 10) issues.push({ severity: "low", area: "GTM", finding: `${html} Custom HTML tags in the published container`, fix: "Replace with Community Template Gallery templates where possible (safer, consent-aware, faster)." });
  if (union("meta_pixels").length + inGtm("meta_pixels").size && !pages.some((p) => p.ecommerce_events.length) && home?.platform.some((x) => /Shopify|WooCommerce/.test(x))) issues.push({ severity: "medium", area: "E-commerce", finding: "Store detected but no GA4 e-commerce dataLayer events in the HTML", fix: "Check purchase/add_to_cart dataLayer pushes on product, cart and thank-you pages (they may only appear after interaction)." });

  let sgtm: unknown[] | undefined;
  if (checkSgtm && sgtmUrls.length) {
    sgtm = [];
    for (const u of sgtmUrls.slice(0, 3)) {
      const base = u.replace(/\/+$/, "");
      const h = await fetchText(`${base}/healthy`, 10_000).catch((e: Error) => ({ status: 0, text: e.message }));
      sgtm.push({ url: base, healthy: h.status === 200, status: h.status });
      if (h.status !== 200) issues.push({ severity: "critical", area: "Server-side", finding: `sGTM ${base} health check returned ${h.status || "no response"}`, fix: "Check the tagging server (Stape container status, DNS and SSL of the custom domain)." });
    }
  }
  const pixels = {
    ga4: [...new Set([...union("ga4_ids"), ...inGtm("ga4_ids")])],
    google_ads: [...new Set([...union("google_ads_ids"), ...inGtm("google_ads_ids")])],
    meta: [...new Set([...union("meta_pixels"), ...inGtm("meta_pixels")])],
    tiktok: [...new Set([...union("tiktok_pixels"), ...inGtm("tiktok_pixels")])],
    linkedin: union("linkedin_partner_ids"),
    microsoft_uet: union("microsoft_uet"),
    pinterest: union("pinterest_tags"),
    snapchat: union("snap_pixels"),
    x: union("x_pixels"),
    reddit: union("reddit_pixels"),
    clarity: union("clarity"),
    hotjar: union("hotjar"),
    hubspot: union("hubspot"),
    klaviyo: union("klaviyo"),
    matomo: pages.some((p) => p.matomo),
    segment: pages.some((p) => p.segment),
  };
  return {
    site: start,
    pages: pages.map((p) => ({ url: p.url, status: p.status, gtm: p.gtm, tags: p.gtag_ids, pixels: [...p.meta_pixels.map((x) => `meta:${x}`), ...p.tiktok_pixels.map((x) => `tiktok:${x}`)], consent_default: p.consent_default, consent_v2: p.consent_v2, cmp: p.cmp, ecommerce_events: p.ecommerce_events, scripts: p.script_count, html_kb: p.html_kb })),
    platform: [...new Set(pages.flatMap((p) => p.platform))],
    gtm_containers: containers,
    server_side: { urls: sgtmUrls, first_party_loader: loaders.some((l) => l.first_party), health: sgtm },
    consent: { cmp: union("cmp"), consent_mode_default: pages.some((p) => p.consent_default), consent_mode_v2: pages.some((p) => p.consent_v2), wait_for_update: pages.some((p) => p.consent_wait_for_update) },
    pixels,
    issues: sortIssues(issues),
    score: score(issues),
    notes: ["Static analysis of HTML and published GTM containers; tags injected only after consent or by client-side apps may not appear. Confirm in GTM Preview / Tag Assistant."],
  };
}

server.registerTool(
  "audit_site",
  {
    title: "Audit a website's tracking",
    description:
      "Crawl a site (home page + key funnel pages) and its published GTM containers: GTM/Google tag IDs, GA4 and Google Ads IDs, Meta/TikTok/LinkedIn/Microsoft UET/Pinterest/Snap/X/Reddit pixels, Clarity/Hotjar/HubSpot/Klaviyo, duplicate tagging (page + GTM), Consent Mode default and v2, CMP, first-party loader and sGTM health, UA leftovers and Custom HTML load. Returns a 0–100 score and prioritized issues with fixes.",
    inputSchema: { url: z.string(), max_pages: z.number().int().min(1).max(20).default(5), check_sgtm: z.boolean().default(true) },
  },
  (a) => run(() => siteAudit(a.url, a.max_pages, a.check_sgtm)),
);

server.registerTool(
  "audit_gtm_workspace",
  {
    title: "Audit the GTM workspace",
    description:
      "Review the GTM container's workspace through the GTM API (needs the gtm server's sign-in): paused tags, tags without firing triggers, tags missing consent settings, Custom HTML tags, Universal Analytics leftovers, duplicate Google tags / GA4 IDs, and unused triggers and variables.",
    inputSchema: { account_id: z.string().optional(), container_id: z.string().optional(), workspace_id: z.string().optional() },
  },
  (a) =>
    run(async () => {
      const scope = { account_id: a.account_id, container_id: a.container_id, workspace_id: a.workspace_id };
      const list = async (resource: string) => {
        const r = await callTool<unknown>("gtm", "gtm_list", { ...scope, resource, full: true });
        return (Array.isArray(r) ? r : ((r as Record<string, unknown>)?.items ?? (r as Record<string, unknown>)?.[resource] ?? [])) as Record<string, unknown>[];
      };
      const [tags, triggers, variables] = await Promise.all([list("tags"), list("triggers"), list("variables")]);
      const issues: Issue[] = [];
      const usedTriggers = new Set(tags.flatMap((t) => [...((t.firingTriggerId as string[]) ?? []), ...((t.blockingTriggerId as string[]) ?? [])]));
      const text = JSON.stringify(tags) + JSON.stringify(triggers);
      for (const t of tags) {
        const name = String(t.name);
        const type = String(t.type);
        if (t.paused) issues.push({ severity: "low", area: "Tags", finding: `Paused tag: ${name}`, fix: "Delete it if it's no longer needed." });
        if (!(t.firingTriggerId as string[] | undefined)?.length && type !== "googtag") issues.push({ severity: "medium", area: "Tags", finding: `No firing trigger: ${name}`, fix: "Add a trigger or delete the tag." });
        if (type === "ua") issues.push({ severity: "medium", area: "Tags", finding: `Universal Analytics tag: ${name}`, fix: "UA stopped processing data; delete it." });
        if (type === "html") issues.push({ severity: "low", area: "Tags", finding: `Custom HTML: ${name}`, fix: "Prefer a gallery template; make sure it respects consent." });
        const consent = (t.consentSettings as { consentStatus?: string } | undefined)?.consentStatus;
        if (!consent || consent === "notSet") if (!/^(googtag|gaawe|awct|sp|gclidw|flc|fls)$/.test(type)) issues.push({ severity: "medium", area: "Consent", finding: `No additional consent check on non-Google tag: ${name}`, fix: "Set Consent Settings → Require additional consent (e.g. ad_storage) for third-party pixels." });
      }
      const googleTags = tags.filter((t) => t.type === "googtag");
      const ids = googleTags.map((t) => JSON.stringify(t.parameter ?? "").match(/G-[A-Z0-9]{4,12}/)?.[0]).filter(Boolean);
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      for (const id of new Set(dup)) issues.push({ severity: "high", area: "GA4", finding: `More than one Google tag for ${id}`, fix: "Keep a single Google tag per measurement ID." });
      for (const tr of triggers) if (!usedTriggers.has(String(tr.triggerId))) issues.push({ severity: "info", area: "Triggers", finding: `Unused trigger: ${tr.name}`, fix: "Delete to keep the container tidy." });
      for (const v of variables) if (!text.includes(`{{${v.name}}}`)) issues.push({ severity: "info", area: "Variables", finding: `Variable not referenced by tags or triggers: ${v.name}`, fix: "Delete if unused (it may still be used by other variables)." });
      return { counts: { tags: tags.length, triggers: triggers.length, variables: variables.length }, issues: sortIssues(issues), score: score(issues.filter((i) => i.severity !== "info")) };
    }),
);

async function conversionGap(w: { from: string; to: string }, currency: string | undefined, store: string) {
  const adapters = pickAdapters();
  const got = await collect(adapters, { ...w, level: "account", daily: false, conversion: "purchase" });
  const cur = (currency ?? got.rows[0]?.currency ?? "USD").toUpperCase();
  const sources: { source: string; conversions: number; value: number; note?: string }[] = [];
  for (const r of got.rows) sources.push({ source: r.platform, conversions: round(r.conversions), value: round(await convert(r.value, r.currency, cur)) });
  if (configured("GA4_PROPERTY_ID")) {
    const g = await callTool<{ totals?: Record<string, string>[]; rows?: Record<string, string>[] }>("ga4", "ga4_run_report", { dimensions: [], metrics: ["transactions", "purchaseRevenue", "keyEvents"], start_date: w.from, end_date: w.to, currency_code: cur, limit: 1 }).catch((e: Error) => ({ error: e.message }) as never);
    const t = g?.totals?.[0] ?? g?.rows?.[0];
    if (t) sources.push({ source: "ga4", conversions: Number(t.transactions ?? 0), value: round(Number(t.purchaseRevenue ?? 0)), note: `key events: ${t.keyEvents ?? "?"}` });
  }
  let storeRow: { orders?: number; revenue: number } | undefined;
  if (store !== "none") {
    const s = await revenue(store, w.from, w.to, cur).catch(() => undefined);
    if (s) {
      storeRow = { orders: s.orders, revenue: s.revenue };
      sources.push({ source: store, conversions: s.orders ?? 0, value: s.revenue });
    }
  }
  const ga4 = sources.find((s) => s.source === "ga4");
  const truth = storeRow ? { conversions: storeRow.orders ?? 0, value: storeRow.revenue } : ga4;
  const issues: Issue[] = [];
  const table = sources.map((s) => ({ ...s, vs_truth_conversions_pct: truth?.conversions ? round((s.conversions / truth.conversions) * 100, 1) : null, vs_truth_value_pct: truth?.value ? round((s.value / truth.value) * 100, 1) : null }));
  if (storeRow && ga4 && storeRow.orders) {
    const cap = ga4.conversions / storeRow.orders;
    if (cap < 0.8) issues.push({ severity: cap < 0.6 ? "critical" : "high", area: "GA4", finding: `GA4 records ${round(cap * 100, 1)}% of store orders`, fix: "Check the purchase event on every checkout path (incl. payment redirects), consent-mode modelling, ad blockers — move GA4 to sGTM and send purchases server-side." });
    if (cap > 1.1) issues.push({ severity: "high", area: "GA4", finding: `GA4 records ${round(cap * 100, 1)}% of store orders (duplicates)`, fix: "Deduplicate purchase events by transaction_id; stop re-firing on thank-you page reloads." });
  }
  for (const s of sources.filter((x) => !["ga4", store].includes(x.source)))
    if (truth?.conversions && s.conversions > truth.conversions * 1.3) issues.push({ severity: "medium", area: s.source, finding: `${s.source} claims ${round((s.conversions / truth.conversions) * 100)}% of actual conversions`, fix: "Expected with view-through/cross-device attribution; judge by MER and incrementality, and check for duplicate conversion actions." });
    else if (truth?.conversions && s.conversions === 0) issues.push({ severity: "high", area: s.source, finding: `${s.source} reports zero conversions`, fix: "Check the pixel/conversion action is firing and linked to the campaigns (and CAPI/offline uploads are running)." });
  return { window: w, currency: cur, truth: storeRow ? store : ga4 ? "ga4" : "none", sources: table, issues: sortIssues(issues), errors: Object.keys(got.errors).length ? got.errors : undefined };
}

server.registerTool(
  "audit_conversion_gap",
  {
    title: "Conversion gap: platforms vs GA4 vs store",
    description:
      "For a period, lines up purchases and revenue reported by every connected ad platform, GA4 (transactions, purchase revenue) and the store (Shopify / WooCommerce orders) in one currency — showing what share each captures and flagging tracking loss, duplicates and over-attribution.",
    inputSchema: { preset: z.enum(PRESETS).optional().describe("Default last_7_days"), from: z.string().optional(), to: z.string().optional(), currency: z.string().length(3).optional(), store: z.enum(["none", "shopify", "woocommerce"]).default("none") },
  },
  (a) => run(() => conversionGap(window(a.preset, a.from, a.to), a.currency, a.store)),
);

async function metaCapi(pixelId?: string) {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const [bySource, byKeys] = await Promise.all([
    callTool<Record<string, unknown>>("meta", "meta_pixel_stats", { pixel_id: pixelId, aggregation: "event_source", start_time: String(since) }),
    callTool<Record<string, unknown>>("meta", "meta_pixel_stats", { pixel_id: pixelId, aggregation: "match_keys", start_time: String(since) }).catch(() => undefined),
  ]);
  const counts: Record<string, number> = {};
  for (const bucket of (bySource.data as { data?: { value: string; count: number }[] }[]) ?? []) for (const d of bucket.data ?? []) counts[d.value] = (counts[d.value] ?? 0) + Number(d.count);
  const keys: Record<string, number> = {};
  for (const bucket of ((byKeys?.data as { data?: { value: string; count: number }[] }[]) ?? [])) for (const d of bucket.data ?? []) keys[d.value] = (keys[d.value] ?? 0) + Number(d.count);
  const browser = Object.entries(counts).filter(([k]) => /browser|pixel/i.test(k)).reduce((s, [, v]) => s + v, 0);
  const serverEv = Object.entries(counts).filter(([k]) => /server|api/i.test(k)).reduce((s, [, v]) => s + v, 0);
  const issues: Issue[] = [];
  if (!serverEv) issues.push({ severity: "high", area: "Meta", finding: "No Conversions API (server) events in the last 7 days", fix: "Send events server-side (sGTM Meta CAPI tag, Stape, or platform integration) with the same event_id as the pixel." });
  else if (browser && serverEv < browser * 0.5) issues.push({ severity: "medium", area: "Meta", finding: `Server events are ${round((serverEv / browser) * 100)}% of browser events`, fix: "Send every key event from the server too, deduplicated by event_id." });
  const total = Object.values(keys).reduce((s, v) => s + v, 0);
  const share = (k: RegExp) => (total ? round((Object.entries(keys).filter(([n]) => k.test(n)).reduce((s, [, v]) => s + v, 0) / total) * 100, 1) : null);
  const emailShare = share(/em|email/i);
  if (serverEv && emailShare !== null && emailShare < 30) issues.push({ severity: "medium", area: "Meta", finding: `Only ${emailShare}% of events carry a hashed email`, fix: "Pass hashed email/phone, external_id, fbp/fbc, IP and user agent with server events to raise Event Match Quality." });
  return { last_days: 7, events_by_source: counts, browser_events: browser, server_events: serverEv, match_keys: keys, issues: sortIssues(issues) };
}

server.registerTool(
  "audit_meta_capi",
  {
    title: "Meta Pixel + Conversions API check",
    description: "Last 7 days of a Meta pixel: browser vs server (CAPI) event volume, which customer-information keys are sent (email, phone, fbp/fbc, IP…), and issues that lower Event Match Quality or break deduplication.",
    inputSchema: { pixel_id: z.string().optional().describe("Defaults to META_PIXEL_ID") },
  },
  (a) => run(() => metaCapi(a.pixel_id)),
);

server.registerTool(
  "audit_full",
  {
    title: "Full tracking audit",
    description: "Runs the site audit, the conversion gap (when ad platforms/GA4 are connected) and the Meta CAPI check (when Meta is connected) and returns one score with the combined, prioritized fix list — ready to hand to a client.",
    inputSchema: { url: z.string(), max_pages: z.number().int().min(1).max(20).default(5), preset: z.enum(PRESETS).optional(), store: z.enum(["none", "shopify", "woocommerce"]).default("none") },
  },
  (a) =>
    run(async () => {
      const site = await siteAudit(a.url, a.max_pages, true);
      const connectedAds = pickAdapters().length > 0;
      const [gap, capi] = await Promise.all([
        connectedAds || configured("GA4_PROPERTY_ID") ? conversionGap(window(a.preset), undefined, a.store).catch((e: Error) => ({ error: e.message })) : undefined,
        configured("META_ACCESS_TOKEN", "META_PIXEL_ID") ? metaCapi().catch((e: Error) => ({ error: e.message })) : undefined,
      ]);
      const issues = sortIssues([...site.issues, ...((gap && "issues" in gap ? gap.issues : []) as Issue[]), ...((capi && "issues" in capi ? capi.issues : []) as Issue[])]);
      return {
        site: site.site,
        score: score(issues),
        grade: ((s) => (s >= 90 ? "A" : s >= 75 ? "B" : s >= 60 ? "C" : s >= 40 ? "D" : "F"))(score(issues)),
        summary: { critical: issues.filter((i) => i.severity === "critical").length, high: issues.filter((i) => i.severity === "high").length, medium: issues.filter((i) => i.severity === "medium").length },
        fix_list: issues,
        pixels: site.pixels,
        consent: site.consent,
        server_side: site.server_side,
        conversion_gap: gap,
        meta_capi: capi,
      };
    }),
);

process.stdin.on("close", () => void closeChildren());
await startStdio(server, "tracking-audit");
