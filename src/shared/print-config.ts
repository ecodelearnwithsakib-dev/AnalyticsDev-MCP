#!/usr/bin/env node
/**
 * Prints ready-to-paste MCP config for an AI app, with absolute paths for this machine:
 *   npm run config -- <client> [server,server…] [--profile <client-name>] [--read-only]
 * Run without arguments to list every supported client. Servers default to every built server.
 * --profile adds MCP_PROFILE (agency mode: reads .env.<profile>) and suffixes the server names;
 * --read-only adds MCP_READ_ONLY=true so write tools and write actions are disabled.
 */
import { homedir, platform } from "node:os";
import { REMOTE_SERVERS, entry, envKeys, pick, projectRoot, SERVERS, type ServerInfo } from "./servers.js";

const node = process.execPath; // absolute, so GUI apps without your shell PATH still find Node
const home = homedir();
const mac = platform() === "darwin";
const win = platform() === "win32";

const argv = process.argv.slice(2);
function takeFlag(name: string, withValue: boolean): string | boolean | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = withValue ? argv[i + 1] : true;
  argv.splice(i, withValue ? 2 : 1);
  return v;
}
const profileFlag = (takeFlag("profile", true) as string | undefined)?.replace(/[^\w.-]/g, "");
const readOnly = takeFlag("read-only", false) === true;
/** Extra environment for every server entry (never secrets — only switches). */
const ENV: Record<string, string> = { ...(profileFlag ? { MCP_PROFILE: profileFlag } : {}), ...(readOnly ? { MCP_READ_ONLY: "true" } : {}) };
const hasEnv = Object.keys(ENV).length > 0;
const envObj = () => (hasEnv ? { env: ENV } : {});
const suffix = `${profileFlag ? `-${profileFlag}` : ""}${readOnly ? "-ro" : ""}`;

const json = (o: unknown) => JSON.stringify(o, null, 2);
const std = (list: ServerInfo[], extra: Record<string, unknown> = {}) => ({ mcpServers: Object.fromEntries(list.map((s) => [s.name, { command: node, args: [entry(s)], ...envObj(), ...extra }])) });
const tomlEnv = () => (hasEnv ? `env = { ${Object.entries(ENV).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")} }\n` : "");
const cliEnv = (flag: string) => Object.entries(ENV).map(([k, v]) => `${flag} ${k}=${v} `).join("");
const tomlStr = (s: string) => JSON.stringify(s);

type Client = { title: string; file?: string; how: string; render: (l: ServerInfo[]) => string };

