/**
 * The Google Calendar connector (spec 36), the I/O half. Uses the account's
 * sealed token through services/google.ts — bots never hold it; they relay
 * through /api/bots/:id/calendar with their prompt's token.
 */

import { buildEvent, CALENDAR_API, summarizeEvent, type ApiEvent, type EventInput } from "@/lib/google-calendar";
import { accessToken, GoogleApiError } from "@/services/google";

async function calendar<T>(
  accountId: string,
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string | undefined> },
): Promise<T> {
  const url = new URL(`${CALENDAR_API}${path}`);
  for (const [k, v] of Object.entries(init?.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${await accessToken(accountId)}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  // DELETE answers 204 with no body.
  if (res.status === 204) return {} as T;
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) {
    const status = res.status === 404 || res.status === 410 ? 404 : res.status === 400 ? 400 : 502;
    throw new GoogleApiError(`Google Calendar: ${json.error?.message ?? `HTTP ${res.status}`}`, status);
  }
  return json;
}

const cal = (id: string | undefined) => encodeURIComponent(id?.trim() || "primary");
/** "all" emails every guest about the change; "none" changes their calendars silently. */
const sendUpdates = (notify: boolean | undefined) => (notify ? "all" : "none");

export async function listCalendars(accountId: string) {
  const r = await calendar<{
    items?: { id: string; summary?: string; primary?: boolean; accessRole?: string; timeZone?: string }[];
  }>(accountId, "/users/me/calendarList", { query: { maxResults: "100" } });
  return (r.items ?? []).map((c) => ({
    id: c.id,
    name: c.summary ?? c.id,
    primary: c.primary || undefined,
    // owner/writer can hold new events; reader/freeBusyReader cannot.
    access: c.accessRole,
    timeZone: c.timeZone,
  }));
}

const MAX_EVENTS = 100;

/** Events in a window, recurring ones expanded, in start order. */
export async function listEvents(
  accountId: string,
  opts: { calendarId?: string; timeMin: string; timeMax: string; query?: string; max?: number },
) {
  const n = Math.min(Math.max(1, Math.floor(opts.max ?? 50) || 50), MAX_EVENTS);
  const r = await calendar<{ items?: ApiEvent[]; timeZone?: string }>(accountId, `/calendars/${cal(opts.calendarId)}/events`, {
    query: {
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      q: opts.query?.trim() || undefined,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(n),
    },
  });
  return { timeZone: r.timeZone, events: (r.items ?? []).map(summarizeEvent) };
}

export async function getEvent(accountId: string, calendarId: string | undefined, eventId: string) {
  const ev = await calendar<ApiEvent>(accountId, `/calendars/${cal(calendarId)}/events/${encodeURIComponent(eventId)}`);
  // The full description here, not the agenda's cut one.
  return { ...summarizeEvent(ev), description: ev.description || undefined };
}

/** Busy blocks per calendar — for finding a free slot, the user's or a colleague's. */
export async function freeBusy(accountId: string, opts: { timeMin: string; timeMax: string; calendars?: string[]; timeZone?: string }) {
  const ids = opts.calendars?.length ? opts.calendars.slice(0, 20) : ["primary"];
  const r = await calendar<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] }> }>(
    accountId,
    "/freeBusy",
    { method: "POST", body: { timeMin: opts.timeMin, timeMax: opts.timeMax, timeZone: opts.timeZone, items: ids.map((id) => ({ id })) } },
  );
  return Object.fromEntries(
    Object.entries(r.calendars ?? {}).map(([id, c]) => [
      id,
      c.errors?.length ? { error: c.errors.map((e) => e.reason).join(", ") || "not visible" } : { busy: c.busy ?? [] },
    ]),
  );
}

export async function createEvent(
  accountId: string,
  opts: { calendarId?: string; event: EventInput; notify?: boolean; defaultTimeZone: string },
) {
  const body = buildEvent(opts.event, opts.defaultTimeZone);
  const ev = await calendar<ApiEvent>(accountId, `/calendars/${cal(opts.calendarId)}/events`, {
    method: "POST",
    body,
    query: { sendUpdates: sendUpdates(opts.notify), conferenceDataVersion: opts.event.meet ? "1" : undefined },
  });
  return summarizeEvent(ev);
}

export async function updateEvent(
  accountId: string,
  opts: { calendarId?: string; eventId: string; event: EventInput; notify?: boolean; defaultTimeZone: string },
) {
  const body = buildEvent(opts.event, opts.defaultTimeZone, { partial: true });
  const ev = await calendar<ApiEvent>(accountId, `/calendars/${cal(opts.calendarId)}/events/${encodeURIComponent(opts.eventId)}`, {
    method: "PATCH",
    body,
    query: { sendUpdates: sendUpdates(opts.notify), conferenceDataVersion: opts.event.meet ? "1" : undefined },
  });
  return summarizeEvent(ev);
}

export async function deleteEvent(accountId: string, opts: { calendarId?: string; eventId: string; notify?: boolean }) {
  await calendar(accountId, `/calendars/${cal(opts.calendarId)}/events/${encodeURIComponent(opts.eventId)}`, {
    method: "DELETE",
    query: { sendUpdates: sendUpdates(opts.notify) },
  });
}
