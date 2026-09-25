import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openAsBlob, statSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { hashPii, listAll, oai } from "../client.js";

const identifierType = z.enum(["email", "phone", "email_sha256", "phone_number_sha256", "gaid"]);

const members = {
  emails: z.array(z.string()).optional().describe("Raw or SHA-256 emails; raw ones are normalized and hashed locally"),
  phones: z.array(z.string()).optional().describe("With country code, e.g. +8801712345678; hashed locally as E.164"),
  gaids: z.array(z.string()).optional().describe("Android advertising IDs, sent raw (OpenAI hashes them)"),
  file_path: z.string().optional().describe("Local UTF-8 .csv/.txt customer list (for large lists or replace)"),
  file_identifier_type: identifierType.optional().describe("Column type of a single-type file; omit for mixed CSV (auto resolution)"),
};
type Members = { [K in keyof typeof members]?: z.infer<(typeof members)[K]> };

function inlineIdentifiers(m: Members) {
  return [
    ...(m.emails ?? []).map((v) => ({ identifier_type: "email_sha256", identifier: hashPii.email(v) })),
    ...(m.phones ?? []).map((v) => ({ identifier_type: "phone_number_sha256", identifier: hashPii.phoneE164(v) })),
    ...(m.gaids ?? []).map((v) => ({ identifier_type: "gaid", identifier: v.trim() })),
  ];
}

/** Uploads a customer list with purpose=custom_audience and returns the fields audience requests need. */
async function uploadList(path: string, type?: z.infer<typeof identifierType>): Promise<{
  file_id: string;
  filename: string;
  mimetype: string;
  file_size: number;
  identifier_type?: string;
  identifier_resolution?: string;
}> {
  const filename = basename(path);
  const mimetype = filename.endsWith(".txt") ? "text/plain" : "text/csv";
  const form = new FormData();
  form.append("file", await openAsBlob(path, { type: mimetype }), filename);
  form.append("purpose", "custom_audience");
  const { file_id } = (await oai("POST", "uploads", { form })) as { file_id: string };
  return {
    file_id,
    filename,
    mimetype,
    file_size: statSync(path).size,
    ...(type ? { identifier_type: type } : { identifier_resolution: "auto" }),
  };
}

type Audience = { id: string; status?: string; membership_revision?: number };

async function waitUntilSettled(id: string, seconds: number): Promise<Audience> {
  const deadline = Date.now() + seconds * 1000;
  let audience = (await oai("GET", `custom_audiences/${id}`)) as Audience;
  while (!["ready", "too_small", "failed", "archived"].includes(audience.status ?? "") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    audience = (await oai("GET", `custom_audiences/${id}`)) as Audience;
  }
  return audience;
}

