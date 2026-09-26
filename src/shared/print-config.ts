#!/usr/bin/env node
/**
 * Prints ready-to-paste MCP config for an AI app, with absolute paths for this machine:
 *   npm run config -- <client> [server,server…]
 * Clients: claude-code, claude-desktop, cursor, vscode, windsurf, codex, gemini, zed, cline, continue,
 * jetbrains, lmstudio, amazonq, kiro, goose, opencode, remote. Servers default to every built server.
 */
import { homedir, platform } from "node:os";
import { REMOTE_SERVERS, entry, pick, projectRoot, SERVERS, type ServerInfo } from "./servers.js";

const node = process.execPath; // absolute, so GUI apps without your shell PATH still find Node
const home = homedir();
const mac = platform() === "darwin";
const win = platform() === "win32";

const json = (o: unknown) => JSON.stringify(o, null, 2);
const std = (list: ServerInfo[], extra: Record<string, unknown> = {}) => ({ mcpServers: Object.fromEntries(list.map((s) => [s.name, { command: node, args: [entry(s)], ...extra }])) });
const tomlStr = (s: string) => JSON.stringify(s);

type Client = { title: string; file?: string; how: string; render: (l: ServerInfo[]) => string };

const appData = process.env.APPDATA ?? `${home}\\AppData\\Roaming`;
const CLIENTS: Record<string, Client> = {
  "claude-code": {
    title: "Claude Code (CLI, desktop app Code tab, VS Code/JetBrains extensions)",
    how: "Run these once in a terminal; --scope user makes them available in every project. Check with `claude mcp list`.",
    render: (l) => l.map((s) => `claude mcp add --scope user ${s.name} -- ${JSON.stringify(node)} ${JSON.stringify(entry(s))}`).join("\n"),
  },
  "claude-desktop": {
    title: "Claude Desktop (Chat / Cowork)",
    file: mac ? `${home}/Library/Application Support/Claude/claude_desktop_config.json` : win ? `${appData}\\Claude\\claude_desktop_config.json` : `${home}/.config/Claude/claude_desktop_config.json`,
    how: "Claude Desktop → Settings → Developer → Edit Config. Merge the mcpServers block into the file, save, then fully quit and reopen Claude.",
    render: (l) => json(std(l)),
  },
  cursor: {
    title: "Cursor",
    file: `${home}/.cursor/mcp.json`,
    how: "Cursor → Settings → MCP → Add new global MCP server (opens this file). Use .cursor/mcp.json in a project for project-only servers.",
    render: (l) => json(std(l)),
  },
  vscode: {
    title: "VS Code (GitHub Copilot agent mode)",
    file: "User mcp.json — Command Palette → “MCP: Open User Configuration” (or .vscode/mcp.json per workspace)",
    how: "Paste the servers block, then start each server from the MCP view or when Copilot Chat (Agent mode) asks. One-liners with `code --add-mcp` are printed below the JSON.",
    render: (l) =>
      `${json({ servers: Object.fromEntries(l.map((s) => [s.name, { type: "stdio", command: node, args: [entry(s)] }])) })}\n\n# or, one by one:\n${l.map((s) => `code --add-mcp ${JSON.stringify(JSON.stringify({ name: s.name, command: node, args: [entry(s)] }))}`).join("\n")}`,
  },
  windsurf: {
    title: "Windsurf (Cascade)",
    file: `${home}/.codeium/windsurf/mcp_config.json`,
    how: "Windsurf → Settings → Cascade → MCP Servers → View raw config. Merge, save, then press Refresh.",
    render: (l) => json(std(l)),
  },
  codex: {
    title: "OpenAI Codex (CLI and IDE extension)",
    file: `${home}/.codex/config.toml`,
    how: "Append to ~/.codex/config.toml (shared by the Codex CLI and the Codex IDE extension), or run the `codex mcp add` lines. Long reports may need a higher tool_timeout_sec.",
    render: (l) =>
      `${l.map((s) => `[mcp_servers.${s.name.replace(/[^a-z0-9_]/gi, "_")}]\ncommand = ${tomlStr(node)}\nargs = [${tomlStr(entry(s))}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 300\n`).join("\n")}\n# or:\n${l.map((s) => `codex mcp add ${s.name} -- ${JSON.stringify(node)} ${JSON.stringify(entry(s))}`).join("\n")}`,
  },
  gemini: {
    title: "Gemini CLI (and Gemini Code Assist agent mode)",
    file: `${home}/.gemini/settings.json`,
    how: "Merge into ~/.gemini/settings.json (or .gemini/settings.json in a project), or run the `gemini mcp add -s user` lines. Check with /mcp inside Gemini CLI.",
    render: (l) => `${json({ mcpServers: Object.fromEntries(l.map((s) => [s.name, { command: node, args: [entry(s)], cwd: projectRoot, timeout: 300000 }])) })}\n\n# or:\n${l.map((s) => `gemini mcp add -s user ${s.name} ${JSON.stringify(node)} ${JSON.stringify(entry(s))}`).join("\n")}`,
  },
  zed: {
    title: "Zed",
    file: mac || !win ? `${home}/.config/zed/settings.json` : `${appData}\\Zed\\settings.json`,
    how: "Zed → Settings → Open Settings (settings.json). Merge the context_servers block; the Agent panel shows each server's status.",
    render: (l) => json({ context_servers: Object.fromEntries(l.map((s) => [s.name, { source: "custom", command: node, args: [entry(s)], env: {} }])) }),
  },
  cline: {
    title: "Cline (VS Code extension)",
    file: "Cline → MCP Servers → Installed → Configure MCP Servers (cline_mcp_settings.json)",
    how: "Merge the block and save; Cline restarts the servers automatically.",
    render: (l) => json({ mcpServers: Object.fromEntries(l.map((s) => [s.name, { command: node, args: [entry(s)], disabled: false, autoApprove: [], timeout: 300 }])) }),
  },
  continue: {
    title: "Continue (VS Code / JetBrains)",
    file: `${home}/.continue/config.yaml (or one file per server in .continue/mcpServers/)`,
    how: "Add under mcpServers in config.yaml; MCP tools work in Agent mode.",
    render: (l) => `mcpServers:\n${l.map((s) => `  - name: ${s.name}\n    command: ${JSON.stringify(node)}\n    args:\n      - ${JSON.stringify(entry(s))}`).join("\n")}`,
  },
  jetbrains: {
    title: "JetBrains AI Assistant / Junie (IntelliJ, PyCharm, WebStorm…)",
    how: "Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add → “As JSON”, paste, then Apply.",
    render: (l) => json(std(l)),
  },
  lmstudio: {
    title: "LM Studio (local models)",
    file: `${home}/.lmstudio/mcp.json`,
    how: "LM Studio → Program tab → Install → Edit mcp.json. Use a model with tool-calling support.",
    render: (l) => json(std(l)),
  },
  amazonq: {
    title: "Amazon Q Developer (CLI / IDE)",
    file: `${home}/.aws/amazonq/mcp.json`,
    how: "Merge into the file (or use `q mcp add`). Restart Q afterwards.",
    render: (l) => json(std(l, { timeout: 300000 })),
  },
  kiro: {
    title: "Kiro",
    file: `${home}/.kiro/settings/mcp.json`,
    how: "Kiro → MCP servers → Open user config. Merge and save.",
    render: (l) => json(std(l, { disabled: false, autoApprove: [] })),
  },
  goose: {
    title: "Goose (Block)",
    file: `${home}/.config/goose/config.yaml`,
    how: "Add under extensions (or run `goose configure` → Add Extension → Command-line Extension).",
    render: (l) => `extensions:\n${l.map((s) => `  ${s.name}:\n    name: ${s.name}\n    type: stdio\n    cmd: ${JSON.stringify(node)}\n    args:\n      - ${JSON.stringify(entry(s))}\n    enabled: true\n    timeout: 300`).join("\n")}`,
  },
  opencode: {
    title: "opencode",
    file: `${home}/.config/opencode/opencode.json`,
    how: "Merge the mcp block into opencode.json.",
    render: (l) => json({ mcp: Object.fromEntries(l.map((s) => [s.name, { type: "local", command: [node, entry(s)], enabled: true }])) }),
  },
  remote: {
    title: "Remote-only apps: ChatGPT, claude.ai web & mobile, Le Chat, Copilot Studio, Open WebUI…",
    how: "These apps need an HTTPS URL. Start the gateway (`npm run serve -- <servers>`), put a tunnel in front of it, then add each URL as a connector. See docs/LLM-PLATFORMS.md.",
    render: (l) =>
      [
        "npm run serve -- " + l.map((s) => s.name).join(","),
        "",
        "# Connector URLs once your tunnel is up (https://YOUR-TUNNEL):",
        ...l.map((s) => `${s.name.padEnd(14)} https://YOUR-TUNNEL/<MCP_GATEWAY_TOKEN>/${s.name}/mcp   (secret-path auth: claude.ai, Le Chat)`),
        ...l.map((s) => `${s.name.padEnd(14)} https://YOUR-TUNNEL/${s.name}/mcp   + Bearer <MCP_GATEWAY_TOKEN>   (token auth: ChatGPT, Open WebUI)`),
        "",
        "# Official remote servers you can add directly as connectors (OAuth):",
        ...REMOTE_SERVERS.map((r) => `${r.name.padEnd(20)} ${r.url}`),
      ].join("\n"),
  },
};

const [clientArg, ...rest] = process.argv.slice(2);
if (!clientArg || !CLIENTS[clientArg]) {
  console.log(`Usage: npm run config -- <client> [servers]\n\nClients:\n${Object.entries(CLIENTS).map(([k, c]) => `  ${k.padEnd(15)} ${c.title}`).join("\n")}\n\nServers: ${SERVERS.map((s) => s.name).join(", ")} (default: all built)`);
  process.exit(clientArg ? 1 : 0);
}
const list = pick(rest);
if (!list.length) {
  console.error("No built servers found — run `npm run build` first.");
  process.exit(1);
}
const c = CLIENTS[clientArg];
console.log(`# ${c.title}`);
if (c.file) console.log(`# File: ${c.file}`);
console.log(`# ${c.how}`);
console.log(`# Secrets stay in ${projectRoot}/.env — nothing secret is printed here.\n`);
console.log(c.render(list));
