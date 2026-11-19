-- A bot's own MCP servers (Claude Code's native mcpServers shape), loaded in
-- its computer next to the browser MCP on every prompt.
ALTER TABLE "Bot" ADD COLUMN "mcpServers" JSONB;
