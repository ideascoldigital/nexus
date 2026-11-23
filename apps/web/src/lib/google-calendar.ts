// The Google Calendar connector (spec 36), the pure half: turning what a bot
// asks for into a Calendar API event, and an API event back into something a
// bot can read. No I/O here — services/google-calendar.ts does the calls.
//
// Same account, same OAuth app and same sealed token as Gmail (spec 34): an
// account connected for Calendar carries the calendar scopes on its token.

import { randomBytes } from "node:crypto";

import { addressOf } from "@/lib/gmail";

export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export type EventInput = {
  summary?: string;
  /** "2026-11-24T10:00" (in `timeZone`), "2026-11-24T10:00:00-05:00", or "2026-11-24" for an all-day event. */
  start?: string;
  end?: string;
  /** IANA name. Used for times written without an offset; defaults to the user's. */
  timeZone?: string;
  description?: string;
  location?: string;
  /** Comma-separated addresses. Adding someone puts the event on their calendar. */
  attendees?: string;
  /** Attach a Google Meet link. */
  meet?: boolean;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

export class EventInputError extends Error {}

/** An exact instant (RFC 3339 with an offset) — what list and free/busy windows take. */
export function isInstant(v: string): boolean {
  return DATE_TIME.test(v.trim()) && OFFSET.test(v.trim()) && !Number.isNaN(Date.parse(v));
}

/** Is `tz` an IANA zone this runtime knows? */
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type When = { date: string } | { dateTime: string; timeZone?: string };

function when(value: string, field: "start" | "end", timeZone: string): When {
  const v = value.trim();
  if (DATE.test(v)) return { date: v };
  if (!DATE_TIME.test(v)) {
    throw new EventInputError(
      `${field} must be a date (2026-11-24) or a date and time (2026-11-24T10:00, optionally with an offset like -05:00)`,
    );
  }
  // With an offset the instant is exact; without one it is a wall-clock time in timeZone.
  return OFFSET.test(v) ? { dateTime: v } : { dateTime: v.length === 16 ? `${v}:00` : v, timeZone };
}

/** The day after a YYYY-MM-DD date — an all-day event's exclusive end. */
export function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** end after start, when the two can be compared without knowing the zone's rules. */
function assertOrder(start: When, end: When) {
  if ("date" in start !== "date" in end) throw new EventInputError("start and end must both be dates, or both dates and times");
  if ("date" in start && "date" in end) {
    if (end.date <= start.date) throw new EventInputError("an all-day event's end is the day after its last day, so it must be after start");
    return;
  }
  const s = start as { dateTime: string; timeZone?: string };
  const e = end as { dateTime: string; timeZone?: string };
  const exact = OFFSET.test(s.dateTime) && OFFSET.test(e.dateTime);
  const sameWall = !OFFSET.test(s.dateTime) && !OFFSET.test(e.dateTime) && s.timeZone === e.timeZone;
  if (exact && Date.parse(e.dateTime) <= Date.parse(s.dateTime)) throw new EventInputError("end must be after start");
  if (sameWall && e.dateTime <= s.dateTime) throw new EventInputError("end must be after start");
}

function attendeeList(raw: string): { email: string }[] {
  const parts = raw.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  const emails = parts.map(addressOf);
  if (emails.some((e) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e))) {
    throw new EventInputError("attendees must be email addresses, comma-separated");
  }
  return [...new Set(emails)].map((email) => ({ email }));
}

const cut = (v: string, n: number) => (v.length > n ? v.slice(0, n) : v);

/**
 * A Calendar API event from a bot's input. `partial` builds a patch: only the
 * fields given, and start/end only together (a moved event needs both, so a
 * length is never silently changed).
 */
export function buildEvent(input: EventInput, defaultTimeZone: string, { partial = false } = {}): Record<string, unknown> {
  const timeZone = input.timeZone?.trim() || defaultTimeZone;
  if (!validTimeZone(timeZone)) throw new EventInputError(`unknown time zone "${timeZone}" — use an IANA name like America/Bogota`);
  const body: Record<string, unknown> = {};

  if (input.summary !== undefined) body.summary = cut(input.summary.trim(), 500);
  else if (!partial) throw new EventInputError("the event needs a summary (its title)");

  if (input.start !== undefined || input.end !== undefined || !partial) {
    if (!input.start?.trim()) throw new EventInputError(partial ? "to move an event give both start and end" : "the event needs a start");
    const start = when(input.start, "start", timeZone);
    let endRaw = input.end?.trim();
    if (!endRaw) {
      if ("date" in start) endRaw = nextDay(start.date);
      else throw new EventInputError(partial ? "to move an event give both start and end" : "the event needs an end");
    }
    const end = when(endRaw, "end", timeZone);
    assertOrder(start, end);
    body.start = start;
    body.end = end;
  }

  if (input.description !== undefined) body.description = cut(input.description, 8000);
  if (input.location !== undefined) body.location = cut(input.location.trim(), 500);
  if (input.attendees !== undefined) body.attendees = attendeeList(input.attendees);
  if (input.meet) {
    body.conferenceData = {
      createRequest: { requestId: randomBytes(12).toString("hex"), conferenceSolutionKey: { type: "hangoutsMeet" } },
    };
  }
  return body;
}

// ---- Reading events back -----------------------------------------------------------

export type ApiEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  recurringEventId?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  organizer?: { email?: string; self?: boolean };
  attendees?: { email?: string; responseStatus?: string; self?: boolean; organizer?: boolean }[];
};

export function summarizeEvent(ev: ApiEvent) {
  const allDay = Boolean(ev.start?.date);
  return {
    id: ev.id,
    summary: ev.summary ?? "(no title)",
    start: ev.start?.date ?? ev.start?.dateTime ?? "",
    end: ev.end?.date ?? ev.end?.dateTime ?? "",
    allDay,
    status: ev.status,
    location: ev.location || undefined,
    // A bot reads the agenda; a long description belongs to calendar_get_event.
    description: ev.description ? cut(ev.description, 1000) : undefined,
    organizer: ev.organizer?.self ? "you" : ev.organizer?.email,
    attendees: ev.attendees?.map((a) => ({ email: a.email, response: a.responseStatus, ...(a.self ? { you: true } : {}) })),
    meet: ev.hangoutLink || undefined,
    recurring: ev.recurringEventId ? true : undefined,
    link: ev.htmlLink,
  };
}
