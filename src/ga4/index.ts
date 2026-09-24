#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startStdio } from "../shared/server.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerMiscTools } from "./tools/misc.js";
import { registerReportTools } from "./tools/reports.js";

const server = new McpServer({ name: "ga4", version: "0.1.0" });

registerReportTools(server);
registerAdminTools(server);
registerMiscTools(server);

await startStdio(server, "ga4");
