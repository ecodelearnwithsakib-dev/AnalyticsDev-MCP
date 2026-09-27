/** Static detection of tags, pixels, consent and server-side tagging in HTML and GTM containers. */

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 AnalyticsDev-Audit/1.0 (+Analytics Dev MCP)";

export async function fetchText(url: string, timeoutMs = 20_000): Promise<{ status: number; text: string; finalUrl: string; headers: Headers }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/javascript,*/*" }, redirect: "follow", signal: ctl.signal });
    return { status: res.status, text: await res.text(), finalUrl: res.url, headers: res.headers };
  } finally {
    clearTimeout(t);
  }
}

const uniq = (a: string[]) => [...new Set(a)].filter((x) => !/X{5,}|0{8,}/.test(x));
const all = (text: string, re: RegExp, group = 1) => uniq([...text.matchAll(re)].map((m) => m[group]).filter(Boolean));

export type PageFindings = {
  url: string;
  status: number;
  gtm: string[];
  gtm_loaders: { src: string; first_party: boolean }[];
  gtag_ids: string[];
  ga4_ids: string[];
  google_ads_ids: string[];
  server_container_urls: string[];
  meta_pixels: string[];
  tiktok_pixels: string[];
  linkedin_partner_ids: string[];
  microsoft_uet: string[];
  pinterest_tags: string[];
  snap_pixels: string[];
  x_pixels: string[];
  reddit_pixels: string[];
  clarity: string[];
  hotjar: string[];
  matomo: boolean;
  segment: boolean;
  hubspot: string[];
  klaviyo: string[];
  cmp: string[];
  consent_default: boolean;
  consent_v2: boolean;
  consent_wait_for_update: boolean;
  datalayer: boolean;
  ecommerce_events: string[];
  platform: string[];
  spa: boolean;
  js_injected_tags_hint: boolean;
  script_count: number;
  html_kb: number;
  links: string[];
};

const CMPS: [string, RegExp][] = [
  ["Cookiebot", /consent\.cookiebot\.(com|eu)|Cookiebot/i],
  ["OneTrust", /cdn\.cookielaw\.org|optanon|onetrust/i],
  ["Usercentrics", /usercentrics/i],
  ["CookieYes", /cdn-cookieyes\.com|cookieyes/i],
  ["Complianz", /complianz/i],
  ["Termly", /app\.termly\.io/i],
  ["iubenda", /iubenda\.com/i],
  ["Didomi", /didomi/i],
  ["Axeptio", /axept\.io|axeptio/i],
  ["Osano", /osano\.com/i],
  ["Quantcast Choice", /quantcast\.mgr|cmp\.quantcast/i],
  ["Shopify Customer Privacy", /customerPrivacy|privacy-banner/i],
  ["Consentmanager", /consentmanager\.net/i],
  ["CookieFirst", /cookiefirst/i],
  ["Stape Consent", /consent\.stape\.io/i],
  ["Klaro", /klaro(\.js|Config)/i],
  ["Borlabs", /borlabs-cookie/i],
];

export function detectPage(url: string, status: number, html: string): PageFindings {
  const origin = new URL(url).hostname.replace(/^www\./, "");
  const scriptSrcs = all(html, /<script[^>]+src=["']([^"']+)["']/gi);
  const loaders = scriptSrcs
    .filter((s) => /gtm\.js|gtag\/js|\/[a-z0-9]{6,}\.js\?(st|id)=|googletagmanager/i.test(s))
    .map((src) => {
      let host = "";
      try {
        host = new URL(src, url).hostname;
      } catch {
        /* relative */
      }
      return { src, first_party: !!host && !/googletagmanager\.com$/.test(host) && (host.endsWith(origin) || host === "" || !host.includes("google")) };
    });
  const gtag = all(html, /\b((?:G|AW|DC|GT)-[A-Z0-9]{4,12})\b/g);
  const ecommerce = all(html, /['"]event['"]\s*:\s*['"](purchase|add_to_cart|begin_checkout|view_item|add_payment_info|add_shipping_info|view_cart|generate_lead|sign_up)['"]/g);
  return {
    url,
    status,
    gtm: all(html, /\b(GTM-[A-Z0-9]{4,9})\b/g),
    gtm_loaders: loaders,
    gtag_ids: gtag,
    ga4_ids: gtag.filter((g) => g.startsWith("G-")),
    google_ads_ids: gtag.filter((g) => g.startsWith("AW-")),
    server_container_urls: all(html, /(?:server_container_url|transport_url)['"]?\s*[:=,]\s*['"](https?:\/\/[^'"]+)['"]/gi),
    meta_pixels: uniq([...all(html, /fbq\(\s*['"]init['"]\s*,\s*['"](\d{8,20})['"]/g), ...all(html, /connect\.facebook\.net\/signals\/config\/(\d{8,20})/g)]),
    tiktok_pixels: all(html, /ttq\.load\(\s*['"]([A-Z0-9]{10,30})['"]/g),
    linkedin_partner_ids: all(html, /_linkedin_partner_id\s*=\s*['"]?(\d{4,12})/g),
    microsoft_uet: all(html, /["']?ti["']?\s*:\s*["'](\d{5,12})["']/g).filter(() => /bat\.bing\.com|uetq/.test(html)),
    pinterest_tags: all(html, /pintrk\(\s*['"]load['"]\s*,\s*['"](\d{8,16})['"]/g),
    snap_pixels: all(html, /snaptr\(\s*['"]init['"]\s*,\s*['"]([a-f0-9-]{20,40})['"]/g),
    x_pixels: all(html, /twq\(\s*['"](?:config|init)['"]\s*,\s*['"]([a-z0-9]{4,12})['"]/g),
    reddit_pixels: all(html, /rdt\(\s*['"]init['"]\s*,\s*['"]((?:t2|a2)_[a-z0-9]+)['"]/gi),
    clarity: all(html, /clarity\.ms\/tag\/([a-z0-9]{6,14})/g),
    hotjar: all(html, /hjid\s*:\s*(\d{5,10})/g),
    matomo: /_paq\.push|matomo\.js|piwik\.js/.test(html),
    segment: /cdn\.segment\.com|analytics\.load\(/.test(html),
    hubspot: all(html, /js(?:-\w+)?\.hs-scripts\.com\/(\d+)\.js/g),
    klaviyo: all(html, /klaviyo\.js\?company_id=([A-Za-z0-9]+)/g),
    cmp: CMPS.filter(([, re]) => re.test(html)).map(([n]) => n),
    consent_default: /gtag\(\s*['"]consent['"]\s*,\s*['"]default['"]/.test(html) || /['"]consent['"]\s*,\s*['"]default['"]/.test(html),
    consent_v2: /ad_user_data/.test(html) && /ad_personalization/.test(html),
    consent_wait_for_update: /wait_for_update/.test(html),
    datalayer: /dataLayer\s*=|dataLayer\.push/.test(html),
    ecommerce_events: ecommerce,
    platform: [
      ...(/cdn\.shopify\.com|Shopify\.theme/.test(html) ? ["Shopify"] : []),
      ...(/wp-content|wp-includes/.test(html) ? ["WordPress"] : []),
      ...(/woocommerce/i.test(html) ? ["WooCommerce"] : []),
      ...(/static\.wixstatic\.com/.test(html) ? ["Wix"] : []),
      ...(/squarespace\.com/.test(html) ? ["Squarespace"] : []),
      ...(/webflow/.test(html) ? ["Webflow"] : []),
      ...(/__NEXT_DATA__|\/_next\/static\//.test(html) ? ["Next.js"] : []),
      ...(/__NUXT__|\/_nuxt\//.test(html) ? ["Nuxt"] : []),
    ],
    spa: /__NEXT_DATA__|\/_next\/static\/|__NUXT__|\/_nuxt\/|<div id="(root|app)"><\/div>|data-reactroot|ng-version=/.test(html),
    js_injected_tags_hint: /CUSTOM_LOADER|GTM_ID|gtmId|googleTagManager|tagmanager|NEXT_PUBLIC_GTM|segment|partytown/i.test(html),
    script_count: (html.match(/<script\b/gi) ?? []).length,
    html_kb: Math.round(html.length / 1024),
    links: all(html, /<a[^>]+href=["']([^"'#?]+)["']/gi)
      .map((h) => {
        try {
          return new URL(h, url).toString();
        } catch {
          return "";
        }
      })
      .filter((h) => h.startsWith("http") && new URL(h).hostname.replace(/^www\./, "") === origin),
  };
}

export type ContainerFindings = {
  id: string;
  fetched_from: string;
  bytes: number;
  tag_types: Record<string, number>;
  ga4_ids: string[];
  google_ads_ids: string[];
  meta_pixels: string[];
  tiktok_pixels: string[];
  server_container_urls: string[];
  custom_html_tags: number;
  custom_templates: number;
  consent_mode_template: boolean;
  has_universal_analytics: boolean;
  server_side_client: boolean;
};

const TAG_NAMES: Record<string, string> = {
  __googtag: "Google tag",
  __gaawe: "GA4 event",
  __gaawc: "GA4 configuration (legacy)",
  __awct: "Google Ads conversion",
  __sp: "Google Ads remarketing",
  __gclidw: "Conversion linker",
  __html: "Custom HTML",
  __img: "Custom image",
  __ua: "Universal Analytics (retired)",
  __flc: "Floodlight counter",
  __fls: "Floodlight sales",
  __baut: "Microsoft UET",
  __hjtc: "Hotjar",
  __cl: "Click listener",
  __fsl: "Form listener",
  __lcl: "Link click listener",
  __sdl: "Scroll depth listener",
  __ytl: "YouTube listener",
  __evl: "Element visibility listener",
  __tl: "Timer listener",
  __hl: "History listener",
  __jel: "JavaScript error listener",
  __paused: "Paused tag",
  __tg: "Trigger group",
  __awec: "Google Ads user-provided data",
  __gas: "GA settings (legacy)",
  __bzi: "LinkedIn Insight",
  __pntr: "Pinterest",
  __twitter_website_tag: "X (Twitter) pixel",
  __qpx: "Quora pixel",
  __crto: "Criteo",
};

export async function fetchContainer(id: string, loaderUrl?: string): Promise<ContainerFindings | { id: string; error: string }> {
  const candidates = [loaderUrl, `https://www.googletagmanager.com/gtm.js?id=${id}`].filter(Boolean) as string[];
  for (const url of candidates) {
    try {
      const r = await fetchText(url);
      if (r.status !== 200 || !/function|var /.test(r.text)) continue;
      const js = r.text;
      // Count only the tags section of the container resource (macros and triggers use the same "function" key).
      const tagStart = js.indexOf('"tags":[');
      const tagEnd = tagStart >= 0 ? js.indexOf('"predicates":', tagStart) : -1;
      const tagJs = tagStart >= 0 ? js.slice(tagStart, tagEnd > tagStart ? tagEnd : undefined) : js;
      const types: Record<string, number> = {};
      for (const m of tagJs.matchAll(/"function":"(__[a-z0-9_]+)"/g)) types[m[1]] = (types[m[1]] ?? 0) + 1;
      const named = Object.fromEntries(Object.entries(types).map(([k, v]) => [k.startsWith("__cvt_") ? `Custom template ${k}` : TAG_NAMES[k] ?? k, v]));
      return {
        id,
        fetched_from: url,
        bytes: js.length,
        tag_types: named,
        ga4_ids: all(js, /"(G-[A-Z0-9]{4,12})"/g),
        google_ads_ids: all(js, /"(AW-\d{6,12})"/g).concat(all(js, /"vtp_conversionId":"(\d{6,12})"/g).map((x) => `AW-${x}`)).filter((v, i, a) => a.indexOf(v) === i),
        meta_pixels: uniq([...all(js, /fbq\(\\?["']init\\?["'],\s*\\?["'](\d{8,20})/g), ...all(js, /"vtp_pixelId":"(\d{8,20})"/g)]),
        tiktok_pixels: all(js, /ttq\.load\(\\?["']([A-Z0-9]{10,30})/g),
        server_container_urls: all(js, /"vtp_serverContainerUrl":"(https?:[^"]+)"/g).concat(all(js, /server_container_url","vtp_value":"(https?:[^"]+)"/g)),
        custom_html_tags: types.__html ?? 0,
        custom_templates: Object.keys(types).filter((k) => k.startsWith("__cvt_")).reduce((s, k) => s + types[k], 0),
        consent_mode_template: /consent|__cvt_.*consent/i.test(js) && /ad_user_data|analytics_storage/.test(js),
        has_universal_analytics: (types.__ua ?? 0) > 0 || /"UA-\d+-\d+"/.test(js),
        server_side_client: /transport_url|server_container_url|vtp_serverContainerUrl/.test(js),
      };
    } catch {
      /* try the next source */
    }
  }
  return { id, error: "Container could not be fetched (not published, or blocked)" };
}

export type Issue = { severity: "critical" | "high" | "medium" | "low" | "info"; area: string; finding: string; fix: string };
