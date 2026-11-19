import assert from "node:assert/strict";
import { test } from "node:test";

import { renderBotSystemPrompt } from "@nexux/sandbox";

import { CHOICES_FENCE, parseChoices } from "./bot-choices";

const reply = [
  "¡Hola Cristhian! Soy QA. Quiero confirmar por dónde arrancamos.",
  "",
  "```choices",
  '{"question": "¿Qué quieres que pruebe primero?", "options": ["El registro", "Las respuestas", " ", 4]}',
  "```",
].join("\n");

test("parseChoices pulls the question and options out of the reply", () => {
  const c = parseChoices(reply);
  assert.ok(c);
  assert.equal(c.question, "¿Qué quieres que pruebe primero?");
  assert.deepEqual(c.options, ["El registro", "Las respuestas"]); // blanks and non-strings dropped
  assert.equal(c.body, "¡Hola Cristhian! Soy QA. Quiero confirmar por dónde arrancamos.");
});

test("parseChoices rejects malformed or too-small blocks", () => {
  assert.equal(parseChoices(null), null);
  assert.equal(parseChoices("no block here?"), null);
  assert.equal(parseChoices("```choices\nnot json\n```"), null);
  assert.equal(parseChoices('```choices\n{"question":"Q?","options":["only one"]}\n```'), null);
  const many = JSON.stringify({ question: "Q?", options: Array.from({ length: 9 }, (_, i) => `o${i}`) });
  assert.equal(parseChoices("```choices\n" + many + "\n```")?.options.length, 6);
});

test("the bot's system prompt teaches the same fence the chat parses", () => {
  const sys = renderBotSystemPrompt({ name: "QA", needsInputMarker: "NEEDS_INPUT:" });
  assert.ok(sys.includes("```" + CHOICES_FENCE + "\n"));
  const example = sys.slice(sys.indexOf("```" + CHOICES_FENCE));
  assert.ok(parseChoices(example.slice(0, example.indexOf("```", 3) + 3)), "the example in the prompt parses");
});
