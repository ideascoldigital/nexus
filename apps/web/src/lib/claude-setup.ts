// The one error a fresh Nexus hits first: no Claude Code token saved yet.
// Both runners say exactly this, and the chat recognises it to show a setup
// card instead of a red line. Client-safe (no server imports).

export const NO_CLAUDE_TOKEN = "No Claude Code token — add one in Vault → AI providers (`claude setup-token`)";

export function isMissingClaudeToken(error: string | null | undefined): boolean {
  return Boolean(error?.startsWith("No Claude Code token"));
}

/** What a Claude Code OAuth token looks like (`claude setup-token` prints sk-ant-oat…). */
export function looksLikeClaudeToken(value: string): boolean {
  return /^sk-ant-[a-z0-9]+-[\w-]{20,}$/i.test(value.trim());
}
