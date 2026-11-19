/**
 * A project's MCP servers, for each brain.
 *
 * The wizard stores them in Claude Code's native `mcpServers` shape (D-16), and
 * the bootstrap used to write only `~/.claude.json` — so a project whose brain
 * is OpenCode silently ran without the servers its config listed. OpenCode
 * reads the same servers from `opencode.json` under `mcp`, in its own shape:
 *
 *   claude  { command, args?, env? }             → { type: "local", command: [command, ...args], environment? }
 *   claude  { type: "http" | "sse", url, headers? } → { type: "remote", url, headers? }
 *
 * Claude expands `${VAR}` / `${VAR:-default}` in these strings; OpenCode's
 * substitution is `{env:VAR}`. Translated, so a server wired to a project env
 * var keeps working instead of receiving the literal text (a default has no
 * OpenCode equivalent and is dropped).
 */

export type OpenCodeMcpServer =
  | {
      type: "local";
      command: string[];
      environment?: Record<string, string>;
      enabled: true;
    }
  | {
      type: "remote";
      url: string;
      headers?: Record<string, string>;
      enabled: true;
    };

const envRef = (value: string) =>
  value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g, "{env:$1}");

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === "string")
    .map(([k, v]) => [k, envRef(v)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * Translate every server OpenCode can run; name the ones it cannot (no
 * command and no url — nothing to start or reach) so the bootstrap says so
 * rather than dropping them without a word.
 */
export function openCodeMcpServers(servers: Record<string, unknown> | null | undefined): {
  mcp: Record<string, OpenCodeMcpServer>;
  skipped: string[];
} {
  const mcp: Record<string, OpenCodeMcpServer> = {};
  const skipped: string[] = [];
  for (const [name, raw] of Object.entries(servers ?? {})) {
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (typeof s.url === "string" && s.url.trim()) {
      const headers = stringMap(s.headers);
      mcp[name] = { type: "remote", url: envRef(s.url), ...(headers ? { headers } : {}), enabled: true };
    } else if (typeof s.command === "string" && s.command.trim()) {
      const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : [];
      const environment = stringMap(s.env);
      mcp[name] = {
        type: "local",
        command: [s.command, ...args].map(envRef),
        ...(environment ? { environment } : {}),
        enabled: true,
      };
    } else {
      skipped.push(name);
    }
  }
  return { mcp, skipped };
}
