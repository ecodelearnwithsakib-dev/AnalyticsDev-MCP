#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startStdio } from "../shared/server.js";
import { registerBusinessTools } from "./tools/business.js";
import { registerCrmTools } from "./tools/crm.js";
import { registerEngageTools } from "./tools/engage.js";

const server = new McpServer(
  { name: "ghl", version: "0.1.0" },
  {
    instructions:
      "HighLevel (GoHighLevel / LeadConnector) API v2 with a Private Integration Token, one sub-account (location) at a time — GHL_LOCATION_ID by default or location_id per call. Start with ghl_dashboard or ghl_health. Pipelines, stages, users and custom fields accept names. Sending messages or invoices, deletes and payments need confirm: true; always show the user a message before sending it.",
  },
);

registerCrmTools(server);
registerEngageTools(server);
registerBusinessTools(server);

await startStdio(server, "ghl");
