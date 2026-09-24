import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { requestJson } from "../shared/http.js";
import { run } from "../shared/server.js";

const PREVIEW_HEADER = "X-Gtm-Server-Preview";

export const stapeApiBase = () =>
  optionalEnv("STAPE_REGION").toUpperCase() === "EU" ? "https://api.app.eu.stape.io" : "https://api.app.stape.io";

const sgtmUrl = (override?: string) => (override ?? requireEnv("SGTM_URL")).replace(/\/+$/, "");

const target = {
  sgtm_url: z.string().url().optional().describe("Tagging server URL; defaults to SGTM_URL"),
  preview_header: z
    .string()
    .optional()
    .describe(`Value of ${PREVIEW_HEADER} (GTM server Preview → ⋮ → Send requests manually) so the hit shows in Preview; defaults to SGTM_PREVIEW_HEADER`),
};

function previewHeaders(value?: string): Record<string, string> {
  const header = value ?? optionalEnv("SGTM_PREVIEW_HEADER");
  return header ? { [PREVIEW_HEADER]: header } : {};
}

/** Summarize an HTTP response: status, the headers that matter for tracking, and a body excerpt. */
async function describeResponse(res: Response) {
  const body = await res.text();
  return {
    status: res.status,
    ok: res.ok,
    headers: {
      "content-type": res.headers.get("content-type") ?? undefined,
      location: res.headers.get("location") ?? undefined,
      "set-cookie": res.headers.getSetCookie?.().map((c) => c.split(";")[0].split("=")[0] + "=…; " + c.split(";").slice(1).join(";").trim()),
      "access-control-allow-origin": res.headers.get("access-control-allow-origin") ?? undefined,
    },
    body: body.length > 2000 ? `${body.slice(0, 2000)}… (${body.length} bytes)` : body,
  };
}

const unique = (values: string[]) => [...new Set(values)];

