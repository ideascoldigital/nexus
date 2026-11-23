import assert from "node:assert/strict";
import { test } from "node:test";

import { HANDBACK_PROMPT, isHandback } from "./bot-prompts";
import { botPreview } from "./bot-view";

test("the hand-back prompt is recognised exactly, and previews as a status", () => {
  assert.ok(isHandback(HANDBACK_PROMPT));
  assert.ok(!isHandback("I've given you back control"));
  const run = { prompt: HANDBACK_PROMPT, status: "queued", result: null, error: null, needsInput: false };
  assert.equal(botPreview(run), "Checking what you did…");
});

test("the intro prompt is tagged, greets by name and lists the user's projects", async () => {
  const { INTRO_TAG, isIntro, isSystemPrompt, renderIntroPrompt } = await import("./bot-prompts");
  const p = renderIntroPrompt({
    userName: "Alex",
    role: null,
    projects: [{ name: "Acme Support", description: "AI assistants  for\nbusinesses" }, { name: "Rack" }],
    languageSample: "abre google",
  });
  assert.ok(p.startsWith(INTRO_TAG) && isIntro(p) && isSystemPrompt(p));
  assert.match(p, /greet Alex by name/);
  assert.match(p, /- Acme Support: AI assistants for businesses\n- Rack/);
  assert.match(p, /same language as this message they sent to another bot: "abre google"\. It is only a sample/);
  assert.match(p, /choices block/);
  const bare = renderIntroPrompt({ projects: [] });
  assert.match(bare, /first message to the user\./);
  assert.doesNotMatch(bare, /their projects/);
});

test("previews: a question shows its text, the intro a status", () => {
  const q = "Hola.\n```choices\n" + JSON.stringify({ question: "¿Por dónde empiezo?", options: ["A", "B"] }) + "\n```";
  assert.equal(botPreview({ prompt: "x", status: "completed", result: q, error: null, needsInput: true }), "¿Por dónde empiezo?");
  assert.equal(
    botPreview({ prompt: "x", status: "completed", result: "Listo.\nNEEDS_INPUT: ¿Qué cuenta?", error: null, needsInput: true }),
    "Listo. ¿Qué cuenta?",
  );
  assert.equal(
    botPreview({ prompt: "[nexux:intro] hi", status: "queued", result: null, error: null, needsInput: false }),
    "Getting ready to say hi…",
  );
});
