#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startStdio } from "../shared/server.js";
import { registerDealTools } from "./tools/deals.js";
import { registerPeopleTools } from "./tools/people.js";
import { registerSetupTools } from "./tools/setup.js";

const server = new McpServer(
  { name: "pipedrive", version: "0.1.0" },
  {
    instructions:
      "Pipedrive via API v2 (v1 where v2 has no endpoint) with your personal API token. Pipelines, stages, owners (name, email or \"me\"), people/organizations (name or email, created if missing) and custom fields (by name, options by label) are resolved automatically. Start with pipedrive_report for numbers or pipedrive_search to find anything. Deletes and merges need confirm: true.",
  },
);

registerDealTools(server);
registerPeopleTools(server);
registerSetupTools(server);

await startStdio(server, "pipedrive");
