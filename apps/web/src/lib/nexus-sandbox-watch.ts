// A sandbox launched from a project chat reports on its own (spec 39): Nexus
// watches it and posts the outcome — ready (with its preview) or failed (with
// the error) — and lets the assistant add one line on what comes next. The
// steps in between show live in the strip over the composer
// (SandboxStatusBar), not as chat messages. The assistant never has to poll,
// and the user never has to ask "is it ready?".

import { prisma } from "@nexux/db";

export { isNexusNotice } from "@/lib/nexus-cards";
import { NOTICE_TAG, SANDBOX_DONE_TAG } from "@/lib/nexus-cards";

const POLL_MS = 5_000;
const MAX_MS = 90 * 60_000;
const TERMINAL = new Set(["running", "error", "destroyed"]);

const g = globalThis as unknown as { nexuxSandboxWatches?: Set<string> };
const watching = (g.nexuxSandboxWatches ??= new Set<string>());

/** The "[nexux] …" lines of a sandbox log: its provisioning steps, in order. Pure. */
export function sandboxSteps(log: string): string[] {
  return log
    .split("\n")
    .filter((l) => l.startsWith("[nexux] "))
    .map((l) => l.slice("[nexux] ".length).trim())
    .filter(Boolean);
}

/** What the chat says when the sandbox lands. Pure. */
export function outcomeNotice(s: { name: string; status: string; previewUrl: string | null; error: string | null }): string {
  if (s.status === "running") {
    return `✅ **${s.name}** is up and running.${s.previewUrl ? ` Preview: ${s.previewUrl}` : ""}`;
  }
  if (s.status === "error") return `❌ **${s.name}** failed to start: ${s.error ?? "no error was recorded"}`;
  return `**${s.name}** was destroyed before it finished.`;
}

async function hostSessionId(botId: string): Promise<string | null> {
  const s = await prisma.botSession.findFirst({ where: { botId, containerName: "nexus-host" }, select: { id: true } });
  return s?.id ?? null;
}

async function post(botId: string, text: string) {
  const sessionId = await hostSessionId(botId);
  if (!sessionId) return;
  const now = new Date();
  await prisma.botRun.create({
    data: { botId, sessionId, prompt: NOTICE_TAG, status: "completed", result: text, startedAt: now, finishedAt: now },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Follow a sandbox and report into the chat. `followUp` queues one message to
 * the assistant when it lands (so it knows, and says what comes next).
 */
export function watchSandbox(botId: string, sandboxId: string, followUp: (prompt: string) => Promise<unknown>): void {
  const key = `${botId}:${sandboxId}`;
  if (watching.has(key)) return;
  watching.add(key);
  void (async () => {
    const started = Date.now();
    try {
      while (Date.now() - started < MAX_MS) {
        const s = await prisma.sandbox.findUnique({
          where: { id: sandboxId },
          select: { name: true, status: true, previewUrl: true, error: true },
        });
        if (!s) return;
        if (TERMINAL.has(s.status)) {
          await post(botId, outcomeNotice(s));
          await followUp(
            `${SANDBOX_DONE_TAG} The sandbox "${s.name}" is now ${s.status}${s.error ? ` (error: ${s.error})` : ""}${s.previewUrl ? `, preview ${s.previewUrl}` : ""}. The chat already showed this, and its terminal is open in the panel on the right. Now lead: say in one or two lines what we do next with this sandbox — if it failed, the likely cause and the fix; if it is up, what is still missing to get the project's apps running (from what you know of its stack and setup) — and end with a choices block of 2 to 4 concrete next steps. Do not call tools in this message.`,
          ).catch(() => undefined);
          return;
        }
        await sleep(POLL_MS);
      }
      await post(botId, "⏳ The sandbox is still not ready after 90 minutes; I stopped following it.");
    } catch (err) {
      console.warn("[nexus] sandbox watch failed:", err instanceof Error ? err.message : err);
    } finally {
      watching.delete(key);
    }
  })();
}
