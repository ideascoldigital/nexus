import assert from "node:assert/strict";
import { test } from "node:test";

import { buildEvent, EventInputError, isInstant, nextDay, summarizeEvent, validTimeZone } from "./google-calendar";

const TZ = "America/Bogota";

test("a time without an offset is read in the user's zone", () => {
  const ev = buildEvent({ summary: "Demo", start: "2026-11-24T10:00", end: "2026-11-24T10:30" }, TZ);
  assert.deepEqual(ev.start, { dateTime: "2026-11-24T10:00:00", timeZone: TZ });
  assert.deepEqual(ev.end, { dateTime: "2026-11-24T10:30:00", timeZone: TZ });
});

test("a time with an offset is an exact instant and keeps it", () => {
  const ev = buildEvent({ summary: "Demo", start: "2026-11-24T10:00:00-05:00", end: "2026-11-24T15:30:00Z" }, TZ);
  assert.deepEqual(ev.start, { dateTime: "2026-11-24T10:00:00-05:00" });
  assert.deepEqual(ev.end, { dateTime: "2026-11-24T15:30:00Z" });
});

test("an explicit time zone wins over the user's", () => {
  const ev = buildEvent({ summary: "Call", start: "2026-11-24T09:00", end: "2026-11-24T10:00", timeZone: "Europe/Madrid" }, TZ);
  assert.equal((ev.start as { timeZone: string }).timeZone, "Europe/Madrid");
  assert.throws(() => buildEvent({ summary: "x", start: "2026-11-24T09:00", end: "2026-11-24T10:00", timeZone: "Mars/Base" }, TZ), /unknown time zone/);
});

test("an all-day event ends the next day unless told otherwise", () => {
  assert.deepEqual(buildEvent({ summary: "Off", start: "2026-12-31" }, TZ).end, { date: "2027-01-01" });
  assert.deepEqual(buildEvent({ summary: "Trip", start: "2026-12-01", end: "2026-12-04" }, TZ).end, { date: "2026-12-04" });
  assert.equal(nextDay("2028-02-28"), "2028-02-29", "leap year");
});

test("nonsense times are refused with a reason the bot can act on", () => {
  const bad = (input: Parameters<typeof buildEvent>[0], re: RegExp) =>
    assert.throws(() => buildEvent(input, TZ), (e: unknown) => e instanceof EventInputError && re.test(e.message));
  bad({ start: "2026-11-24T10:00", end: "2026-11-24T11:00" }, /summary/);
  bad({ summary: "x", start: "tomorrow at 10", end: "2026-11-24T11:00" }, /start must be/);
  bad({ summary: "x", start: "2026-11-24T10:00" }, /needs an end/);
  bad({ summary: "x", start: "2026-11-24T11:00", end: "2026-11-24T10:00" }, /after start/);
  bad({ summary: "x", start: "2026-11-24T11:00:00Z", end: "2026-11-24T06:00:00-05:00" }, /after start/);
  bad({ summary: "x", start: "2026-11-24", end: "2026-11-24T10:00" }, /both dates/);
  bad({ summary: "x", start: "2026-11-24", end: "2026-11-24" }, /after start/);
});

test("an update carries only what changes, and a move needs both ends", () => {
  assert.deepEqual(buildEvent({ location: "Sala 2" }, TZ, { partial: true }), { location: "Sala 2" });
  assert.throws(() => buildEvent({ start: "2026-11-24T10:00" }, TZ, { partial: true }), /both start and end/);
  const moved = buildEvent({ start: "2026-11-25T10:00", end: "2026-11-25T11:00" }, TZ, { partial: true });
  assert.deepEqual(Object.keys(moved).sort(), ["end", "start"]);
});

test("guests are addresses, deduplicated, and nothing else", () => {
  const ev = buildEvent({ summary: "x", start: "2026-11-24", attendees: "Ana <ana@x.com>, ANA@x.com; bo@y.co" }, TZ);
  assert.deepEqual(ev.attendees, [{ email: "ana@x.com" }, { email: "bo@y.co" }]);
  assert.throws(() => buildEvent({ summary: "x", start: "2026-11-24", attendees: "ana" }, TZ), /email addresses/);
  assert.deepEqual(buildEvent({ attendees: "" }, TZ, { partial: true }).attendees, [], "an empty list removes every guest");
});

test("meet: true asks Google for a Meet link", () => {
  const ev = buildEvent({ summary: "x", start: "2026-11-24", meet: true }, TZ);
  const req = (ev.conferenceData as { createRequest: { requestId: string; conferenceSolutionKey: { type: string } } }).createRequest;
  assert.equal(req.conferenceSolutionKey.type, "hangoutsMeet");
  assert.ok(req.requestId.length >= 16);
});

test("windows must be exact instants", () => {
  assert.equal(isInstant("2026-11-24T00:00:00-05:00"), true);
  assert.equal(isInstant("2026-11-24T00:00:00Z"), true);
  assert.equal(isInstant("2026-11-24T00:00:00"), false, "no offset: ambiguous");
  assert.equal(isInstant("2026-11-24"), false);
  assert.equal(validTimeZone("UTC"), true);
});

test("an event reads back as what a bot needs, a long description cut", () => {
  const s = summarizeEvent({
    id: "e1",
    summary: "Demo",
    start: { dateTime: "2026-11-24T10:00:00-05:00" },
    end: { dateTime: "2026-11-24T10:30:00-05:00" },
    description: "x".repeat(5000),
    hangoutLink: "https://meet.google.com/abc",
    organizer: { email: "me@x.com", self: true },
    attendees: [{ email: "me@x.com", self: true, responseStatus: "accepted" }, { email: "ana@x.com", responseStatus: "needsAction" }],
  });
  assert.equal(s.allDay, false);
  assert.equal(s.organizer, "you");
  assert.equal(s.meet, "https://meet.google.com/abc");
  assert.equal(s.description?.length, 1000);
  assert.deepEqual(s.attendees?.[1], { email: "ana@x.com", response: "needsAction" });
  assert.equal(summarizeEvent({ id: "e2", start: { date: "2026-11-24" } }).summary, "(no title)");
});
