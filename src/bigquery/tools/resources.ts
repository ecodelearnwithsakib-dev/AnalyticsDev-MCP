import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { bq, datasetRef, describeSchema, location, project, rowsToObjects, schema, tablePath, tableRef } from "../client.js";

const fieldSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.string().describe("STRING, INT64, FLOAT64, NUMERIC, BOOL, DATE, DATETIME, TIMESTAMP, JSON, RECORD, ..."),
    mode: z.enum(["NULLABLE", "REQUIRED", "REPEATED"]).optional(),
    description: z.string().optional(),
    fields: z.array(fieldSchema).optional(),
  }),
);

async function listPaged(path: string, key: string, limit: number, params: Record<string, unknown> = {}) {
  const items: unknown[] = [];
  let pageToken: string | undefined;
  do {
    const res = (await bq("GET", path, undefined, { ...params, maxResults: Math.min(limit, 1000), pageToken })) as Record<string, unknown>;
    items.push(...((res[key] as unknown[]) ?? []));
    pageToken = res.nextPageToken as string | undefined;
  } while (pageToken && items.length < limit);
  return { count: Math.min(items.length, limit), has_more: Boolean(pageToken) || items.length > limit, [key]: items.slice(0, limit) };
}

export function registerResourceTools(server: McpServer): void {
  server.registerTool(
    "bq_api_request",
    {
      title: "BigQuery API request",
      description: "Call ANY BigQuery REST v2 endpoint directly. path is relative to /bigquery/v2, e.g. 'projects/p/datasets/d/tables/t/iamPolicy'.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string(),
        body: z.record(z.unknown()).optional(),
        query: z.record(z.unknown()).optional(),
      },
    },
    ({ method, path, body, query }) => run(() => bq(method, path, body, query)),
  );

  server.registerTool(
    "bq_list_projects",
    { title: "List projects", description: "List GCP projects the credentials can use with BigQuery.", inputSchema: { limit: z.number().int().default(200) } },
    ({ limit }) => run(() => listPaged("projects", "projects", limit)),
  );

  server.registerTool(
    "bq_list",
    {
      title: "List datasets / tables / routines / models",
      description: "List datasets in a project, or tables (incl. views), routines (UDFs, procedures) or ML models in a dataset.",
      inputSchema: {
        kind: z.enum(["datasets", "tables", "routines", "models"]),
        dataset: z.string().optional().describe("Required for tables/routines/models; 'dataset' or 'project.dataset'"),
        project: schema.project,
        filter: z.string().optional().describe("datasets: label filter, e.g. labels.env:prod"),
        limit: z.number().int().min(1).max(10000).default(500),
      },
    },
    ({ kind, dataset, project: p, filter, limit }) =>
      run(async () => {
        if (kind === "datasets") return listPaged(`projects/${project(p)}/datasets`, "datasets", limit, { filter, all: false });
        if (!dataset) throw new Error(`dataset is required to list ${kind}`);
        const ref = datasetRef(dataset, p);
        const res = await listPaged(`projects/${ref.projectId}/datasets/${ref.datasetId}/${kind}`, kind, limit);
        // Keep list output compact: ID, type and timestamps.
        return {
          ...res,
          [kind]: (res[kind] as Record<string, unknown>[]).map((item) => {
            const ref = (item.tableReference ?? item.routineReference ?? item.modelReference) as Record<string, string> | undefined;
            return {
              id: ref ? Object.values(ref).join(".") : item.id,
              type: item.type ?? item.routineType ?? item.modelType,
              creationTime: item.creationTime,
              timePartitioning: item.timePartitioning,
            };
          }),
        };
      }),
  );

  server.registerTool(
    "bq_get",
    {
      title: "Describe dataset / table / routine / model",
      description: "Metadata for a dataset, table/view (schema, rows, size, partitioning, clustering, view SQL), routine or model.",
      inputSchema: {
        kind: z.enum(["dataset", "table", "routine", "model"]),
        id: z.string().describe("dataset | dataset.table | project.dataset.table (same for routines/models)"),
        project: schema.project,
        full: z.boolean().default(false).describe("Return the raw API object"),
      },
    },
    ({ kind, id, project: p, full }) =>
      run(async () => {
        if (kind === "dataset") {
          const ref = datasetRef(id, p);
          return bq("GET", `projects/${ref.projectId}/datasets/${ref.datasetId}`);
        }
        const ref = tableRef(id, p);
        const collection = { table: "tables", routine: "routines", model: "models" }[kind];
        const obj = (await bq("GET", `projects/${ref.projectId}/datasets/${ref.datasetId}/${collection}/${ref.tableId}`)) as Record<string, unknown>;
        if (full || kind !== "table") return obj;
        const numBytes = Number(obj.numBytes ?? 0);
        return {
          id: `${ref.projectId}.${ref.datasetId}.${ref.tableId}`,
          type: obj.type,
          description: obj.description,
          rows: obj.numRows !== undefined ? Number(obj.numRows) : undefined,
          size_gib: +(numBytes / 1024 ** 3).toFixed(3),
          location: obj.location,
          created: obj.creationTime ? new Date(Number(obj.creationTime)).toISOString() : undefined,
          modified: obj.lastModifiedTime ? new Date(Number(obj.lastModifiedTime)).toISOString() : undefined,
          expires: obj.expirationTime ? new Date(Number(obj.expirationTime)).toISOString() : undefined,
          timePartitioning: obj.timePartitioning,
          rangePartitioning: obj.rangePartitioning,
          clustering: obj.clustering,
          labels: obj.labels,
          view_sql: (obj.view as { query?: string } | undefined)?.query ?? (obj.materializedView as { query?: string } | undefined)?.query,
          schema: describeSchema((obj.schema as { fields?: [] } | undefined)?.fields),
        };
      }),
  );

  server.registerTool(
    "bq_preview_table",
    {
      title: "Preview table rows",
      description: "Read rows directly from a table without running (or paying for) a query.",
      inputSchema: {
        table: z.string(),
        project: schema.project,
        max_rows: z.number().int().min(1).max(5000).default(20),
        start_index: z.number().int().min(0).optional(),
        selected_fields: z.array(z.string()).optional(),
      },
    },
    ({ table, project: p, max_rows, start_index, selected_fields }) =>
      run(async () => {
        const ref = tableRef(table, p);
        const meta = (await bq("GET", tablePath(ref), undefined, { selectedFields: selected_fields?.join(",") })) as { schema?: { fields?: [] } };
        const data = (await bq("GET", `${tablePath(ref)}/data`, undefined, {
          maxResults: max_rows,
          startIndex: start_index,
          selectedFields: selected_fields?.join(","),
          "formatOptions.useInt64Timestamp": true,
        })) as { rows?: { f: { v: unknown }[] }[]; totalRows?: string; pageToken?: string };
        return { total_rows: Number(data.totalRows ?? 0), page_token: data.pageToken, rows: rowsToObjects(meta.schema, data.rows) };
      }),
  );

  server.registerTool(
    "bq_create_dataset",
    {
      title: "Create dataset",
      description: "Create a dataset.",
      inputSchema: {
        dataset: z.string(),
        project: schema.project,
        location: schema.location,
        description: z.string().optional(),
        default_table_expiration_days: z.number().positive().optional(),
        labels: z.record(z.string()).optional(),
      },
    },
    (args) =>
      run(() => {
        const ref = datasetRef(args.dataset, args.project);
        return bq("POST", `projects/${ref.projectId}/datasets`, {
          datasetReference: ref,
          location: location(args.location),
          description: args.description,
          defaultTableExpirationMs: args.default_table_expiration_days ? String(args.default_table_expiration_days * 86_400_000) : undefined,
          labels: args.labels,
        });
      }),
  );

  server.registerTool(
    "bq_create_table",
    {
      title: "Create table or view",
      description:
        "Create a table (with schema, partitioning, clustering), a view (view_sql) or a materialized view. For CREATE TABLE AS SELECT, just use bq_query with DDL.",
      inputSchema: {
        table: z.string().describe("dataset.table or project.dataset.table"),
        project: schema.project,
        fields: z.array(fieldSchema).optional(),
        view_sql: z.string().optional(),
        materialized: z.boolean().default(false),
        partition_field: z.string().optional().describe("DATE/TIMESTAMP column; omit with partition_type for ingestion-time"),
        partition_type: z.enum(["DAY", "HOUR", "MONTH", "YEAR"]).optional(),
        require_partition_filter: z.boolean().optional(),
        clustering_fields: z.array(z.string()).max(4).optional(),
        description: z.string().optional(),
        expiration_days: z.number().positive().optional(),
        labels: z.record(z.string()).optional(),
      },
    },
    (args) =>
      run(() => {
        const ref = tableRef(args.table, args.project);
        const partitioned = args.partition_field || args.partition_type;
        return bq("POST", `projects/${ref.projectId}/datasets/${ref.datasetId}/tables`, {
          tableReference: ref,
          schema: args.fields ? { fields: args.fields } : undefined,
          view: args.view_sql && !args.materialized ? { query: args.view_sql, useLegacySql: false } : undefined,
          materializedView: args.view_sql && args.materialized ? { query: args.view_sql } : undefined,
          timePartitioning: partitioned ? { type: args.partition_type ?? "DAY", field: args.partition_field } : undefined,
          requirePartitionFilter: args.require_partition_filter,
          clustering: args.clustering_fields ? { fields: args.clustering_fields } : undefined,
          description: args.description,
          expirationTime: args.expiration_days ? String(Date.now() + args.expiration_days * 86_400_000) : undefined,
          labels: args.labels,
        });
      }),
  );

  server.registerTool(
    "bq_update",
    {
      title: "Update dataset / table",
      description:
        "PATCH a dataset or table: description, labels, expiration, add columns (send the full new schema), view SQL, access list, etc. e.g. {\"description\":\"...\",\"labels\":{\"team\":\"growth\"}}",
      inputSchema: {
        kind: z.enum(["dataset", "table"]),
        id: z.string(),
        project: schema.project,
        fields: z.record(z.unknown()),
      },
    },
    ({ kind, id, project: p, fields }) =>
      run(() => {
        if (kind === "dataset") {
          const ref = datasetRef(id, p);
          return bq("PATCH", `projects/${ref.projectId}/datasets/${ref.datasetId}`, fields);
        }
        return bq("PATCH", tablePath(tableRef(id, p)), fields);
      }),
  );

  server.registerTool(
    "bq_delete",
    {
      title: "Delete dataset / table / routine / model",
      description: "Permanently delete. Deleting a non-empty dataset needs delete_contents=true.",
      inputSchema: {
        kind: z.enum(["dataset", "table", "routine", "model"]),
        id: z.string(),
        project: schema.project,
        delete_contents: z.boolean().default(false),
        confirm: schema.confirm,
      },
    },
    ({ kind, id, project: p, delete_contents }) =>
      run(async () => {
        if (kind === "dataset") {
          const ref = datasetRef(id, p);
          await bq("DELETE", `projects/${ref.projectId}/datasets/${ref.datasetId}`, undefined, { deleteContents: delete_contents });
        } else {
          const ref = tableRef(id, p);
          const collection = { table: "tables", routine: "routines", model: "models" }[kind];
          await bq("DELETE", `projects/${ref.projectId}/datasets/${ref.datasetId}/${collection}/${ref.tableId}`);
        }
        return { deleted: `${kind} ${id}` };
      }),
  );
}
