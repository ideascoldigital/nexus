// Restarting a bot's computer (spec 37). Pure and client-safe: the chat, the
// manager and the API share it.
//
// A bot cannot restart its own machine with a command — the shell that would
// run it dies with the container, mid-reply. So it asks, by ending a reply
// with a block, and Nexus does it once the reply is safely stored:
//
//   ```restart
//   {"reason": "the desktop stopped answering"}
//   ```

export const RESTART_FENCE = "restart";

export type RestartSpec = { reason: string | null };

const BLOCK = new RegExp("```" + RESTART_FENCE + "[ \\t]*\\n([\\s\\S]*?)\\n?```", "g");

/**
 * The restart a reply asks for, and the reply without the block. One per
 * reply: a second block says nothing the first did not, and two restarts
 * would only delete the computer the first one just made.
 */
export function parseRestartBlocks(text: string | null | undefined): {
  body: string;
  restart: RestartSpec | null;
} {
  if (!text) return { body: "", restart: null };
  let restart: RestartSpec | null = null;
  const body = text.replace(BLOCK, (_, json: string) => {
    try {
      const d = JSON.parse(json.trim()) as Record<string, unknown>;
      // `{"restart": false}` is a bot saying no: an explicit refusal is not a request.
      if (d.restart === false) return "";
      const reason = typeof d.reason === "string" && d.reason.trim() ? d.reason.trim().slice(0, 200) : null;
      restart ??= { reason };
    } catch {
      // not JSON: ignore the block
    }
    return "";
  });
  return { body: body.trim(), restart };
}

/** Marks the message a bot gets on its new computer, right after its own restart. */
export const RESTARTED_TAG = "[nexux:restarted]";

export function renderRestartedPrompt(reason: string | null): string {
  return [
    `${RESTARTED_TAG} ${reason ?? ""}`.trimEnd(),
    `Your computer was restarted${reason ? ` ${reason}` : ""}, as you asked. This is a fresh machine: nothing is open and nothing is running, while /workspace, your browser sign-ins and your MCP servers' sign-ins are as they were.`,
    "",
    "Check that whatever you restarted for works now (if it was a tool, use it once for something harmless), then tell the user in one or two lines where things stand. If it still does not work, say so plainly instead of restarting again.",
  ].join("\n");
}

/** The restart a run follows, and why, from its prompt. */
export function restartedRun(prompt: string): { reason: string | null } | null {
  if (!prompt.startsWith(RESTARTED_TAG)) return null;
  const first = prompt.slice(RESTARTED_TAG.length).split("\n", 1)[0]!.trim();
  return { reason: first || null };
}
