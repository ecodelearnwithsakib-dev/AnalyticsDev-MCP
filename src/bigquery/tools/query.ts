import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { bq, costEstimate, describeSchema, location, maxBytesBilled, project, rowsToObjects, schema } from "../client.js";

type QueryResponse = {
  jobComplete?: boolean;
  jobReference?: { projectId: string; jobId: string; location: string };
  schema?: { fields?: [] };
  rows?: { f: { v: unknown }[] }[];
  totalRows?: string;
  pageToken?: string;
  totalBytesProcessed?: string;
  totalBytesBilled?: string;
  cacheHit?: boolean;
  numDmlAffectedRows?: string;
  dmlStats?: unknown;
  errors?: unknown[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function inferParam(name: string, value: string | number | boolean | (string | number)[]) {
  const scalarType = (v: unknown) => (typeof v === "boolean" ? "BOOL" : typeof v === "number" ? (Number.isInteger(v) ? "INT64" : "FLOAT64") : "STRING");
  if (Array.isArray(value)) {
    return {
      name,
      parameterType: { type: "ARRAY", arrayType: { type: scalarType(value[0]) } },
      parameterValue: { arrayValues: value.map((v) => ({ value: String(v) })) },
    };
  }
  return { name, parameterType: { type: scalarType(value) }, parameterValue: { value: String(value) } };
}

function format(res: QueryResponse) {
  return {
    job: res.jobReference,
    total_rows: res.totalRows !== undefined ? Number(res.totalRows) : undefined,
    returned_rows: res.rows?.length ?? 0,
    page_token: res.pageToken,
    cache_hit: res.cacheHit,
    processed: costEstimate(res.totalBytesProcessed),
    dml_affected_rows: res.numDmlAffectedRows !== undefined ? Number(res.numDmlAffectedRows) : undefined,
    rows: rowsToObjects(res.schema, res.rows),
  };
}

export function registerQueryTools(server: McpServer): void {
  server.registerTool(
    "bq_query",
    {
      title: "Run BigQuery SQL",
      description:
        "Run GoogleSQL (SELECT, DML, DDL, scripts). Bytes billed are capped (BIGQUERY_MAX_BYTES_BILLED, default 10 GiB) unless max_bytes_billed is raised. Use dry_run to see bytes/cost first. Named params: WHERE date >= @start with params {\"start\":\"2026-09-01\"}. GA4 export tables: `project.analytics_<PROPERTY_ID>.events_*` with _TABLE_SUFFIX.",
      inputSchema: {
        sql: z.string(),
        project: schema.project,
        location: schema.location,
        dry_run: z.boolean().default(false),
        params: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])).optional(),
        default_dataset: z.string().optional().describe("Dataset for unqualified table names"),
        max_rows: z.number().int().min(0).max(10000).default(200),
        max_bytes_billed: z.number().int().positive().optional().describe("Override the safety cap for this query (bytes)"),
        use_cache: z.boolean().default(true),
        wait_seconds: z.number().int().min(1).max(600).default(120),
      },
    },
    (args) =>
      run(async () => {
        const projectId = project(args.project);
        const body = {
          query: args.sql,
          useLegacySql: false,
          dryRun: args.dry_run,
          location: location(args.location),
          maxResults: args.max_rows,
          timeoutMs: 10000,
          useQueryCache: args.use_cache,
          maximumBytesBilled: maxBytesBilled(args.max_bytes_billed),
          defaultDataset: args.default_dataset ? { projectId, datasetId: args.default_dataset } : undefined,
          parameterMode: args.params ? "NAMED" : undefined,
          queryParameters: args.params ? Object.entries(args.params).map(([k, v]) => inferParam(k, v)) : undefined,
          formatOptions: { useInt64Timestamp: true },
        };
        let res = (await bq("POST", `projects/${projectId}/queries`, body)) as QueryResponse;
        if (args.dry_run) return { dry_run: true, would_process: costEstimate(res.totalBytesProcessed), schema: describeSchema(res.schema?.fields) };

        const deadline = Date.now() + args.wait_seconds * 1000;
        while (!res.jobComplete && res.jobReference && Date.now() < deadline) {
          await sleep(1500);
          res = (await bq("GET", `projects/${projectId}/queries/${res.jobReference.jobId}`, undefined, {
            location: res.jobReference.location,
            maxResults: args.max_rows,
            timeoutMs: 10000,
            "formatOptions.useInt64Timestamp": true,
          })) as QueryResponse;
        }
        if (!res.jobComplete) {
          return { status: "still running", job: res.jobReference, hint: "Fetch later with bq_get_query_results" };
        }
        return format(res);
      }),
  );

  server.registerTool(
    "bq_get_query_results",
    {
      title: "Get query results",
      description: "Fetch (more) rows of a finished query job, using the page_token from bq_query.",
      inputSchema: {
        job_id: z.string(),
        project: schema.project,
        location: schema.location,
        page_token: z.string().optional(),
        max_rows: z.number().int().min(1).max(10000).default(200),
        start_index: z.number().int().min(0).optional(),
      },
    },
    (args) =>
      run(async () =>
        format(
          (await bq("GET", `projects/${project(args.project)}/queries/${args.job_id}`, undefined, {
            location: location(args.location),
            pageToken: args.page_token,
            maxResults: args.max_rows,
            startIndex: args.start_index,
            "formatOptions.useInt64Timestamp": true,
          })) as QueryResponse,
        ),
      ),
  );
}
