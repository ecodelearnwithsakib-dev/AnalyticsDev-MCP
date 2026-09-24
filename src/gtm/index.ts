#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startStdio } from "../shared/server.js";
import { registerBuilderTools } from "./tools/builders.js";
import { registerCoreTools } from "./tools/core.js";
import { registerWorkflowTools } from "./tools/workflow.js";

const server = new McpServer({ name: "gtm", version: "0.2.0" });

registerCoreTools(server);
registerWorkflowTools(server);
registerBuilderTools(server);

await startStdio(server, "gtm");
