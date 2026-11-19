// Notification fan-out: one call site event, every configured medium.
// Telegram and Slack each no-op when unconfigured and never throw upward —
// a lost notification must not fail the run that produced it.

import {
  notifyDevTask as telegramDevTask,
  notifySandboxStatus as telegramSandboxStatus,
  notifyTaskFinished as telegramTaskFinished,
} from "@/lib/telegram";
import { fireAssistantWatches } from "@/lib/assistant/watches";
import {
  notifySlackDevTask,
  notifySlackSandboxStatus,
  notifySlackTaskFinished,
} from "@/lib/slack";

export async function notifyTaskFinished(taskId: string): Promise<void> {
  await Promise.allSettled([
    telegramTaskFinished(taskId),
    notifySlackTaskFinished(taskId),
    // The global assistant is one more medium (spec 30): its open watches.
    fireAssistantWatches("task", taskId),
  ]);
}

export async function notifyDevTask(taskId: string): Promise<void> {
  await Promise.allSettled([
    telegramDevTask(taskId),
    notifySlackDevTask(taskId),
    fireAssistantWatches("task", taskId),
  ]);
}

export async function notifySandboxStatus(sandboxId: string): Promise<void> {
  await Promise.allSettled([
    telegramSandboxStatus(sandboxId),
    notifySlackSandboxStatus(sandboxId),
    fireAssistantWatches("sandbox", sandboxId),
  ]);
}
