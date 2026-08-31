# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them
privately via
[GitHub's private vulnerability reporting](https://github.com/ideascoldigital/nexus/security/advisories/new)
on this repository. You should get a first response within a few days.

## Threat model — read this before deploying

Nexus is **local-first** and its dashboard has **no authentication layer**.
Whoever reaches the web port can read stored credentials (the
`/env-vars/<id>/reveal` endpoint returns secrets in plaintext), open terminals
into sandboxes, and spend money on cloud providers.

- Run it on `localhost` or bind it to a private tailnet address
  (`NEXUX_BIND=<tailscale-ip>`) — never on a public interface.
  See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- Provider credentials are stored in the local SQLite database. Treat the
  data directory as sensitive.
- The only authenticated surface is the MCP API (`/api/mcp`), gated by
  `nxs_…` bearer tokens with scoped permissions.

## Supported versions

Only the latest release line (0.x) receives security fixes.
