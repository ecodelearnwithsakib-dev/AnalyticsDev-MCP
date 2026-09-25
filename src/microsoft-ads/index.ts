#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startStdio } from "../shared/server.js";
import { registerManageTools } from "./tools/manage.js";
import { registerPlanningTools } from "./tools/planning.js";
import { registerReportingTools } from "./tools/reporting.js";

const server = new McpServer({ name: "microsoft-ads", version: "0.1.0" });

registerReportingTools(server);
registerManageTools(server);
registerPlanningTools(server);

await startStdio(server, "microsoft-ads");
