import assert from "node:assert/strict";
import { test } from "node:test";

import { renderBotSystemPrompt } from "@nexux/sandbox";

import { HANDBACK_PROMPT, renderIntroPrompt } from "./bot-prompts";
import {
  ROUTINE_FENCE,
  cronFromSchedule,
  describeCron,
  parseRoutineBlocks,
  promptLabel,
  renderRoutinePrompt,
  routineRun,
  scheduleFromCron,
  splitReply,
} from "./bot-routines";

const block = (o: unknown) => "```routine\n" + JSON.stringify(o) + "\n```";

test("routine blocks are parsed out of a reply, malformed ones dropped", () => {
  const text = [
    "Listo, la dejé programada.",
    block({ name: "Actualizar gastos", cron: "0 8 * * 1", prompt: "Revisa Acme Books", enabled: true }),
    block({ name: "Vieja", delete: true }),
    "```routine\nnot json\n```",
    block({ cron: "0 8 * * 1" }),
  ].join("\n");
  const { body, routines } = parseRoutineBlocks(text);
  assert.equal(body, "Listo, la dejé programada.");
  assert.deepEqual(routines, [
    { name: "Actualizar gastos", cron: "0 8 * * 1", prompt: "Revisa Acme Books", enabled: true, delete: false },
    { name: "Vieja", cron: undefined, prompt: undefined, enabled: undefined, delete: true },
  ]);
});

test("splitReply separates text, a question and routine changes", () => {
  const q = "```choices\n" + JSON.stringify({ question: "¿La programo?", options: ["Sí", "No"] }) + "\n```";
  const r = splitReply(`Hecho.\n${block({ name: "R", cron: "0 9 * * *", prompt: "p" })}\n${q}`);
  assert.equal(r.body, "Hecho.");
  assert.equal(r.choices?.question, "¿La programo?");
  assert.equal(r.routines[0]?.name, "R");
  assert.deepEqual(splitReply(null), { body: "", choices: null, routines: [], handoffs: [] });
  assert.equal(splitReply("No tengo acceso.\nNEEDS_INPUT: ¿Qué cuenta uso?").body, "No tengo acceso.\n¿Qué cuenta uso?");
});

test("describeCron reads common schedules in words", () => {
  assert.equal(describeCron("0 8 * * 1"), "Every Monday around 8:00 AM");
  assert.equal(describeCron("0 9 * * *"), "Every day around 9:00 AM");
  assert.equal(describeCron("30 17 * * 1-5"), "Every weekday around 5:30 PM");
  assert.equal(describeCron("0 12 * * 1,4"), "Every Monday and Thursday around 12:00 PM");
  assert.equal(describeCron("0 0 1 * *"), "Every month on the 1st around 12:00 AM");
  assert.equal(describeCron("0 7 22 * *"), "Every month on the 22nd around 7:00 AM");
  assert.equal(describeCron("0 7 11 * *"), "Every month on the 11th around 7:00 AM");
  assert.equal(describeCron("0 * * * *"), "Every hour");
  assert.equal(describeCron("*/15 * * * *"), "Every 15 minutes");
  assert.equal(describeCron("0 */6 * * *"), "Every 6 hours");
  assert.equal(describeCron("0 9 9 12 *"), "Every year on December 9th around 9:00 AM");
  assert.equal(describeCron("0 8 * 3 1"), "0 8 * 3 1"); // unusual: shown raw
});

test("the schedule picker round-trips the shapes it can show", () => {
  for (const cron of ["0 8 * * 1", "30 9 * * *", "0 18 * * 1-5", "15 7 3 * *", "45 * * * *"]) {
    assert.equal(cronFromSchedule(scheduleFromCron(cron)), cron);
  }
  const custom = scheduleFromCron("0 8 * 3 1");
  assert.equal(custom.freq, "custom");
  assert.equal(cronFromSchedule(custom), "0 8 * 3 1");
  assert.equal(cronFromSchedule({ ...custom, freq: "month", monthDay: 31, time: "25:70" }), "59 23 28 * *");
});

test("a routine's run is tagged with its id and name, and labelled in words", () => {
  const p = renderRoutinePrompt({ id: "r1", name: "Gastos", prompt: "Revisa Acme Books", label: "Every Monday around 8:00 AM" });
  assert.deepEqual(routineRun(p), { id: "r1", name: "Gastos" });
  assert.match(p, /Revisa Acme Books/);
  assert.equal(routineRun("hola"), null);
  assert.equal(promptLabel(p), "Routine · Gastos");
  assert.equal(promptLabel(HANDBACK_PROMPT), "Checking what you did on the computer");
  assert.equal(promptLabel(renderIntroPrompt({ projects: [] })), "Introducing itself");
  assert.equal(promptLabel("abre google"), "abre google");
});

test("the system prompt teaches the routine block and lists current routines", () => {
  const sys = renderBotSystemPrompt({
    name: "Gastos",
    needsInputMarker: "NEEDS_INPUT:",
    timezone: "America/Bogota",
    routines: [{ name: "Actualizar", cron: "0 8 * * 1", label: "Every Monday around 8:00 AM", prompt: "p", enabled: false }],
  });
  assert.ok(sys.includes("```" + ROUTINE_FENCE + "\n"));
  assert.match(sys, /timezone \(America\/Bogota\)/);
  assert.match(sys, /- "Actualizar" — Every Monday around 8:00 AM \(`0 8 \* \* 1`\), paused: p/);
  const example = sys.slice(sys.indexOf("```" + ROUTINE_FENCE));
  assert.equal(parseRoutineBlocks(example.slice(0, example.indexOf("```", 3) + 3)).routines.length, 1);
});
