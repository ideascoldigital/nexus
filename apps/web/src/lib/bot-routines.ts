// Bot routines (spec 31): recurring work a bot does on its own. Pure and
// client-safe — the chat, the panel, the manager and the API all share it.
//
// The bot creates, changes or removes one by ending a reply with a block:
//
//   ```routine
//   {"name": "Update the expense log", "cron": "0 8 * * 1", "prompt": "…", "enabled": true}
//   ```
//   ```routine
//   {"name": "Update the expense log", "delete": true}
//   ```

import { splitAttachments } from "@/lib/bot-attachments";
import { parseChoices, type BotChoices } from "@/lib/bot-choices";
import { handoffRun, parseHandoffBlocks, replyRun, type HandoffSpec } from "@/lib/bot-handoffs";
import { mailRun, parseMailBlocks, type MailDraft } from "@/lib/bot-mail";
import { isHandback, isIntro } from "@/lib/bot-prompts";

export const ROUTINE_FENCE = "routine";

export type RoutineSpec = {
  name: string;
  cron?: string;
  prompt?: string;
  enabled?: boolean;
  delete?: boolean;
};

const BLOCK = new RegExp("```" + ROUTINE_FENCE + "[ \\t]*\\n([\\s\\S]*?)\\n?```", "g");

/** Routine blocks in a reply, and the reply without them. Malformed blocks are dropped. */
export function parseRoutineBlocks(text: string | null | undefined): { body: string; routines: RoutineSpec[] } {
  if (!text) return { body: "", routines: [] };
  const routines: RoutineSpec[] = [];
  const body = text.replace(BLOCK, (_, json: string) => {
    try {
      const d = JSON.parse(json.trim()) as Record<string, unknown>;
      if (typeof d.name === "string" && d.name.trim()) {
        routines.push({
          name: d.name.trim().slice(0, 120),
          cron: typeof d.cron === "string" ? d.cron.trim() : undefined,
          prompt: typeof d.prompt === "string" ? d.prompt.trim() : undefined,
          enabled: typeof d.enabled === "boolean" ? d.enabled : undefined,
          delete: d.delete === true,
        });
      }
    } catch {
      // not JSON: ignore the block
    }
    return "";
  });
  return { body: body.trim(), routines };
}

/** A bot reply split into what the chat shows: text, an optional question, routine changes. */
export function splitReply(text: string | null | undefined): {
  body: string;
  choices: BotChoices | null;
  routines: RoutineSpec[];
  handoffs: HandoffSpec[];
  mails: MailDraft[];
} {
  const { body: withoutRoutines, routines } = parseRoutineBlocks(text);
  const { body: withoutMails, mails } = parseMailBlocks(withoutRoutines);
  const { body, handoffs } = parseHandoffBlocks(withoutMails);
  const choices = parseChoices(body);
  // NEEDS_INPUT: is for the app (it flags the reply), not for reading.
  const shown = (choices ? choices.body : body).replace(/^NEEDS_INPUT:\s*/gm, "").trim();
  return { body: shown, choices, routines, handoffs, mails };
}

// ---- Runs a routine fires ------------------------------------------------------

const RUN_TAG = /^\[nexux:routine:([^\]]+)\] (.*)$/m;

export function renderRoutinePrompt(r: { id: string; name: string; prompt: string; label: string }): string {
  return [
    `[nexux:routine:${r.id}] ${r.name}`,
    `This is your scheduled routine "${r.name}" (${r.label}). Nobody asked just now — it is time to do it:`,
    "",
    r.prompt,
    "",
    "Your computer may be fresh: sign in again if you must, and ask if you cannot. When done, report briefly what you did and anything that needs the user.",
  ].join("\n");
}

/** The routine a run was fired by, from its prompt. */
export function routineRun(prompt: string): { id: string; name: string } | null {
  if (!prompt.startsWith("[nexux:routine:")) return null;
  const m = prompt.match(RUN_TAG);
  return m ? { id: m[1]!, name: m[2]!.trim() } : null;
}

// ---- Schedules ------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(h: number, m: number): string {
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