const appData = process.env.APPDATA ?? `${home}\\AppData\\Roaming`;
const CLIENTS: Record<string, Client> = {
  "claude-code": {
    title: "Claude Code (CLI, desktop app Code tab, VS Code/JetBrains extensions)",
    how: "Run these once in a terminal; --scope user makes them available in every project. Check with `claude mcp list`.",
    render: (l) => l.map((s) => `claude mcp add --scope user ${cliEnv("-e")}${s.name} -- ${JSON.stringify(node)} ${JSON.stringify(entry(s))}`).join("\n"),
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
      `${json({ servers: Object.fromEntries(l.map((s) => [s.name, { type: "stdio", command: node, args: [entry(s)], ...envObj() }])) })}\n\n# or, one by one:\n${l.map((s) => `code --add-mcp ${JSON.stringify(JSON.stringify({ name: s.name, command: node, args: [entry(s)], ...envObj() }))}`).join("\n")}`,
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
      `${l.map((s) => `[mcp_servers.${s.name.replace(/[^a-z0-9_]/gi, "_")}]\ncommand = ${tomlStr(node)}\nargs = [${tomlStr(entry(s))}]\n${tomlEnv()}startup_timeout_sec = 30\ntool_timeout_sec = 300\n`).join("\n")}\n# or:\n${l.map((s) => `codex mcp add ${cliEnv("--env")}${s.name} -- ${JSON.stringify(node)} ${JSON.stringify(entry(s))}`).join("\n")}`,
  },
  gemini: {
    title: "Gemini CLI (and Gemini Code Assist agent mode)",
    file: `${home}/.gemini/settings.json`,
    how: "Merge into ~/.gemini/settings.json (or .gemini/settings.json in a project), or run the `gemini mcp add -s user` lines. Check with /mcp inside Gemini CLI.",
    render: (l) => `${json({ mcpServers: Object.fromEntries(l.map((s) => [s.name, { command: node, args: [entry(s)], cwd: projectRoot, timeout: 300000, ...envObj() }])) })}\n\n# or:\n${l.map((s) => `gemini mcp add -s user ${cliEnv("-e")}${s.name} ${JSON.stringify(node)} ${JSON.stringify(entry(s))}`).join("\n")}`,
  },
  zed: {
    title: "Zed",
    file: mac || !win ? `${home}/.config/zed/settings.json` : `${appData}\\Zed\\settings.json`,
    how: "Zed → Settings → Open Settings (settings.json). Merge the context_servers block; the Agent panel shows each server's status.",
    render: (l) => json({ context_servers: Object.fromEntries(l.map((s) => [s.name, { source: "custom", command: node, args: [entry(s)], env: ENV }])) }),
  },
  cline: {
    title: "Cline (VS Code extension)",
    file: "Cline → MCP Servers → Installed → Configure MCP Servers (cline_mcp_settings.json)",
    how: "Merge the block and save; Cline restarts the servers automatically.",
    render: (l) => json({ mcpServers: Object.fromEntries(l.map((s) => [s.name, { command: node, args: [entry(s)], ...envObj(), disabled: false, autoApprove: [], timeout: 300 }])) }),
  },
  continue: {
    title: "Continue (VS Code / JetBrains)",
    file: `${home}/.continue/config.yaml (or one file per server in .continue/mcpServers/)`,
    how: "Add under mcpServers in config.yaml; MCP tools work in Agent mode.",
    render: (l) => `mcpServers:\n${l.map((s) => `  - name: ${s.name}\n    command: ${JSON.stringify(node)}\n    args:\n      - ${JSON.stringify(entry(s))}${hasEnv ? `\n    env:\n${Object.entries(ENV).map(([k, v]) => `      ${k}: "${v}"`).join("\n")}` : ""}`).join("\n")}`,
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
    render: (l) => `extensions:\n${l.map((s) => `  ${s.name}:\n    name: ${s.name}\n    type: stdio\n    cmd: ${JSON.stringify(node)}\n    args:\n      - ${JSON.stringify(entry(s))}${hasEnv ? `\n    envs:\n${Object.entries(ENV).map(([k, v]) => `      ${k}: "${v}"`).join("\n")}` : ""}\n    enabled: true\n    timeout: 300`).join("\n")}`,
  },
  opencode: {
    title: "opencode",
    file: `${home}/.config/opencode/opencode.json`,
    how: "Merge the mcp block into opencode.json.",
    render: (l) => json({ mcp: Object.fromEntries(l.map((s) => [s.name, { type: "local", command: [node, entry(s)], enabled: true, ...(hasEnv ? { environment: ENV } : {}) }])) }),
  },
  antigravity: {
    title: "Google Antigravity (IDE, Antigravity 2.0 app and CLI)",
    file: win ? `${home}\\.gemini\\config\\mcp_config.json` : `${home}/.gemini/config/mcp_config.json`,
    how: "IDE: Agent panel (…) → MCP Servers → Manage MCP Servers → View raw config. Antigravity 2.0: Settings → Customizations → Installed MCP Servers. CLI: /mcp. Merge, save, press Refresh. Project-only: .agents/mcp_config.json.",
    render: (l) => json({ mcpServers: Object.fromEntries(l.map((s) => [s.name, { command: node, args: [entry(s)], cwd: projectRoot, ...envObj() }])) }),
  },
  warp: {
    title: "Warp (terminal agent)",
    how: "Warp → Settings → AI → Manage MCP servers → + Add → paste the JSON → Save; start each server from the list.",
    render: (l) => json(std(l)),
  },
  trae: {
    title: "Trae (IDE)",
    how: "Trae → Settings (gear) → MCP → Add → Add Manually → paste the JSON → Confirm. Use it from an agent that has the MCP tools enabled.",
    render: (l) => json(std(l)),
  },
  augment: {
    title: "Augment Code (VS Code / JetBrains)",
    how: "Augment panel → Settings (gear) → MCP → Import from JSON → paste → Save.",
    render: (l) => json(std(l)),
  },
  roo: {
    title: "Roo Code",
    file: "Roo Code → MCP Servers icon → Edit Global MCP (mcp_settings.json)",
    how: "Merge and save; Roo restarts servers automatically. Leave alwaysAllow empty so write actions ask you first.",
    render: (l) => json({ mcpServers: Object.fromEntries(l.map((s) => [s.name, { command: node, args: [entry(s)], ...envObj(), disabled: false, alwaysAllow: [], timeout: 300 }])) }),
  },
  kilo: {
    title: "Kilo Code",
    file: "Kilo Code → MCP Servers → Edit Global MCP (mcp_settings.json)",
    how: "Merge and save.",
    render: (l) => json({ mcpServers: Object.fromEntries(l.map((s) => [s.name, { command: node, args: [entry(s)], ...envObj(), disabled: false, alwaysAllow: [], timeout: 300 }])) }),
  },
  devin: {
    title: "Devin (Cognition) — cloud agent",
    how: "Devin runs in its own cloud machine, so the servers are installed there. 1) Settings → Devin's Machine: add this repo and the setup commands below. 2) Settings → Secrets: add the env names listed per server. 3) Customize → MCPs → Add MCP → Add custom MCP → transport STDIO → Command/Arguments below → Save → Use MCP. (Or use the HTTP gateway: transport HTTP + Auth Header.)",
    render: (l) =>
      [
        "# Machine setup (Devin's Machine → repository setup):",
        "git clone https://github.com/ecodelearnwithsakib-dev/AnalyticsDev-MCP.git ~/repos/AnalyticsDev-MCP  # private repo: connect it to Devin's GitHub integration",
        "cd ~/repos/AnalyticsDev-MCP && npm ci && npm run build",
        "",
        ...l.flatMap((s) => [`## ${s.name} — ${s.title}`, `Name: ${s.name}`, "Transport: STDIO", "Command: node", `Arguments: /home/ubuntu/repos/AnalyticsDev-MCP/dist/${s.dir}/index.js`, `Secrets / env: ${envKeys(s).join(", ") || "(none)"}`, ...(hasEnv ? [`Extra env (plain values): ${Object.entries(ENV).map(([k, v]) => `${k}=${v}`).join(", ")}`] : []), ""]),
        "# CLI alternative (Devin CLI):",
        ...l.map((s) => `devin mcp add ${s.name} -- node ~/repos/AnalyticsDev-MCP/dist/${s.dir}/index.js`),
      ].join("\n"),
  },
  "copilot-agent": {
    title: "GitHub Copilot coding agent (runs in GitHub Actions)",
    how: "Repository → Settings → Copilot → Coding agent → MCP configuration: paste the JSON. Add each secret to the repo's `copilot` environment with a COPILOT_MCP_ prefix, and install the servers in .github/workflows/copilot-setup-steps.yml (printed below).",
    render: (l) =>
      `${json({
        mcpServers: Object.fromEntries(
          l.map((s) => [s.name, { type: "local", command: "node", args: [`/home/runner/AnalyticsDev-MCP/dist/${s.dir}/index.js`], tools: ["*"], env: { ...Object.fromEntries(envKeys(s).map((k) => [k, `COPILOT_MCP_${k}`])), ...ENV } }]),
        ),
      })}\n\n# .github/workflows/copilot-setup-steps.yml\non: workflow_dispatch\njobs:\n  copilot-setup-steps:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v4\n        with: { node-version: 22 }\n      - run: git clone https://x-access-token:\${{ secrets.MCP_REPO_TOKEN }}@github.com/ecodelearnwithsakib-dev/AnalyticsDev-MCP.git ~/AnalyticsDev-MCP && cd ~/AnalyticsDev-MCP && npm ci && npm run build`,
  },
  remote: {
    title: "Remote-only apps: ChatGPT, claude.ai web & mobile, Le Chat, Copilot Studio, Open WebUI…",
    how: "These apps need an HTTPS URL. Start the gateway (`npm run serve -- <servers>`), put a tunnel in front of it, then add each URL as a connector. See docs/LLM-PLATFORMS.md.",
    render: (l) =>
      [
        `${hasEnv ? Object.entries(ENV).map(([k, v]) => `${k}=${v}`).join(" ") + " " : ""}npm run serve -- ${l.map((s) => s.dir).join(",")}`,
        "",
        "# Connector URLs once your tunnel is up (https://YOUR-TUNNEL):",
        ...l.map((s) => `${s.name.padEnd(14)} https://YOUR-TUNNEL/<MCP_GATEWAY_TOKEN>/${s.dir}/mcp   (secret-path auth: claude.ai, Le Chat)`),
        ...l.map((s) => `${s.name.padEnd(14)} https://YOUR-TUNNEL/${s.dir}/mcp   + Bearer <MCP_GATEWAY_TOKEN>   (token auth: ChatGPT, Open WebUI)`),
        "",
        "# Official remote servers you can add directly as connectors (OAuth):",
        ...REMOTE_SERVERS.map((r) => `${r.name.padEnd(20)} ${r.url}`),
      ].join("\n"),
  },
};

const [clientArg, ...rest] = argv;
if (!clientArg || !CLIENTS[clientArg]) {
  console.log(`Usage: npm run config -- <client> [servers] [--profile <client-name>] [--read-only]\n\nClients:\n${Object.entries(CLIENTS).map(([k, c]) => `  ${k.padEnd(15)} ${c.title}`).join("\n")}\n\nServers: ${SERVERS.map((s) => s.name).join(", ")} (default: all built)`);
  process.exit(clientArg ? 1 : 0);
}
const list = pick(rest).map((s) => ({ ...s, name: `${s.name}${suffix}` }));
if (!list.length) {
  console.error("No built servers found — run `npm run build` first.");
  process.exit(1);
}
const c = CLIENTS[clientArg];
console.log(`# ${c.title}`);
if (c.file) console.log(`# File: ${c.file}`);
console.log(`# ${c.how}`);
console.log(`# Secrets stay in ${projectRoot}/${profileFlag ? `.env.${profileFlag}` : ".env"} — nothing secret is printed here.${readOnly ? " Read-only: write tools are disabled." : ""}\n`);
console.log(c.render(list));