export function registerAudienceTools(server: McpServer): void {
  server.registerTool(
    "oai_ads_audiences",
    {
      title: "Custom audiences",
      description:
        "List, get, create, merge or archive custom audiences (customer lists for targeting, exclusion or bid multipliers). create accepts emails/phones inline (hashed locally) or a CSV file; counts come back as privacy ranges.",
      inputSchema: {
        action: z.enum(["list", "get", "create", "merge", "archive", "operations"]).default("list"),
        audience_id: z.string().optional(),
        name: z.string().min(3).optional(),
        description: z.string().optional(),
        ...members,
        merge_ids: z.array(z.string()).optional().describe("Audiences to merge into a new one"),
        intended_use: z.enum(["inclusion", "exclusion", "bid_multiplier"]).optional().describe("list: only audiences eligible for this use"),
        confirm_archive: z.boolean().default(false),
        wait_seconds: z.number().int().min(0).max(120).default(45).describe("create: wait for an empty audience to be ready before adding inline members"),
      },
    },
    (a) =>
      run(async () => {
        const need = (v: string | undefined, name: string) => {
          if (!v) throw new Error(`${name} is required`);
          return v;
        };
        switch (a.action) {
          case "list":
            return listAll("custom_audiences", { intended_use: a.intended_use, matched_count_granularity: "granular" }, 500);
          case "get":
            return oai("GET", `custom_audiences/${need(a.audience_id, "audience_id")}`, { query: { matched_count_granularity: "granular" } });
          case "operations":
            return listAll(`custom_audiences/${need(a.audience_id, "audience_id")}/operations`, {}, 100);
          case "archive":
            if (!a.confirm_archive) throw new Error("Archived audiences can't be used again; set confirm_archive: true");
            return oai("POST", `custom_audiences/${need(a.audience_id, "audience_id")}/archive`);
          case "merge":
            if (!a.merge_ids || a.merge_ids.length < 2) throw new Error("merge_ids needs at least two audiences");
            return oai("POST", "custom_audiences/merge", { body: { name: need(a.name, "name"), custom_audience_ids: a.merge_ids }, idempotencyKey: true });
          case "create": {
            const name = need(a.name, "name");
            if (a.file_path) {
              return oai("POST", "custom_audiences", { body: { name, description: a.description, ...(await uploadList(a.file_path, a.file_identifier_type)) } });
            }
            const created = (await oai("POST", "custom_audiences", { body: { name, description: a.description } })) as Audience;
            const identifiers = inlineIdentifiers(a);
            if (!identifiers.length) return created;
            const ready = await waitUntilSettled(created.id, a.wait_seconds);
            if (ready.status !== "ready") {
              return { audience: ready, note: `Audience not ready yet; add members later with oai_ads_audience_members (audience_id ${created.id}).` };
            }
            const operation = await oai("POST", `custom_audiences/${created.id}/add`, {
              body: { identifiers, expected_revision: ready.membership_revision },
              idempotencyKey: true,
            });
            return { audience: ready, add_operation: operation, identifiers_sent: identifiers.length };
          }
        }
      }),
  );

  server.registerTool(
    "oai_ads_audience_members",
    {
      title: "Add / remove / replace audience members",
      description:
        "Add or remove people (inline emails/phones/GAIDs, hashed locally, or a CSV file), or replace the whole list from a file. The current membership revision is read automatically. Also cancel/resume/check an operation.",
      inputSchema: {
        audience_id: z.string(),
        action: z.enum(["add", "remove", "replace", "operation_status", "cancel_operation", "resume_operation"]),
        ...members,
        operation_id: z.string().optional(),
      },
    },
    (a) =>
      run(async () => {
        const base = `custom_audiences/${a.audience_id}`;
        if (a.action.endsWith("operation") || a.action === "operation_status") {
          if (!a.operation_id) throw new Error("operation_id is required");
          const path = `${base}/operations/${a.operation_id}`;
          if (a.action === "operation_status") return oai("GET", path);
          return oai("POST", `${path}/${a.action === "cancel_operation" ? "cancel" : "resume"}`);
        }
        const audience = (await oai("GET", base)) as Audience;
        const revision = audience.membership_revision ?? 0;
        if (a.action === "replace") {
          if (!a.file_path) throw new Error("replace needs file_path");
          const { file_id, identifier_type, identifier_resolution } = await uploadList(a.file_path, a.file_identifier_type);
          return oai("POST", `${base}/replace`, { body: { file_id, identifier_type, identifier_resolution, expected_revision: revision }, idempotencyKey: true });
        }
        const body: Record<string, unknown> = { expected_revision: revision };
        if (a.file_path) {
          const { file_id, identifier_type, identifier_resolution } = await uploadList(a.file_path, a.file_identifier_type);
          Object.assign(body, { file_id, identifier_type, identifier_resolution });
        } else {
          body.identifiers = inlineIdentifiers(a);
          if (!(body.identifiers as unknown[]).length) throw new Error("Provide emails, phones, gaids or file_path");
        }
        return oai("POST", `${base}/${a.action}`, { body, idempotencyKey: true });
      }),
  );
}
