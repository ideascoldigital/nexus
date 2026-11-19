// Bots talking to each other (spec 23). A bot messages a teammate by ending a
// reply with a block:
//
//   ```handoff
//   {"to": "Creative Designer", "message": "Need a banner for the launch: …"}
//   ```
//
// Nexus queues that message on the teammate (waking its computer). The
// teammate sees who it is from, works on it, and can answer the same way.
// A hop count rides along, so two bots cannot bounce messages forever.
// Pure and client-safe: the chat, the inbox, the manager share it.

export const HANDOFF_FENCE = "handoff";
/** Longest chain of bot→bot messages started by one human request. */
export const MAX_HANDOFF_HOPS = 4;

/** `reply`: the sender needs the answer to continue — Nexus brings it back when the teammate is done. */
export type HandoffSpec = { to: string; message: string; reply?: boolean };

const BLOCK = new RegExp("```" + HANDOFF_FENCE + "[ \\t]*\\n([\\s\\S]*?)\\n?```", "g");

/** Handoff blocks in a reply, and the reply without them. Malformed blocks are dropped. */
export function parseHandoffBlocks(text: string | null | undefined): { body: string; handoffs: HandoffSpec[] } {
  if (!text) return { body: "", handoffs: [] };
  const handoffs: HandoffSpec[] = [];
  const body = text.replace(BLOCK, (_, json: string) => {
    try {
      const d = JSON.parse(json.trim()) as Record<string, unknown>;
      if (typeof d.to === "string" && d.to.trim() && typeof d.message === "string" && d.message.trim()) {
        handoffs.push({
          to: d.to.trim().slice(0, 120),
          message: d.message.trim().slice(0, 20_000),
          ...(d.reply === true ? { reply: true } : {}),
        });
      }
    } catch {
      // not JSON: ignore the block
    }
    return "";
  });
  return { body: body.trim(), handoffs };
}

// ---- The message a teammate receives ----------------------------------------

// [nexux:from:<fromBotId>:<hop>:<sourceRunId>] <fromName>
// sourceRunId is the sender's run that wrote the handoff — the thread it hangs off.
// A trailing ":r" means the sender wants the answer back.
const TAG = /^\[nexux:from:([\w-]+):(\d+)(?::([\w-]+))?(:r)?\] ([^\n]*)\n?([\s\S]*)$/;

export type HandoffRun = {
  fromId: string;
  fromName: string;
  hop: number;
  sourceRunId: string | null;
  wantsReply: boolean;
  message: string;
};

/** Stored as the teammate's run prompt: who it is from, the hop, the thread, the message. */
export function renderHandoffPrompt(h: {
  fromId: string;
  fromName: string;
  hop: number;
  sourceRunId?: string | null;
  wantsReply?: boolean;
  message: string;
}): string {
  const src = h.sourceRunId ? `:${h.sourceRunId}` : "";
  return `[nexux:from:${h.fromId}:${h.hop}${src}${h.sourceRunId && h.wantsReply ? ":r" : ""}] ${h.fromName}\n${h.message}`;
}

export function handoffRun(prompt: string): HandoffRun | null {
  if (!prompt.startsWith("[nexux:from:")) return null;
  const m = prompt.match(TAG);
  return m
    ? {
        fromId: m[1]!,
        hop: Number(m[2]),
        sourceRunId: m[3] ?? null,
        wantsReply: Boolean(m[4]),
        fromName: m[5]!.trim(),
        message: m[6]!.trim(),
      }
    : null;
}

// ---- The answer coming back to the sender -----------------------------------

const REPLY_TAG = /^\[nexux:reply:([\w-]+):(\d+)\] ([^\n]*)\n?([\s\S]*)$/;

/** Stored on the sender when a teammate it asked (reply: true) is done. */
export function renderReplyPrompt(r: { teammateId: string; teammateName: string; hop: number; answer: string }): string {
  return `[nexux:reply:${r.teammateId}:${r.hop}] ${r.teammateName}\n${r.answer}`;
}

export function replyRun(prompt: string): { teammateId: string; teammateName: string; hop: number; answer: string } | null {
  if (!prompt.startsWith("[nexux:reply:")) return null;
  const m = prompt.match(REPLY_TAG);
  return m ? { teammateId: m[1]!, hop: Number(m[2]), teammateName: m[3]!.trim(), answer: m[4]!.trim() } : null;
}

export function replyForClaude(r: { teammateName: string; answer: string }): string {
  return [
    `Your teammate "${r.teammateName}" answered what you asked them (the user already saw it in the thread):`,
    "",
    r.answer,
    "",
    "Continue the task you were doing for the user with it. Don't repeat their answer back; add what you were going to do (decide, combine, deliver).",
  ].join("\n");
}

/** The prompt prefix every handoff from `fromId` starts with — to find a bot's threads. */
export function handoffPrefix(fromId: string): string {
  return `[nexux:from:${fromId}:`;
}

/** What the teammate's Claude reads: clearly a colleague, not the user. */
export function handoffForClaude(h: { fromName: string; message: string; wantsReply?: boolean }): string {
  return [
    `Message from your teammate "${h.fromName}" (another bot on the user's team — not the user):`,
    "",
    h.message,
    "",
    `Do what it asks if it fits your job. Your reply shows in a thread under ${h.fromName}'s message, where the user reads it: start with one short line (e.g. "Me encargo." / "On it.") and then the result.${h.wantsReply ? ` ${h.fromName} gets your reply automatically when you finish — put the result itself in it.` : ""} If the user has to approve or decide, ask them right there. Do NOT message ${h.fromName} back just to acknowledge, confirm or say it's done. Hand back to "${h.fromName}" only when they must act on something else. If it does not fit your job, say so briefly and suggest who on the team fits better.`,
  ].join("\n");
}

/** Match a handoff's `to` against the team, case- and space-insensitively. */
export function findTeammate<B extends { id: string; name: string }>(team: B[], to: string): B | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const want = norm(to);
  return team.find((b) => norm(b.name) === want) ?? null;
}
