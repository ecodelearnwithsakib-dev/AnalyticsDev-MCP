# Read-only mode, tool filters, agency profiles and secret storage

These switches work the same way on every server, whether it runs from an AI app's config, the HTTP gateway or a cloud agent.

## Read-only mode

Set `MCP_READ_ONLY=true` for a server and:

- tools that only write (create, update, delete, send, publish, upload, mutate, set status, …) disappear from the tool list;
- multi-action tools stay, but refuse write actions (`action: "create" | "update" | "delete" | "send" | "won" | …`), anything with `confirm: true`, and non-GET raw API calls;
- raw “call any endpoint” tools (`*_api`, `*_api_request`) are hidden.

Generate a read-only config for any app:

```bash
npm run config -- cursor ga4,meta,google-ads --read-only        # names become ga4-ro, meta-ro, …
```

Good for sharing reporting access with a client or a junior analyst, or for chat apps connected through the gateway.

## Allow / deny lists

`MCP_ALLOW_TOOLS` and `MCP_DENY_TOOLS` take comma-separated tool-name patterns with `*`:

```jsonc
"env": { "MCP_ALLOW_TOOLS": "ga4_run_*,ga4_list_*", "MCP_DENY_TOOLS": "ga4_run_access_report" }
```

The gateway accepts the same patterns with `--allow` / `--deny`.

## Agency mode: one profile per client

Keep each client's keys in its own file and switch with `MCP_PROFILE`:

```
.env            shared defaults (e.g. your Google OAuth client, developer tokens)
.env.acme       Acme's ad accounts, property IDs and tokens
.env.globex     Globex's
```

- Values load in this order: the app's `env` block → `.env.<profile>` → `.env`.
- Sign-ins (`npm run auth:*`) write to the active profile file: `MCP_PROFILE=acme npm run auth:ga4`.
- Add the same servers once per client, with the names suffixed automatically:

```bash
npm run config -- claude-code ga4,meta --profile acme
npm run config -- claude-code ga4,meta --profile globex --read-only
```

This registers `ga4-acme`, `meta-acme`, `ga4-globex-ro`, `meta-globex-ro` — the AI sees which client every tool belongs to, and one client's tokens are never loaded into another's server. `.env.*` files are git-ignored.

## Secrets in the macOS Keychain or 1Password

Any value in `.env` can be a reference instead of the secret:

| Value | Read from |
|---|---|
| `keychain:NAME` | macOS Keychain, service `analyticsdev-mcp`, account `NAME` |
| `op://vault/item/field` | 1Password CLI (`op read`) |

```bash
npm run secret -- set META_ACCESS_TOKEN     # asks for the value (hidden) and stores it in the Keychain
npm run secret -- migrate                   # moves every *_TOKEN / *_SECRET / *_KEY / *_PASSWORD value out of the env file
npm run secret -- list                      # which variables use the Keychain (values never shown)
npm run secret -- delete META_ACCESS_TOKEN
```

With a profile active (`MCP_PROFILE=acme npm run secret -- migrate`) the Keychain accounts are prefixed with the profile. Refresh tokens that the servers update themselves are written back to the Keychain automatically.

## Tests and CI

`npm test` builds everything and runs:

- a smoke test per server (starts, lists tools, unique well-formed names, object schemas, real descriptions, no name clashes across servers);
- policy tests (read-only, allow/deny) including running servers;
- mock-API tests for request shapes (Pipedrive resolution, HighLevel confirm + API version, Reddit hashing and test mode, Matomo comparisons and token placement);
- config-generator tests for every supported app.

GitHub Actions runs the same on Node 20 and 22 for every push and pull request (`.github/workflows/ci.yml`).
