#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startStdio } from "../shared/server.js";
import { registerAudienceTools } from "./tools/audiences.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerConversionTools } from "./tools/conversions.js";
import { registerManageTools } from "./tools/manage.js";
import { registerReportingTools } from "./tools/reporting.js";

const server = new McpServer({ name: "openai-ads", version: "0.1.0" });

registerReportingTools(server);
registerManageTools(server);
registerAudienceTools(server);
registerConversionTools(server);
registerCatalogTools(server);

await startStdio(server, "openai-ads");
