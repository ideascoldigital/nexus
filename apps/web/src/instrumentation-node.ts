// Everything the server startup hook does that only the Node.js runtime can do:
// ptys, the Prisma client, the filesystem.
//
// It lives in its own module because `instrumentation.ts` is compiled for the
// edge runtime too. A `process.env.NEXT_RUNTIME !== "nodejs"` early return stops
// this code from *running* there, but not from being *bundled* — webpack still
// has to resolve every import behind it, and dies on `fs/promises`, which the
// edge runtime does not have. Behind a single guarded dynamic import the
// bundler can leave the whole module out of the edge build, which is the shape
// Next documents for exactly this reason.
export async function registerNode() {
  // In dev, `pnpm dev` may already run the standalone terminal server; let an
  // explicit opt-out skip the in-process one to avoid a port clash.
  if (process.env.NEXUX_DISABLE_INPROC_TERMINAL !== "1") {
    try {
      const { startTerminalServer } = await import(
        "@nexux/terminal/terminal-server"
      );
      const handle = startTerminalServer();
      console.log(`[instrumentation] terminal server up on :${handle.port}`);
    } catch (err) {
      console.error("[instrumentation] terminal server failed to start:", err);
    }
  }

  // Workspaces: the seeded default must exist before any scoped query runs.
  try {
    const { ensureDefaultWorkspace } = await import("@/lib/workspace");
    await ensureDefaultWorkspace();
  } catch (err) {
    console.error("[instrumentation] default workspace check failed:", err);
  }

  // Telegram notifications + remote control. Idles cheaply (30s polls of the
  // Settings table) until a bot token is configured.
  if (process.env.NEXUX_DISABLE_TELEGRAM !== "1") {
    try {
      const { startTelegramPoller } = await import("@/lib/telegram");
      startTelegramPoller();
      console.log("[instrumentation] telegram poller started");
    } catch (err) {
      console.error("[instrumentation] telegram poller failed to start:", err);
    }
  }

  // Slack remote control: an outbound Socket Mode WebSocket — the Telegram
  // poller's equivalent. Idles cheaply until both Slack tokens exist.
  if (process.env.NEXUX_DISABLE_SLACK !== "1") {
    try {
      const { startSlackSocket } = await import("@/lib/slack-socket");
      startSlackSocket();
      console.log("[instrumentation] slack socket started");
    } catch (err) {
      console.error("[instrumentation] slack socket failed to start:", err);
    }
  }

  // Scheduled agent tasks (ephemeral sandbox → task → PR → destroy).
  if (process.env.NEXUX_DISABLE_SCHEDULER !== "1") {
    try {
      const { startTaskScheduler } = await import("@/lib/task-scheduler");
      startTaskScheduler();
      console.log("[instrumentation] task scheduler started");
    } catch (err) {
      console.error("[instrumentation] task scheduler failed to start:", err);
    }
    try {
      // Both drivers live in-process: first settle sandboxes whose
      // provision/destroy died with the previous process, then re-attach
      // supervision to whatever it left queued.
      const { recoverOrphanSandboxes } = await import("@/lib/sandbox-manager");
      await recoverOrphanSandboxes();
      const { recoverPendingLaunches, recoverOrphanTasks } = await import(
        "@/lib/task-manager"
      );
      // Fail the runner-less ones first, then re-attach to what can still be
      // supervised — the two select disjoint sets, and doing it in this order
      // means a task is never briefly both.
      await recoverOrphanTasks();
      void recoverPendingLaunches();
      // Dev-console queues: fail orphaned running prompts, resume queued ones.
      const { recoverDevQueues } = await import("@/lib/dev-console");
      void recoverDevQueues();
      // Plan-mode runs have no queue to resume — just settle the orphans.
      const { recoverPlanRuns } = await import("@/lib/plan-runner");
      void recoverPlanRuns();
      // Bots: a dead process leaves unsupervised desktop containers behind —
      // delete them, settle their rows, then start the idle reaper.
      const { recoverBots } = await import("@/lib/bot-manager");
      void recoverBots();
    } catch (err) {
      console.error("[instrumentation] launch recovery failed:", err);
    }
  }
}
