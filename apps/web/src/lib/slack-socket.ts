// Slack remote control over Socket Mode: an OUTBOUND WebSocket, so it stays
// local-first exactly like Telegram's long-polling — no public URL, no
// webhook. Requires an app-level token (Settings: slack_app_token, xapp-…)
// with connections:write, Socket Mode enabled on the app, and event
// subscriptions for message.channels / message.groups.
//
// The contract mirrors Telegram's: notifications carry #task_<id> /
// #sandbox_<id> tags, and a reply IN THE MESSAGE'S THREAD acts on the tag —
// follow-up on a pipeline task, next prompt on a dev/sandbox thread. Routing
// is by channel: a project's configured channel scopes replies to it, the
// global channel may act on every project.

import { handleReply } from "@/lib/telegram";
import {
  callApiGet,
  getAppToken,
  getBotToken,
  getSlackRoutes,
  sendSlackReply,
} from "@/lib/slack";

const RECONNECT_MS = 5_000;
const UNCONFIGURED_RETRY_MS = 30_000;

// Survives HMR module reloads, same trick as the dev workers.
const globalForSlack = globalThis as unknown as {
  nexuxSlackSocket: boolean | undefined;
};

type Envelope = {
  envelope_id?: string;
  type?: string;
  payload?: {
    event?: {
      type?: string;
      subtype?: string;
      bot_id?: string;
      channel?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
      event_ts?: string;
    };
  };
};

// Slack redelivers events it thinks weren't handled — remember the last few.
const seenEvents = new Set<string>();
function alreadySeen(id: string): boolean {
  if (seenEvents.has(id)) return true;
  seenEvents.add(id);
  if (seenEvents.size > 200) {
    const first = seenEvents.values().next().value;
    if (first) seenEvents.delete(first);
  }
  return false;
}

/** handleReply speaks Telegram HTML; Slack wants mrkdwn. */
export function htmlToMrkdwn(html: string): string {
  return html
    .replace(/<\/?code>/g, "`")
    .replace(/<\/?b>/g, "*")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function handleEvent(event: NonNullable<Envelope["payload"]>["event"]) {
  if (!event || event.type !== "message") return;
  if (event.bot_id || event.subtype) return; // our own posts, edits, joins…
  const { channel, text, thread_ts, ts } = event;
  if (!channel || !text?.trim() || !thread_ts || thread_ts === ts) return;
  if (alreadySeen(`${channel}:${ts}`)) return;

  // Only channels wired to Nexus act on replies — the bot may sit in others.
  const routes = await getSlackRoutes();
  if (!routes.has(channel)) return;
  const scope = routes.get(channel) ?? null;

  // The tag lives on the thread's root message (our notification).
  const botToken = await getBotToken();
  if (!botToken) return;
  const root = (await callApiGet(botToken, "conversations.replies", {
    channel,
    ts: thread_ts,
    limit: "1",
    inclusive: "true",
  })) as { messages?: Array<{ text?: string }> } | null;
  const rootText = root?.messages?.[0]?.text ?? "";
  if (!rootText) return;

  const answer = await handleReply(scope, rootText, text.trim());
  await sendSlackReply(htmlToMrkdwn(answer), channel, thread_ts);
}

async function connectOnce(appToken: string): Promise<void> {
  const open = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { Authorization: `Bearer ${appToken}` },
  });
  const json = (await open.json()) as {
    ok: boolean;
    url?: string;
    error?: string;
  };
  if (!json.ok || !json.url) {
    throw new Error(`apps.connections.open failed: ${json.error ?? "unknown"}`);
  }

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(json.url!);
    ws.onopen = () =>
      console.log("[slack] socket connected — thread replies are live");
    ws.onmessage = (msg) => {
      let envelope: Envelope;
      try {
        envelope = JSON.parse(String(msg.data)) as Envelope;
      } catch {
        return;
      }
      // Ack first — Slack redelivers anything not acked within 3s.
      if (envelope.envelope_id) {
        ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      }
      if (envelope.type === "disconnect") {
        // Slack refreshes connections roughly hourly; reconnect cleanly.
        ws.close();
        return;
      }
      if (envelope.type === "events_api") {
        void handleEvent(envelope.payload?.event).catch((err) =>
          console.error("[slack] reply handling failed:", err),
        );
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => resolve();
  });
}

/** Start the Socket Mode loop (idempotent). No-ops until tokens exist. */
export function startSlackSocket(): void {
  if (globalForSlack.nexuxSlackSocket) return;
  globalForSlack.nexuxSlackSocket = true;

  void (async () => {
    console.log("[slack] socket-mode loop started");
    for (;;) {
      try {
        const [appToken, botToken] = await Promise.all([
          getAppToken(),
          getBotToken(),
        ]);
        if (!appToken || !botToken) {
          await sleep(UNCONFIGURED_RETRY_MS);
          continue;
        }
        await connectOnce(appToken);
        // Normal close (disconnect refresh) — reconnect quickly.
        await sleep(1_000);
      } catch (err) {
        console.error("[slack] socket error:", err);
        await sleep(RECONNECT_MS);
      }
    }
  })();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
