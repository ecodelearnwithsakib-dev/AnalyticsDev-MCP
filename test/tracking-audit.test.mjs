import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { call, connect } from "./helpers.mjs";

const PAGE = `<!doctype html><html><head>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied'});</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST1234"></script>
<script>gtag('config','G-TEST1234');</script>
<script>!function(f,b,e,v,n,t,s){}(window,document,'script');fbq('init', '123456789012345');fbq('track','PageView');</script>
<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABCD123');</script>
</head><body><a href="/product/x">x</a></body></html>`;
const GTM_JS = `var data = {"resource":{"version":"1","macros":[{"function":"__v"}],"tags":[{"function":"__googtag","vtp_tagId":"G-TEST1234"},{"function":"__html","vtp_html":"<script>fbq(\\"init\\", \\"123456789012345\\")</script>"},{"function":"__ua"}],"predicates":[]}}; function x(){}`;

test("tracking-audit: finds duplicate GA4/Meta tagging and missing Consent Mode v2", { timeout: 60_000 }, async () => {
  const site = http.createServer((req, res) => {
    if (req.url.startsWith("/gtm.js")) return res.end(GTM_JS);
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${site.address().port}`;
  // Serve the container "first-party" so the audit fetches it from the mock instead of Google.
  const page = PAGE.replace("</head>", `<script src="${base}/gtm.js?id=GTM-ABCD123"></script></head>`);
  site.removeAllListeners("request");
  site.on("request", (req, res) => (req.url.startsWith("/gtm.js") ? res.end(GTM_JS) : (res.setHeader("content-type", "text/html"), res.end(page))));
  const client = await connect("tracking-audit");
  try {
    const r = await call(client, "audit_site", { url: base, max_pages: 2, check_sgtm: false });
    assert.equal(r.isError, false, r.text);
    const findings = r.data.issues.map((i) => i.finding).join("\n");
    assert.match(findings, /GA4 G-TEST1234 is hard-coded on the page AND configured in GTM/);
    assert.match(findings, /Meta pixel 123456789012345 fires from the page code AND from GTM/);
    assert.match(findings, /without v2 parameters/);
    assert.match(findings, /Universal Analytics/);
    assert.ok(r.data.score < 80);
    assert.deepEqual(r.data.pixels.ga4, ["G-TEST1234"]);
  } finally {
    await client.close();
    site.close();
  }
});
