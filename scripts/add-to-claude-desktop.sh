#!/bin/sh
# Adds Analytics Dev servers to Claude Desktop as "Analytics Dev <Platform>".
#   sh scripts/add-to-claude-desktop.sh            every server
#   sh scripts/add-to-claude-desktop.sh gtm ga4    only these
# Claude rewrites its config while it is open, so this quits Claude, edits the config
# (backup kept next to it) and reopens Claude. Run it from the macOS Terminal app, not
# from inside Claude. Your other MCP servers are left untouched.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js not found — install it from nodejs.org"; exit 1; }
[ -f "$ROOT/dist/shared/servers.js" ] || { echo "Run npm run build first"; exit 1; }
case "$(uname)" in
  Darwin) CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
  *) CONFIG="${APPDATA:-$HOME/.config}/Claude/claude_desktop_config.json" ;;
esac
APP="/Applications/Claude.app/Contents/MacOS/Claude"

running() { ps -axo comm 2>/dev/null | grep -qx "$APP"; }
if running; then
  echo "Quitting Claude…"
  osascript -e 'quit app "Claude"' >/dev/null 2>&1 || true
  i=0; while running && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
  if running; then echo "Claude is still open — quit it with Cmd+Q and run this again."; exit 1; fi
  REOPEN=1
fi

mkdir -p "$(dirname "$CONFIG")"
[ -f "$CONFIG" ] && cp -p "$CONFIG" "$CONFIG.backup-$(date +%Y%m%d-%H%M%S)"
"$NODE" --input-type=module -e '
import fs from "node:fs";
const [config, root, node, ...wanted] = process.argv.slice(1);
const { SERVERS, entry, displayName } = await import("file://" + root + "/dist/shared/servers.js");
const list = wanted.length ? wanted.map((n) => SERVERS.find((s) => s.name === n || s.dir === n) ?? (() => { throw new Error("Unknown server " + n); })()) : SERVERS;
const c = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, "utf8")) : {};
c.mcpServers = c.mcpServers || {};
for (const s of list) {
  const path = entry(s);
  for (const [k, v] of Object.entries(c.mcpServers)) if ((v.args || []).includes(path)) delete c.mcpServers[k]; // replace older entries for the same server
  c.mcpServers[displayName(s)] = { command: node, args: [path] };
}
fs.writeFileSync(config, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
console.log("Added " + list.length + " server(s): " + list.map(displayName).join(", "));
' "$CONFIG" "$ROOT" "$NODE" "$@"

if [ -n "$REOPEN" ]; then echo "Opening Claude…"; open -a Claude; fi
echo "Done. Claude → Settings → Developer lists them; turn off the ones you don't use in the chat's tools menu."
