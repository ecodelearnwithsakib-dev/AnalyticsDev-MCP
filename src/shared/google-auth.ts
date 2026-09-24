import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { optionalEnv } from "./env.js";

export type GoogleProfile = {
  name: string;
  scopes: string[];
  refreshTokenEnv: string;
  /** First non-empty env var wins, so one OAuth client can serve several servers. */
  clientIdEnvs: string[];
  clientSecretEnvs: string[];
  /** Service-account domain-wide delegation: impersonate this user. */
  subjectEnv?: string;
};

export const PROFILES = {
  ga4: {
    name: "GA4",
    scopes: [
      "https://www.googleapis.com/auth/analytics.readonly",
      "https://www.googleapis.com/auth/analytics.edit",
      "https://www.googleapis.com/auth/analytics.manage.users",
    ],
    refreshTokenEnv: "GA4_OAUTH_REFRESH_TOKEN",
    clientIdEnvs: ["GA4_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_ID"],
    clientSecretEnvs: ["GA4_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_CLIENT_SECRET"],
  },
  "looker-studio": {
    name: "Looker Studio",
    scopes: ["https://www.googleapis.com/auth/datastudio", "https://www.googleapis.com/auth/userinfo.profile"],
    refreshTokenEnv: "LOOKER_STUDIO_OAUTH_REFRESH_TOKEN",
    clientIdEnvs: ["LOOKER_STUDIO_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_ID", "GA4_OAUTH_CLIENT_ID"],
    clientSecretEnvs: ["LOOKER_STUDIO_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_CLIENT_SECRET", "GA4_OAUTH_CLIENT_SECRET"],
    subjectEnv: "LOOKER_STUDIO_IMPERSONATE_USER",
  },
  gtm: {
    name: "Google Tag Manager",
    scopes: [
      "https://www.googleapis.com/auth/tagmanager.readonly",
      "https://www.googleapis.com/auth/tagmanager.edit.containers",
      "https://www.googleapis.com/auth/tagmanager.edit.containerversions",
      "https://www.googleapis.com/auth/tagmanager.publish",
      "https://www.googleapis.com/auth/tagmanager.manage.accounts",
      "https://www.googleapis.com/auth/tagmanager.manage.users",
      "https://www.googleapis.com/auth/tagmanager.delete.containers",
    ],
    refreshTokenEnv: "GTM_OAUTH_REFRESH_TOKEN",
    clientIdEnvs: ["GTM_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_ID", "GA4_OAUTH_CLIENT_ID"],
    clientSecretEnvs: ["GTM_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_CLIENT_SECRET", "GA4_OAUTH_CLIENT_SECRET"],
  },
  bigquery: {
    name: "BigQuery",
    scopes: ["https://www.googleapis.com/auth/bigquery", "https://www.googleapis.com/auth/cloud-platform"],
    refreshTokenEnv: "BIGQUERY_OAUTH_REFRESH_TOKEN",
    clientIdEnvs: ["BIGQUERY_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_ID", "GA4_OAUTH_CLIENT_ID"],
    clientSecretEnvs: ["BIGQUERY_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_CLIENT_SECRET", "GA4_OAUTH_CLIENT_SECRET"],
  },
  "google-ads": {
    name: "Google Ads",
    scopes: ["https://www.googleapis.com/auth/adwords"],
    refreshTokenEnv: "GOOGLE_ADS_OAUTH_REFRESH_TOKEN",
    clientIdEnvs: ["GOOGLE_ADS_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_ID", "GA4_OAUTH_CLIENT_ID"],
    clientSecretEnvs: ["GOOGLE_ADS_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_CLIENT_SECRET", "GA4_OAUTH_CLIENT_SECRET"],
  },
} satisfies Record<string, GoogleProfile>;

type Requester = Pick<OAuth2Client, "request">;

function firstEnv(names: string[]): string {
  return names.map((name) => optionalEnv(name)).find(Boolean) ?? "";
}

export function oauthClientCredentials(profile: GoogleProfile, redirectUri?: string): OAuth2Client {
  const clientId = firstEnv(profile.clientIdEnvs);
  const clientSecret = firstEnv(profile.clientSecretEnvs);
  if (!clientId || !clientSecret) {
    throw new Error(`Set ${profile.clientIdEnvs[0]} and ${profile.clientSecretEnvs[0]} in .env (see .env.example)`);
  }
  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

/** OAuth refresh token if configured, otherwise a service account (optionally impersonating a user) or gcloud ADC. */
export function googleClient(profile: GoogleProfile): () => Promise<Requester> {
  let client: Promise<Requester> | undefined;
  return () => {
    if (!client) {
      const refreshToken = optionalEnv(profile.refreshTokenEnv);
      if (refreshToken) {
        const oauth = oauthClientCredentials(profile);
        oauth.setCredentials({ refresh_token: refreshToken });
        client = Promise.resolve(oauth);
      } else {
        const subject = profile.subjectEnv ? optionalEnv(profile.subjectEnv) : "";
        client = new GoogleAuth({ scopes: profile.scopes, clientOptions: subject ? { subject } : undefined }).getClient() as Promise<Requester>;
      }
    }
    return client;
  };
}

export async function googleRequest(
  getClient: () => Promise<Requester>,
  options: {
    url: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    data?: unknown;
    params?: Record<string, unknown>;
    headers?: Record<string, string>;
  },
): Promise<unknown> {
  const auth = await getClient();
  try {
    const res = await auth.request({
      ...options,
      params: options.params && Object.fromEntries(Object.entries(options.params).filter(([, v]) => v !== undefined)),
    });
    return res.data ?? { ok: true };
  } catch (error) {
    type ApiError = { message?: string; status?: string; details?: unknown[] } | string;
    const res = (error as { response?: { status?: number; data?: { error?: ApiError; error_description?: string } } }).response;
    const apiError = res?.data?.error;
    if (typeof apiError === "object") {
      // Some APIs (e.g. Google Ads) put the actionable reason in error.details.
      const details = apiError.details?.length ? ` ${JSON.stringify(apiError.details).slice(0, 2000)}` : "";
      throw new Error(`HTTP ${res?.status} ${apiError.status}: ${apiError.message}${details}`);
    }
    // OAuth token endpoint errors look like { error: "invalid_grant", error_description: "..." }.
    if (typeof apiError === "string") throw new Error(`Auth failed (${apiError}): ${res?.data?.error_description ?? ""}`);
    throw error;
  }
}
