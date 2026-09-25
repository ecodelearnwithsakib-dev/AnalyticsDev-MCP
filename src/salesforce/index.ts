#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startStdio } from "../shared/server.js";
import { registerDataTools } from "./tools/data.js";
import { registerSalesTools } from "./tools/sales.js";

const server = new McpServer(
  { name: "salesforce", version: "0.1.0" },
  {
    instructions:
      "Salesforce via the REST API as the signed-in user (their sharing and field security apply). Use sf_query (SOQL) for data, sf_search for text, sf_records for writes, sf_describe to learn fields and picklist values before writing, sf_pipeline / sf_leads / sf_reports for numbers. Fields accept labels, picklists accept labels, owners accept names/emails/\"me\", dates accept today/tomorrow/+3d. Deletes, bulk deletes and email actions need confirm: true.",
  },
);

registerDataTools(server);
registerSalesTools(server);

await startStdio(server, "salesforce");
