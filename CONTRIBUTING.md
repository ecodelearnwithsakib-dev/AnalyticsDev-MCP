# Contributing to Analytics Dev MCP

Thanks for helping. Bug reports, new platforms, better tools and documentation fixes are all welcome.

## Ground rules

- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Never** include real credentials, tokens, `.env` contents, customer data or screenshots showing them — in code, tests, issues or pull requests.
- Documentation is written in clear international English.
- By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

## Reporting bugs and requesting platforms

Open an issue with: the server and tool, what you asked the AI app to do, the error message (with secrets removed), your Node version and operating system. For a new platform, link its API documentation and say which workflows matter most. Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

```bash
git clone https://github.com/ecodelearnwithsakib-dev/AnalyticsDev-MCP.git
cd AnalyticsDev-MCP
npm ci
npm run build
npm test
```

`npm run dev:<server>` runs a server from source; `npm run inspect:<server>` opens the MCP Inspector.

## Rules for code

1. **One server per platform** in `src/<platform>/`, registered in `src/shared/servers.ts`, with `bin`, `dev:` and `inspect:` entries in `package.json` and a section in `.env.example` headed `# ---------- Title (src/<dir>) ----------`.
2. **Secrets only from the environment** via `requireEnv` / `optionalEnv`; never log them or return them in tool results.
3. **Tool names** are `<prefix>_<noun or verb>` in snake_case; descriptions say what the tool returns and when to use it.
4. **Writes are safe by default:** anything that spends, sends, publishes, deletes or changes live settings needs `confirm: true`, new campaigns are created paused where possible, and conversion tools offer a test mode.
5. **Personal data** (emails, phones, external IDs) is hashed with `sha256()` from `src/shared/rest.ts` before it goes to ad platforms.
6. **Money** is returned in account currency units (convert micros/cents).
7. **Reuse the shared helpers:** `restClient` and `oauthRefresher` (`src/shared/rest.ts`), `window()` presets and `callTool` (`src/shared/hub.ts`), `run()` and `startStdio()` (`src/shared/server.ts`).
8. **Tests:** every server passes the smoke test automatically once registered; add a mock-API test in `test/` for request shapes and safety rules (see `test/helpers.mjs`). Tests must not call real APIs.
9. `npm run typecheck` and `npm test` must pass; CI runs them on Node 20 and 22.

## Pull requests

- Keep each pull request focused; describe what changed and how you tested it.
- Update README, `docs/` and `.env.example` when you add or change tools or variables.
- Use clear commit messages in the imperative ("Add Pinterest catalog tool").