export function registerSgtmTools(server: McpServer): void {
  server.registerTool(
    "sgtm_healthcheck",
    {
      title: "sGTM health check",
      description: "Call the tagging server's /healthy endpoint and report status and latency.",
      inputSchema: { sgtm_url: target.sgtm_url },
    },
    ({ sgtm_url }) =>
      run(async () => {
        const url = `${sgtmUrl(sgtm_url)}/healthy`;
        const started = Date.now();
        const res = await fetch(url);
        return { url, latency_ms: Date.now() - started, ...(await describeResponse(res)) };
      }),
  );

  server.registerTool(
    "sgtm_send_request",
    {
      title: "Send request to sGTM",
      description:
        "Send any HTTP request to the tagging server to test clients and tags: Stape Data Client (/data?event_name=purchase&value=10), GA4 (/g/collect), custom loader (/gtm.js?id=GTM-XXXX), webhooks, etc. Add preview_header to watch it in sGTM Preview.",
      inputSchema: {
        ...target,
        method: z.enum(["GET", "POST", "PUT", "OPTIONS"]).default("GET"),
        path: z.string().default("/").describe("Path on the tagging server, e.g. /data"),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        headers: z.record(z.string()).optional().describe("e.g. {\"User-Agent\":\"...\",\"Cookie\":\"_fbp=...\"}"),
        json: z.record(z.unknown()).optional().describe("JSON body (sets Content-Type: application/json)"),
        body: z.string().optional().describe("Raw body, e.g. form-encoded or text/plain"),
      },
    },
    (args) =>
      run(async () => {
        const query = new URLSearchParams(Object.entries(args.query ?? {}).map(([k, v]) => [k, String(v)]));
        const url = `${sgtmUrl(args.sgtm_url)}${args.path.startsWith("/") ? "" : "/"}${args.path}${query.size ? `?${query}` : ""}`;
        const res = await fetch(url, {
          method: args.method,
          redirect: "manual",
          headers: {
            ...(args.json && { "Content-Type": "application/json" }),
            ...previewHeaders(args.preview_header),
            ...args.headers,
          },
          body: args.json ? JSON.stringify(args.json) : args.body,
        });
        return { url, ...(await describeResponse(res)) };
      }),
  );

  server.registerTool(
    "sgtm_send_ga4_event",
    {
      title: "Send GA4 event to sGTM",
      description: "Send a GA4 Measurement Protocol hit to the tagging server (claimed by the GA4 client) to test server tags such as Meta CAPI, GA4 or Google Ads.",
      inputSchema: {
        ...target,
        client_id: z.string().describe("GA client_id, e.g. 123456.7890"),
        event_name: z.string(),
        params: z.record(z.unknown()).optional(),
        user_id: z.string().optional(),
        user_data: z.record(z.unknown()).optional().describe("e.g. {\"email_address\":\"a@b.com\",\"phone_number\":\"+8801...\"}"),
        measurement_id: z.string().optional().describe("Defaults to GA4_MEASUREMENT_ID"),
        api_secret: z.string().optional().describe("Defaults to GA4_API_SECRET"),
        path: z.string().default("/mp/collect"),
      },
    },
    (args) =>
      run(async () => {
        const query = new URLSearchParams({
          measurement_id: args.measurement_id ?? requireEnv("GA4_MEASUREMENT_ID"),
          api_secret: args.api_secret ?? requireEnv("GA4_API_SECRET"),
        });
        const res = await fetch(`${sgtmUrl(args.sgtm_url)}${args.path}?${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...previewHeaders(args.preview_header) },
          body: JSON.stringify({
            client_id: args.client_id,
            user_id: args.user_id,
            user_data: args.user_data,
            events: [{ name: args.event_name, params: args.params ?? {} }],
          }),
        });
        return describeResponse(res);
      }),
  );

  server.registerTool(
    "sgtm_audit_website",
    {
      title: "Audit a website's sGTM setup",
      description:
        "Fetch a page and report how tracking is loaded: GTM/GA4/Ads IDs, whether gtm.js comes from Google or a first-party/custom loader domain, server_container_url / transport_url, Meta pixel, and (if SGTM_URL is set) whether the tagging server is healthy and serves gtm.js.",
      inputSchema: {
        website_url: z.string().url(),
        sgtm_url: target.sgtm_url,
      },
    },
    ({ website_url, sgtm_url }) =>
      run(async () => {
        const page = await fetch(website_url, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36" },
        });
        const html = await page.text();
        const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
        // Stape's custom loader hides "id=GTM-XXXX" as base64 ("aWQ9R1RN...") and injects the script via j.src.
        const hiddenIds = [...html.matchAll(/aWQ9R1RN[A-Za-z0-9+/=]*/g)].flatMap((m) => Buffer.from(m[0], "base64").toString().match(/GTM-[A-Z0-9]{4,10}/g) ?? []);
        const injectedSrcs = [...html.matchAll(/\.src\s*=\s*['"](https?:\/\/[^'"]+)['"]/g)].map((m) => m[1]);
        const gtmLoaders = unique([
          ...scriptSrcs.filter((src) => /gtm\.js|gtag\/js/.test(src)),
          ...[...html.matchAll(/["'](https?:)?\/\/([^"'\s]+?)\/(gtm\.js|gtag\/js)[^"'\s]*/gi)].map((m) => m[0].slice(1)),
          ...(hiddenIds.length ? injectedSrcs : []),
        ]);
        const loaderHosts = unique(
          gtmLoaders
            .map((src) => {
              try {
                return new URL(src, website_url).hostname;
              } catch {
                return "";
              }
            })
            .filter(Boolean),
        );
        const report: Record<string, unknown> = {
          url: page.url,
          status: page.status,
          gtm_ids: unique([...(html.match(/GTM-[A-Z0-9]{4,10}/g) ?? []), ...hiddenIds]),
          ga4_ids: unique(html.match(/\bG-[A-Z0-9]{6,12}\b/g) ?? []),
          google_ads_ids: unique(html.match(/\bAW-\d{6,12}\b/g) ?? []),
          gtm_loader_scripts: gtmLoaders,
          loader_hosts: loaderHosts,
          first_party_loader: loaderHosts.some((h) => !/googletagmanager\.com|google-analytics\.com/.test(h)),
          server_container_url: unique([...html.matchAll(/(server_container_url|transport_url)["']?\s*[:,]\s*["']([^"']+)["']/g)].map((m) => `${m[1]}=${m[2]}`)),
          meta_pixel: /connect\.facebook\.net\/[^"']*fbevents\.js|fbq\(/.test(html),
          stape_custom_loader: hiddenIds.length > 0,
          note: "Only the initial HTML is inspected; tags injected later by GTM are not visible here.",
        };
        const configured = sgtm_url ?? optionalEnv("SGTM_URL");
        if (configured) {
          const base = sgtmUrl(configured);
          const health = await fetch(`${base}/healthy`).then(describeResponse).catch((e: Error) => ({ error: e.message }));
          const gtmId = (report.gtm_ids as string[])[0];
          const loader = gtmId
            ? await fetch(`${base}/gtm.js?id=${gtmId}`)
                .then(async (r) => ({ status: r.status, content_type: r.headers.get("content-type"), bytes: (await r.text()).length }))
                .catch((e: Error) => ({ error: e.message }))
            : "no GTM ID found on the page";
          report.tagging_server = { url: base, healthy: health, serves_gtm_js: loader };
        }
        return report;
      }),
  );

  server.registerTool(
    "stape_api_request",
    {
      title: "Stape REST API request",
      description:
        "Call the Stape REST API directly (see https://api.app.stape.io/api/doc). The official Stape tools (stape_*) cover most needs; use this for anything they miss.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string().describe("API path starting with /api/"),
        body: z.record(z.unknown()).optional(),
      },
    },
    ({ method, path, body }) =>
      run(async () => {
        const headers: Record<string, string> = { Authorization: requireEnv("STAPE_API_KEY") };
        if (optionalEnv("STAPE_REGION").toUpperCase() === "EU") headers["X-Stape-Region"] = "EU";
        return requestJson(`${stapeApiBase()}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      }),
  );
}
