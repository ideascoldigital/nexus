import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { hostTimezone } from "@/lib/bot-routine-store";
import { checkVault } from "@/lib/bot-vault-access";
import { addressOf } from "@/lib/gmail";
import { EventInputError, isInstant, type EventInput } from "@/lib/google-calendar";
import { GoogleApiError, googleAccountsFor, type GoogleAccount } from "@/services/google";
import {
  createEvent,
  deleteEvent,
  freeBusy,
  getEvent,
  listCalendars,
  listEvents,
  updateEvent,
} from "@/services/google-calendar";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

const TOKEN_HEADER = "x-nexux-vault-token";
const OUTSIDE = { error: "calendar: not available outside a running task" };

/**
 * The Calendar MCP server inside a bot's computer relays here (spec 36), the
 * way Gmail's does (spec 34): it holds only its prompt's token, and Nexus calls
 * Google with the account's own token.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { botId } = await params;
  if (!checkVault(req.headers.get(TOKEN_HEADER), botId)) return NextResponse.json(OUTSIDE, { status: 401 });
  return NextResponse.json((await googleAccountsFor(botId, "calendar")).map((a) => a.email));
}

const instant = z
  .string()
  .max(40)
  .refine(isInstant, "must be a date and time with an offset, like 2026-11-24T00:00:00-05:00");
const id = z.string().min(1).max(1024);
const account = z.string().max(320).optional();
const calendarId = z.string().max(1024).optional();
const event = {
  summary: z.string().max(500).optional(),
  start: z.string().max(40).optional(),
  end: z.string().max(40).optional(),
  timeZone: z.string().max(64).optional(),
  description: z.string().max(8000).optional(),
  location: z.string().max(500).optional(),
  attendees: z.string().max(4000).optional(),
  meet: z.boolean().optional(),
};

const schema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("calendars"), account }),
  z.object({
    tool: z.literal("events"),
    account,
    calendarId,
    timeMin: instant,
    timeMax: instant,
    query: z.string().max(200).optional(),
    max: z.number().int().min(1).max(100).optional(),
  }),
  z.object({ tool: z.literal("get_event"), account, calendarId, eventId: id }),
  z.object({
    tool: z.literal("freebusy"),
    account,
    timeMin: instant,
    timeMax: instant,
    calendars: z.array(z.string().min(1).max(320)).max(20).optional(),
  }),
  z.object({ tool: z.literal("create_event"), account, calendarId, notify: z.boolean().optional(), ...event }),
  z.object({ tool: z.literal("update_event"), account, calendarId, eventId: id, notify: z.boolean().optional(), ...event }),
  z.object({ tool: z.literal("delete_event"), account, calendarId, eventId: id, notify: z.boolean().optional() }),
]);

/** The account a call is for: the one named, or the only one this bot may use. */
function pick(accounts: GoogleAccount[], wanted: string | undefined): GoogleAccount | string {
  if (!accounts.length) {
    return "No Google Calendar is connected for you. Ask the user to connect one in Nexus → Connect apps → Google Calendar.";
  }
  if (wanted?.trim()) {
    const a = accounts.find((x) => x.email === addressOf(wanted));
    return a ?? `You can't use ${wanted}. Your calendars' accounts: ${accounts.map((x) => x.email).join(", ")}.`;
  }
  if (accounts.length === 1) return accounts[0]!;
  return `Say which account (account: …). Yours: ${accounts.map((x) => x.email).join(", ")}.`;
}

export async function POST(req: NextRequest, { params }: Params) {
  const { botId } = await params;
  if (!checkVault(req.headers.get(TOKEN_HEADER), botId)) return NextResponse.json(OUTSIDE, { status: 401 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ");
    return NextResponse.json({ error: `calendar: ${why}` }, { status: 400 });
  }
  const call = parsed.data;
  const picked = pick(await googleAccountsFor(botId, "calendar"), call.account);
  if (typeof picked === "string") return NextResponse.json({ error: picked }, { status: 403 });
  const accountId = picked.id;
  const tz = hostTimezone();

  try {
    switch (call.tool) {
      case "calendars":
        return NextResponse.json(await listCalendars(accountId));
      case "events":
        return NextResponse.json(await listEvents(accountId, call));
      case "get_event":
        return NextResponse.json(await getEvent(accountId, call.calendarId, call.eventId));
      case "freebusy":
        return NextResponse.json(await freeBusy(accountId, { ...call, timeZone: tz }));
      case "create_event": {
        const created = await createEvent(accountId, { calendarId: call.calendarId, event: eventOf(call), notify: call.notify, defaultTimeZone: tz });
        await logChange(botId, `created "${created.summary}"`, picked.email, call.notify);
        return NextResponse.json(created);
      }
      case "update_event": {
        const updated = await updateEvent(accountId, {
          calendarId: call.calendarId,
          eventId: call.eventId,
          event: eventOf(call),
          notify: call.notify,
          defaultTimeZone: tz,
        });
        await logChange(botId, `updated "${updated.summary}"`, picked.email, call.notify);
        return NextResponse.json(updated);
      }
      case "delete_event":
        await deleteEvent(accountId, call);
        await logChange(botId, `deleted event ${call.eventId}`, picked.email, call.notify);
        return NextResponse.json({ message: `Deleted from ${picked.email}'s calendar.` });
    }
  } catch (err) {
    if (err instanceof EventInputError) return NextResponse.json({ error: `calendar: ${err.message}` }, { status: 400 });
    if (err instanceof GoogleApiError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

/** Just the event's fields — an update must not see a field the bot left out. */
function eventOf(call: EventInput): EventInput {
  const keys = ["summary", "start", "end", "timeZone", "description", "location", "attendees", "meet"] as const;
  return Object.fromEntries(keys.filter((k) => call[k] !== undefined).map((k) => [k, call[k]])) as EventInput;
}

/** Changes to someone's calendar leave a line in the log, like a sent email does. */
async function logChange(botId: string, what: string, email: string, notify: boolean | undefined) {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { name: true } });
  console.log(`[calendar] ${bot?.name ?? botId} ${what} in ${email}${notify ? " (guests notified)" : ""}`);
}
