import { z } from "zod";
import { optionalEnv, requireEnv } from "../shared/env.js";
import { googleClient, googleRequest, PROFILES } from "../shared/google-auth.js";

const BQ = "https://bigquery.googleapis.com/bigquery/v2";
const DTS = "https://bigquerydatatransfer.googleapis.com/v1";
const getClient = googleClient(PROFILES.bigquery);

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const bq = (method: Method, path: string, data?: unknown, params?: Record<string, unknown>) =>
  googleRequest(getClient, { url: `${BQ}/${path.replace(/^\/+/, "")}`, method, data, params });

export const dts = (method: Method, path: string, data?: unknown, params?: Record<string, unknown>) =>
  googleRequest(getClient, { url: `${DTS}/${path.replace(/^\/+/, "")}`, method, data, params });

export const project = (id?: string) => id ?? requireEnv("BIGQUERY_PROJECT_ID");
export const location = (loc?: string) => loc ?? optionalEnv("BIGQUERY_LOCATION", "US");

/** Accepts "dataset", "project.dataset" or "project:dataset". */
export function datasetRef(value: string, projectId?: string) {
  const parts = value.replace(":", ".").split(".");
  return parts.length >= 2 ? { projectId: parts[0], datasetId: parts[1] } : { projectId: project(projectId), datasetId: parts[0] };
}

/** Accepts "dataset.table" or "project.dataset.table" (backticks allowed). */
export function tableRef(value: string, projectId?: string) {
  const parts = value.replace(/`/g, "").replace(":", ".").split(".");
  if (parts.length === 3) return { projectId: parts[0], datasetId: parts[1], tableId: parts[2] };
  if (parts.length === 2) return { projectId: project(projectId), datasetId: parts[0], tableId: parts[1] };
  throw new Error(`Expected dataset.table or project.dataset.table, got "${value}"`);
}

export const tablePath = (t: { projectId: string; datasetId: string; tableId: string }) =>
  `projects/${t.projectId}/datasets/${t.datasetId}/tables/${t.tableId}`;

/** Default cap on bytes billed per query so a runaway query can't run up a large bill. */
export const maxBytesBilled = (override?: number) =>
  String(override ?? Number(optionalEnv("BIGQUERY_MAX_BYTES_BILLED", String(10 * 1024 ** 3))));

/** Approximate on-demand price (USD 6.25 per TiB scanned). */
export function costEstimate(bytes?: string | number) {
  const n = Number(bytes ?? 0);
  return { bytes: n, gib: +(n / 1024 ** 3).toFixed(3), approx_usd_on_demand: +((n / 1024 ** 4) * 6.25).toFixed(4) };
}

type Field = { name: string; type: string; mode?: string; fields?: Field[] };
type Cell = { v: unknown };

function convertValue(field: Field, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (field.mode === "REPEATED") return (v as Cell[]).map((item) => convertValue({ ...field, mode: "NULLABLE" }, item.v));
  switch (field.type) {
    case "RECORD":
    case "STRUCT":
      return rowToObject(field.fields ?? [], v as { f: Cell[] });
    case "INTEGER":
    case "INT64": {
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : String(v);
    }
    case "FLOAT":
    case "FLOAT64":
      return Number(v);
    case "BOOLEAN":
    case "BOOL":
      return v === "true" || v === true;
    case "TIMESTAMP":
      // Requested as int64 microseconds via formatOptions.useInt64Timestamp.
      return new Date(Number(v) / 1000).toISOString();
    default:
      return v;
  }
}

export function rowToObject(fields: Field[], row: { f: Cell[] }): Record<string, unknown> {
  return Object.fromEntries(fields.map((field, i) => [field.name, convertValue(field, row.f[i]?.v)]));
}

export function rowsToObjects(schema: { fields?: Field[] } | undefined, rows: { f: Cell[] }[] = []) {
  const fields = schema?.fields ?? [];
  return rows.map((row) => rowToObject(fields, row));
}

/** Compact schema for display: name, type, mode, nested fields. */
export function describeSchema(fields: Field[] = []): unknown[] {
  return fields.map((f) => ({
    name: f.name,
    type: f.type,
    ...(f.mode && f.mode !== "NULLABLE" && { mode: f.mode }),
    ...(f.fields && { fields: describeSchema(f.fields) }),
  }));
}

export const schema = {
  project: z.string().optional().describe("GCP project ID; defaults to BIGQUERY_PROJECT_ID"),
  location: z.string().optional().describe("Job location, e.g. US, EU, asia-south1; defaults to BIGQUERY_LOCATION or US"),
  confirm: z.literal(true).describe("Must be true"),
};
