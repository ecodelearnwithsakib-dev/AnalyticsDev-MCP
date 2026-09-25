#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startStdio } from "../shared/server.js";
import { registerExtraTools } from "./tools/extras.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerWorkspaceTools } from "./tools/workspace.js";

const server = new McpServer(
  { name: "clickup", version: "0.1.0" },
  {
    instructions:
      "ClickUp via the REST API (personal token). Start with clickup_workspace action=hierarchy to get space/folder/list IDs. People can be given as names, emails or \"me\"; dates as YYYY-MM-DD, today, tomorrow or +3d. Deletes need confirm: true — prefer closing or archiving.",
  },
);

registerWorkspaceTools(server);
registerTaskTools(server);
registerExtraTools(server);

await startStdio(server, "clickup");
