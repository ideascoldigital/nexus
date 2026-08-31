-- Per-project MCP servers for the sandbox's Claude Code (native mcpServers
-- shape). Materialized into ~/.claude.json (agent user + root) at bootstrap.
ALTER TABLE "SandboxConfig" ADD COLUMN "mcpServers" JSONB;
