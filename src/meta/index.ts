#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startStdio } from "../shared/server.js";
import { registerAdsTools } from "./tools/ads.js";
import { registerAudienceTools } from "./tools/audiences.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerInstagramTools } from "./tools/instagram.js";
import { registerPageTools } from "./tools/pages.js";
import { registerTrackingTools } from "./tools/tracking.js";

const server = new McpServer({ name: "meta", version: "0.2.0" });

registerGraphTools(server);
registerAdsTools(server);
registerAudienceTools(server);
registerTrackingTools(server);
registerPageTools(server);
registerInstagramTools(server);
registerCatalogTools(server);

await startStdio(server, "meta");
