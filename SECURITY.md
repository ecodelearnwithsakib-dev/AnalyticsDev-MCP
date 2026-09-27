# Security Policy

## Supported versions

Security fixes are made on the `main` branch. Always run the latest commit or release.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: repository → **Security** → **Report a vulnerability** (private vulnerability reporting). Include:

- what is affected (server, file, tool or gateway endpoint),
- steps to reproduce or a proof of concept,
- the impact you expect (credential exposure, unauthorised write, gateway bypass…).

Never include real credentials, tokens or customer data in a report — redact them.

What to expect: an acknowledgement within **5 days**, an assessment within **14 days**, and a fix or mitigation as quickly as the severity requires. We will credit you in the fix unless you prefer to stay anonymous. Please give us reasonable time to release a fix before disclosing publicly.

## In scope

- Credential leaks (tokens in logs, tool results, error messages or files with loose permissions)
- Bypass of `confirm`, read-only mode or tool allow/deny lists
- HTTP gateway authentication, OAuth (PKCE, redirect validation, token handling) and path handling
- Injection through tool arguments into API requests, shell commands or files
- Unsafe handling of data fetched by the tracking audit

## Out of scope

- Vulnerabilities in the connected platforms themselves (report those to the platform)
- Attacks that require an already-compromised machine or a stolen `.env`
- Prompt injection in an AI application that a user then approves — though hardening suggestions are welcome

## Keeping your installation safe

1. Keep `.env` private (`chmod 600`), out of git and out of screenshots; prefer `npm run secret -- migrate` (macOS Keychain) or 1Password references.
2. Give each API key and token the smallest scopes it needs; use read-only mode (`MCP_READ_ONLY=true`) for reporting-only setups.
3. Rotate any credential that was pasted into a chat, commit, issue or ticket — immediately.
4. Keep the gateway on localhost behind a tunnel, use `--oauth` or a strong token, serve only the servers you need with `--allow`, and use `--revoke-oauth` if a connector is lost.
5. Review write actions before confirming them.
6. Update regularly (`git pull && npm ci && npm run build`).

More detail: [docs/SECURITY-AND-AGENCY.md](docs/SECURITY-AND-AGENCY.md).
