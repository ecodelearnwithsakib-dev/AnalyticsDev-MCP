import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { bq, costEstimate, datasetRef, dts, location, project, schema, tablePath, tableRef } from "../client.js";

const writeDisposition = z.enum(["WRITE_APPEND", "WRITE_TRUNCATE", "WRITE_EMPTY"]);

async function insertJob(projectId: string, loc: string, configuration: Record<string, unknown>) {
  return bq("POST", `projects/${projectId}/jobs`, { configuration, jobReference: { projectId, location: loc } });
}

export function registerDataTools(server: McpServer): void {
  server.registerTool(
    "bq_insert_rows",
    {
      title: "Stream rows into a table",
      description: "Insert JSON rows via the streaming API (rows are queryable within seconds). Column names must match the table schema.",
      inputSchema: {
        table: z.string(),
        project: schema.project,
        rows: z.array(z.record(z.unknown())).min(1).max(10000),
        insert_ids: z.array(z.string()).optional().describe("Per-row dedup IDs"),
        skip_invalid_rows: z.boolean().default(false),
        ignore_unknown_values: z.boolean().default(false),
      },
    },
    ({ table, project: p, rows, insert_ids, skip_invalid_rows, ignore_unknown_values }) =>
      run(async () => {
        const res = (await bq("POST", `${tablePath(tableRef(table, p))}/insertAll`, {
          rows: rows.map((json, i) => ({ json, insertId: insert_ids?.[i] })),
          skipInvalidRows: skip_invalid_rows,
          ignoreUnknownValues: ignore_unknown_values,
        })) as { insertErrors?: unknown[] };
        return { inserted: rows.length - (res.insertErrors?.length ?? 0), errors: res.insertErrors ?? [] };
      }),
  );

  server.registerTool(
    "bq_load_from_gcs",
    {
      title: "Load files from Cloud Storage",
      description: "Load CSV, JSON (newline-delimited), Parquet, Avro or ORC files from gs:// into a table. Returns the job; check it with bq_get_job.",
      inputSchema: {
        table: z.string(),
        source_uris: z.array(z.string()).min(1).describe("e.g. gs://bucket/path/*.csv"),
        format: z.enum(["CSV", "NEWLINE_DELIMITED_JSON", "PARQUET", "AVRO", "ORC"]).default("CSV"),
        autodetect: z.boolean().default(true),
        skip_leading_rows: z.number().int().min(0).optional().describe("CSV header rows"),
        write_disposition: writeDisposition.default("WRITE_APPEND"),
        schema_fields: z.array(z.record(z.unknown())).optional(),
        project: schema.project,
        location: schema.location,
      },
    },
    (args) =>
      run(() =>
        insertJob(project(args.project), location(args.location), {
          load: {
            destinationTable: tableRef(args.table, args.project),
            sourceUris: args.source_uris,
            sourceFormat: args.format,
            autodetect: args.autodetect,
            skipLeadingRows: args.skip_leading_rows,
            writeDisposition: args.write_disposition,
            schema: args.schema_fields ? { fields: args.schema_fields } : undefined,
          },
        }),
      ),
  );

  server.registerTool(
    "bq_export_to_gcs",
    {
      title: "Export table to Cloud Storage",
      description: "Export a table to gs:// as CSV, JSON, Avro or Parquet (use a * wildcard for large tables).",
      inputSchema: {
        table: z.string(),
        destination_uris: z.array(z.string()).min(1).describe("e.g. gs://bucket/export/part-*.csv"),
        format: z.enum(["CSV", "NEWLINE_DELIMITED_JSON", "AVRO", "PARQUET"]).default("CSV"),
        compression: z.enum(["NONE", "GZIP", "SNAPPY", "DEFLATE", "ZSTD"]).default("NONE"),
        print_header: z.boolean().default(true),
        project: schema.project,
        location: schema.location,
      },
    },
    (args) =>
      run(() =>
        insertJob(project(args.project), location(args.location), {
          extract: {
            sourceTable: tableRef(args.table, args.project),
            destinationUris: args.destination_uris,
            destinationFormat: args.format,
            compression: args.compression,
            printHeader: args.print_header,
          },
        }),
      ),
  );

  server.registerTool(
    "bq_copy_table",
    {
      title: "Copy table",
      description: "Copy one or more tables into a destination table (also used for snapshots/backups).",
      inputSchema: {
        sources: z.array(z.string()).min(1),
        destination: z.string(),
        write_disposition: writeDisposition.default("WRITE_EMPTY"),
        project: schema.project,
        location: schema.location,
      },
    },
    (args) =>
      run(() =>
        insertJob(project(args.project), location(args.location), {
          copy: {
            sourceTables: args.sources.map((s) => tableRef(s, args.project)),
            destinationTable: tableRef(args.destination, args.project),
            writeDisposition: args.write_disposition,
          },
        }),
      ),
  );

  server.registerTool(
    "bq_list_jobs",
    {
      title: "List jobs",
      description: "Recent query/load/export/copy jobs with state, bytes processed and errors.",
      inputSchema: {
        project: schema.project,
        state: z.enum(["done", "pending", "running"]).optional(),
        all_users: z.boolean().default(false),
        limit: z.number().int().min(1).max(1000).default(25),
      },
    },
    ({ project: p, state, all_users, limit }) =>
      run(async () => {
        const res = (await bq("GET", `projects/${project(p)}/jobs`, undefined, {
          stateFilter: state,
          allUsers: all_users,
          maxResults: limit,
          projection: "full",
        })) as { jobs?: Record<string, any>[] };
        return (res.jobs ?? []).map((j) => ({
          id: j.jobReference?.jobId,
          location: j.jobReference?.location,
          type: j.configuration?.jobType,
          state: j.state,
          user: j.user_email,
          created: j.statistics?.creationTime ? new Date(Number(j.statistics.creationTime)).toISOString() : undefined,
          processed: j.statistics?.query ? costEstimate(j.statistics.query.totalBytesProcessed) : undefined,
          query: j.configuration?.query?.query?.slice(0, 300),
          error: j.status?.errorResult,
        }));
      }),
  );

  server.registerTool(
    "bq_get_job",
    {
      title: "Get job",
      description: "Full status and statistics of a job.",
      inputSchema: { job_id: z.string(), project: schema.project, location: schema.location },
    },
    ({ job_id, project: p, location: loc }) => run(() => bq("GET", `projects/${project(p)}/jobs/${job_id}`, undefined, { location: location(loc) })),
  );

  server.registerTool(
    "bq_cancel_job",
    {
      title: "Cancel job",
      description: "Request cancellation of a running job.",
      inputSchema: { job_id: z.string(), project: schema.project, location: schema.location },
    },
    ({ job_id, project: p, location: loc }) =>
      run(() => bq("POST", `projects/${project(p)}/jobs/${job_id}/cancel`, undefined, { location: location(loc) })),
  );

  // ---------- Scheduled queries (BigQuery Data Transfer Service) ----------

  server.registerTool(
    "bq_list_scheduled_queries",
    {
      title: "List scheduled queries",
      description: "List scheduled queries and other data transfers (e.g. Google Ads, GA4 exports) in a location.",
      inputSchema: { project: schema.project, location: schema.location },
    },
    ({ project: p, location: loc }) =>
      run(() => dts("GET", `projects/${project(p)}/locations/${location(loc).toLowerCase()}/transferConfigs`)),
  );

  server.registerTool(
    "bq_create_scheduled_query",
    {
      title: "Create scheduled query",
      description:
        "Schedule a SQL query. schedule examples: 'every 24 hours', 'every day 06:00', 'every monday 09:00' (UTC). destination_table supports templates like 'daily_{run_date}'.",
      inputSchema: {
        name: z.string(),
        sql: z.string(),
        schedule: z.string().default("every 24 hours"),
        destination_dataset: z.string().optional().describe("Omit for DML/DDL scripts that write on their own"),
        destination_table: z.string().optional(),
        write_disposition: z.enum(["WRITE_APPEND", "WRITE_TRUNCATE"]).default("WRITE_TRUNCATE"),
        partitioning_field: z.string().optional(),
        project: schema.project,
        location: schema.location,
      },
    },
    (args) =>
      run(() => {
        const projectId = project(args.project);
        return dts("POST", `projects/${projectId}/locations/${location(args.location).toLowerCase()}/transferConfigs`, {
          displayName: args.name,
          dataSourceId: "scheduled_query",
          schedule: args.schedule,
          destinationDatasetId: args.destination_dataset ? datasetRef(args.destination_dataset, projectId).datasetId : undefined,
          params: {
            query: args.sql,
            ...(args.destination_table && {
              destination_table_name_template: args.destination_table,
              write_disposition: args.write_disposition,
              partitioning_field: args.partitioning_field ?? "",
            }),
          },
        });
      }),
  );

  server.registerTool(
    "bq_run_scheduled_query_now",
    {
      title: "Run scheduled query now",
      description: "Trigger a manual run of a scheduled query / transfer config by its resource name.",
      inputSchema: { name: z.string().describe("projects/.../locations/.../transferConfigs/...") },
    },
    ({ name }) => run(() => dts("POST", `${name}:startManualRuns`, { requestedRunTime: new Date().toISOString() })),
  );
}
