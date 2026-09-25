#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startStdio } from "../shared/server.js";
import { registerBusinessTools } from "./tools/business.js";
import { registerCrmTools } from "./tools/crm.js";
import { registerRecordTools } from "./tools/records.js";

const server = new McpServer(
  { name: "odoo", version: "0.1.0" },
  {
    instructions:
      "Odoo via the external API (JSON-2 on Odoo 19+, JSON-RPC on older versions) with the user's API key and access rights. CRM work: odoo_crm_leads, odoo_crm_pipeline, odoo_activities; customers: odoo_contacts; sales and invoices: odoo_sales, odoo_invoices; anything else: odoo_records / odoo_call on any model (check odoo_models first for field names). Relations accept names (customer, salesperson, stage, tags); dates accept today/tomorrow/+3d. Deletes, merges, confirming orders, posting invoices and messages to customers need confirm: true.",
  },
);

registerCrmTools(server);
registerBusinessTools(server);
registerRecordTools(server);

await startStdio(server, "odoo");
