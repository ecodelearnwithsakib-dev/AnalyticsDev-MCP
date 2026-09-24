#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import { run, startStdio } from "../shared/server.js";

const API = "https://tagmanager.googleapis.com/tagmanager/v2";

// Reads GOOGLE_APPLICATION_CREDENTIALS (service account) or gcloud ADC.
const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/tagmanager.readonly"],
});

async function gtmGet(path: string): Promise<unknown> {
  const client = await auth.getClient();
  const res = await client.request({ url: `${API}/${path}` });
  return res.data;
}

const workspacePath = {
  account_id: z.string(),
  container_id: z.string(),
  workspace_id: z.string(),
};

const server = new McpServer({ name: "gtm", version: "0.1.0" });

server.registerTool(
  "gtm_list_accounts",
  { title: "List GTM accounts", description: "List GTM accounts the credentials can access.", inputSchema: {} },
  () => run(() => gtmGet("accounts")),
);

server.registerTool(
  "gtm_list_containers",
  {
    title: "List GTM containers",
    description: "List web and server containers in a GTM account.",
    inputSchema: { account_id: z.string() },
  },
  ({ account_id }) => run(() => gtmGet(`accounts/${account_id}/containers`)),
);

server.registerTool(
  "gtm_list_workspaces",
  {
    title: "List GTM workspaces",
    description: "List workspaces in a container.",
    inputSchema: { account_id: z.string(), container_id: z.string() },
  },
  ({ account_id, container_id }) => run(() => gtmGet(`accounts/${account_id}/containers/${container_id}/workspaces`)),
);

for (const resource of ["tags", "triggers", "variables", "clients", "templates"] as const) {
  server.registerTool(
    `gtm_list_${resource}`,
    {
      title: `List GTM ${resource}`,
      description: `List ${resource} in a GTM workspace${resource === "clients" ? " (server containers only)" : ""}.`,
      inputSchema: workspacePath,
    },
    ({ account_id, container_id, workspace_id }) =>
      run(() => gtmGet(`accounts/${account_id}/containers/${container_id}/workspaces/${workspace_id}/${resource}`)),
  );
}

server.registerTool(
  "gtm_get_live_version",
  {
    title: "Get live GTM version",
    description: "Get the currently published version of a container.",
    inputSchema: { account_id: z.string(), container_id: z.string() },
  },
  ({ account_id, container_id }) => run(() => gtmGet(`accounts/${account_id}/containers/${container_id}/versions:live`)),
);

await startStdio(server, "gtm");