const int = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "Every Monday around 8:00 AM" — common shapes in words, anything else as the raw cron. */
export function describeCron(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const m = int(min);
  const h = int(hour);

  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${min.slice(2)} minutes`;
  }
  if (m !== null && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return m === 0 ? "Every hour" : `Every hour at :${String(m).padStart(2, "0")}`;
  }
  if (m !== null && hour.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${hour.slice(2)} hours`;
  }
  if (m === null || h === null) return cron;
  const at = `around ${clock(h, m)}`;
  const month = int(mon);
  if (month !== null && month >= 1 && month <= 12 && dow === "*") {
    const d = int(dom);
    if (d !== null) return `Every year on ${MONTHS[month - 1]} ${ordinal(d)} ${at}`;
  }
  if (mon !== "*") return cron;

  if (dom === "*" && dow === "*") return `Every day ${at}`;
  if (dom === "*" && (dow === "1-5" || dow === "MON-FRI")) return `Every weekday ${at}`;
  if (dom === "*" && (dow === "0,6" || dow === "6,0")) return `Every weekend day ${at}`;
  if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) {
    const names = [...new Set(dow.split(",").map((d) => DAYS[Number(d) % 7]!))];
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
    return `Every ${list} ${at}`;
  }
  const d = int(dom);
  if (d !== null && dow === "*") return `Every month on the ${ordinal(d)} ${at}`;
  return cron;
}

// ---- The panel's schedule picker -----------------------------------------------

export type RoutineFreq = "day" | "weekday" | "week" | "month" | "hour" | "custom";

export type RoutineSchedule = {
  freq: RoutineFreq;
  /** "HH:MM", 24h. */
  time: string;
  /** 0 = Sunday. */
  weekday: number;
  monthDay: number;
  /** Used as-is when freq is "custom". */
  cron: string;
};

export function cronFromSchedule(s: RoutineSchedule): string {
  const [hh, mm] = s.time.split(":").map((x) => Number(x) || 0);
  const h = Math.min(23, Math.max(0, hh ?? 0));
  const m = Math.min(59, Math.max(0, mm ?? 0));
  switch (s.freq) {
    case "day":
      return `${m} ${h} * * *`;
    case "weekday":
      return `${m} ${h} * * 1-5`;
    case "week":
      return `${m} ${h} * * ${s.weekday}`;
    case "month":
      return `${m} ${h} ${Math.min(28, Math.max(1, s.monthDay))} * *`;
    case "hour":
      return `${m} * * * *`;
    case "custom":
      return s.cron.trim();
  }
}

/** The picker's state for a cron, falling back to "custom" for shapes it cannot show. */
export function scheduleFromCron(cron: string): RoutineSchedule {
  const base: RoutineSchedule = { freq: "custom", time: "09:00", weekday: 1, monthDay: 1, cron };
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return base;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const m = int(min);
  const h = int(hour);
  if (m === null || mon !== "*") return base;
  if (hour === "*" && dom === "*" && dow === "*") return { ...base, freq: "hour", time: `00:${String(m).padStart(2, "0")}` };
  if (h === null) return base;
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (dom === "*" && dow === "*") return { ...base, freq: "day", time };
  if (dom === "*" && dow === "1-5") return { ...base, freq: "weekday", time };
  if (dom === "*" && /^[0-6]$/.test(dow)) return { ...base, freq: "week", time, weekday: Number(dow) };
  const d = int(dom);
  if (d !== null && d <= 28 && dow === "*") return { ...base, freq: "month", time, monthDay: d };
  return base;
}

/** What a run is about, in a few words — prompts the app sent read as what they mean. */
export function promptLabel(prompt: string): string {
  if (isIntro(prompt)) return "Introducing itself";
  if (isHandback(prompt)) return "Checking what you did on the computer";
  const routine = routineRun(prompt);
  if (routine) return `Routine · ${routine.name}`;
  const from = handoffRun(prompt);
  if (from) return `Message from ${from.fromName}`;
  const mail = mailRun(prompt);
  if (mail) return `${mail.mode === "send" ? "Sending" : "Saving a draft"} · ${mail.mail.subject || mail.mail.to}`;
  const back = replyRun(prompt);
  if (back) return `Continuing with ${back.teammateName}'s answer`;
  const { text, attachments } = splitAttachments(prompt);
  return attachments.length ? [text, `📎 ${attachments.map((a) => a.name).join(", ")}`].filter(Boolean).join(" ") : prompt;
}
