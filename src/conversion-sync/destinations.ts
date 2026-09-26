import { optionalEnv } from "../shared/env.js";
import { callTool, configured } from "../shared/hub.js";
import type { Deal } from "./sources.js";

export type SendOptions = {
  event: "purchase" | "lead";
  test: boolean;
  google_action_id?: string;
  msads_goal?: string;
  meta_test_code?: string;
  reddit_test_id?: string;
};

export type Destination = {
  key: string;
  title: string;
  isConfigured: () => boolean;
  /** Why a deal can't go to this platform, or undefined when it can. */
  ineligible: (d: Deal, o: SendOptions) => string | undefined;
  send: (deals: Deal[], o: SendOptions) => Promise<{ sent: string[]; failed: Record<string, string>; response?: unknown }>;
};

const hasPii = (d: Deal) => !!(d.email || d.phone);

/** Google Ads wants "YYYY-MM-DD HH:MM:SS+00:00". */
const googleTime = (iso: string) => `${iso.slice(0, 19).replace("T", " ")}+00:00`;

const google: Destination = {
  key: "google",
  title: "Google Ads (offline click conversions / enhanced conversions for leads)",
  isConfigured: () => configured("GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID"),
  ineligible: (d, o) => (!(o.google_action_id ?? optionalEnv("CONVSYNC_GOOGLE_ACTION_ID")) ? "no conversion action (CONVSYNC_GOOGLE_ACTION_ID)" : !(d.gclid || d.gbraid || d.wbraid || hasPii(d)) ? "no gclid/gbraid/wbraid or email/phone" : undefined),
  async send(deals, o) {
    const action = o.google_action_id ?? optionalEnv("CONVSYNC_GOOGLE_ACTION_ID");
    const res = await callTool<Record<string, unknown>>("google-ads", "gads_upload_click_conversions", {
      conversion_action_id: action,
      validate_only: o.test,
      conversions: deals.map((d) => ({ gclid: d.gclid, gbraid: d.gbraid, wbraid: d.wbraid, email: d.gclid ? undefined : d.email, phone: d.gclid ? undefined : d.phone, conversion_time: googleTime(d.won_at), value: d.value, currency: d.currency, order_id: `${d.source}-${d.id}` })),
    });
    const errors = JSON.stringify(res.partialFailureError ?? res.partial_failure ?? "");
    const failed: Record<string, string> = {};
    // Partial failures reference rows by index ("conversions[3]").
    for (const m of errors.matchAll(/conversions\[(\d+)\][^"]*"message":"([^"]+)"/g)) failed[`${deals[Number(m[1])].source}-${deals[Number(m[1])].id}`] = m[2];
    return { sent: deals.map((d) => `${d.source}-${d.id}`).filter((k) => !failed[k]), failed, response: res };
  },
};

const meta: Destination = {
  key: "meta",
  title: "Meta Conversions API",
  isConfigured: () => configured("META_ACCESS_TOKEN", "META_PIXEL_ID"),
  ineligible: (d) => (!(hasPii(d) || d.fbc) ? "no email/phone or fbc" : Date.now() - Date.parse(d.won_at) > 62 * 86_400_000 ? "older than 62 days" : undefined),
  async send(deals, o) {
    const sent: string[] = [];
    const failed: Record<string, string> = {};
    for (const d of deals) {
      const key = `${d.source}-${d.id}`;
      try {
        await callTool("meta", "meta_send_event", {
          event_name: o.event === "lead" ? optionalEnv("CONVSYNC_META_LEAD_EVENT", "Lead") : optionalEnv("CONVSYNC_META_EVENT", "Purchase"),
          event_id: key,
          event_time: d.won_at,
          action_source: "system_generated",
          email: d.email,
          phone: d.phone,
          external_id: d.contact_id,
          fbc: d.fbc,
          value: d.value,
          currency: d.currency,
          custom_data: { order_id: key, crm: d.source },
          test_event_code: o.test ? (o.meta_test_code ?? optionalEnv("CONVSYNC_META_TEST_CODE")) || undefined : undefined,
        });
        sent.push(key);
      } catch (e) {
        failed[key] = e instanceof Error ? e.message : String(e);
      }
    }
    return { sent, failed };
  },
};

const microsoft: Destination = {
  key: "microsoft",
  title: "Microsoft Ads offline conversions",
  isConfigured: () => configured("MSADS_DEVELOPER_TOKEN", "MSADS_ACCOUNT_ID"),
  ineligible: (d, o) => (!(o.msads_goal ?? optionalEnv("CONVSYNC_MSADS_GOAL")) ? "no offline goal (CONVSYNC_MSADS_GOAL)" : !(d.msclkid || hasPii(d)) ? "no msclkid or email/phone" : undefined),
  async send(deals, o) {
    if (o.test) return { sent: [], failed: {}, response: "Microsoft has no test mode — preview only" };
    const res = await callTool<Record<string, unknown>>("microsoft-ads", "msads_upload_offline_conversions", {
      goal_name: o.msads_goal ?? optionalEnv("CONVSYNC_MSADS_GOAL"),
      conversions: deals.map((d) => ({ msclkid: d.msclkid, time: d.won_at, value: d.value, currency: d.currency, email: d.msclkid ? undefined : d.email, phone: d.msclkid ? undefined : d.phone })),
    });
    return { sent: deals.map((d) => `${d.source}-${d.id}`), failed: {}, response: res };
  },
};

const reddit: Destination = {
  key: "reddit",
  title: "Reddit Conversions API",
  isConfigured: () => configured("REDDIT_REFRESH_TOKEN") && (configured("REDDIT_PIXEL_ID") || configured("REDDIT_CONVERSION_TOKEN")),
  ineligible: (d) => (!(d.rdt_cid || hasPii(d)) ? "no rdt_cid or email/phone" : Date.now() - Date.parse(d.won_at) > 7 * 86_400_000 ? "older than 7 days" : undefined),
  async send(deals, o) {
    const res = await callTool("reddit", "reddit_ads_conversions", {
      test_id: o.test ? o.reddit_test_id ?? (optionalEnv("CONVSYNC_REDDIT_TEST_ID") || undefined) : undefined,
      confirm: !o.test,
      events: deals.map((d) => ({ type: o.event === "lead" ? "LEAD" : "PURCHASE", event_at: d.won_at, action_source: "OTHER", click_id: d.rdt_cid, value: d.value, currency: d.currency, conversion_id: `${d.source}-${d.id}`, email: d.email, phone: d.phone, external_id: d.contact_id })),
    });
    return { sent: deals.map((d) => `${d.source}-${d.id}`), failed: {}, response: res };
  },
};

const openai: Destination = {
  key: "openai",
  title: "OpenAI Ads Conversions API",
  isConfigured: () => configured("OPENAI_ADS_CONVERSIONS_API_KEY", "OPENAI_ADS_PIXEL_ID"),
  ineligible: (d) => (!(d.oppref || hasPii(d)) ? "no oppref or email/phone" : Date.now() - Date.parse(d.won_at) > 7 * 86_400_000 ? "older than 7 days" : undefined),
  async send(deals, o) {
    const res = await callTool("openai-ads", "oai_ads_send_conversions", {
      validate_only: o.test,
      integration_source: "analyticsdev_conversion_sync",
      events: deals.map((d) => ({ type: o.event === "lead" ? "lead_created" : "order_created", id: `${d.source}-${d.id}`, time: d.won_at, action_source: "offline", oppref: d.oppref, value: d.value, currency: d.currency, email: d.email, phone: d.phone, external_id: d.contact_id })),
    });
    return { sent: deals.map((d) => `${d.source}-${d.id}`), failed: {}, response: res };
  },
};

const linkedin: Destination = {
  key: "linkedin",
  title: "LinkedIn Conversions API",
  isConfigured: () => configured("LINKEDIN_ACCESS_TOKEN") && !!optionalEnv("CONVSYNC_LINKEDIN_RULE"),
  ineligible: (d) => (!hasPii(d) ? "no email" : undefined),
  async send(deals, o) {
    const res = await callTool("linkedin-ads", "linkedin_conversions", {
      action: "send",
      rule: optionalEnv("CONVSYNC_LINKEDIN_RULE"),
      confirm: !o.test,
      events: deals.map((d) => ({ time: d.won_at, value: d.value, currency: d.currency, event_id: `${d.source}-${d.id}`, email: d.email })),
    });
    return { sent: o.test ? [] : deals.map((d) => `${d.source}-${d.id}`), failed: {}, response: res };
  },
};

export const DESTINATIONS: Destination[] = [google, meta, microsoft, reddit, openai, linkedin];
