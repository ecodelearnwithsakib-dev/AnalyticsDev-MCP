#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startStdio } from "../shared/server.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerRecordTools } from "./tools/records.js";

const server = new McpServer(
  { name: "zoho-crm", version: "0.1.0" },
  {
    instructions:
      "Zoho CRM via REST API v8. Modules use API names (Leads, Contacts, Accounts, Deals, Tasks, …); fields may be given by label or API name — check zoho_crm_metadata what=fields/picklists before writing. Use zoho_crm_search for simple lookups, zoho_crm_query (COQL) for joins and aggregates, zoho_crm_pipeline for sales numbers. Owners accept names, emails or \"me\". Deletes, mass updates and emails need confirm: true.",
  },
);

registerRecordTools(server);
registerInsightTools(server);
registerAdminTools(server);

await startStdio(server, "zoho-crm");
