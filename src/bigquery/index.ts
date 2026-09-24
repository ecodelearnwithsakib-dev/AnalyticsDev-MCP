#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startStdio } from "../shared/server.js";
import { registerDataTools } from "./tools/data.js";
import { registerQueryTools } from "./tools/query.js";
import { registerResourceTools } from "./tools/resources.js";

const server = new McpServer({ name: "bigquery", version: "0.1.0" });

registerQueryTools(server);
registerResourceTools(server);
registerDataTools(server);

await startStdio(server, "bigquery");
