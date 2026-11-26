import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseRestartBlocks,
  renderRestartedPrompt,
  restartedRun,
} from "./bot-restart";

test("a restart block is taken out of the reply and carries its reason", () => {
  const { body, restart } = parseRestartBlocks(
    'Voy a reiniciar el computador.\n\n```restart\n{"reason": "to pick up the sign-in"}\n```',
  );
  assert.equal(body, "Voy a reiniciar el computador.");
  assert.deepEqual(restart, { reason: "to pick up the sign-in" });
});

test("a reply without a block asks for nothing", () => {
  assert.deepEqual(parseRestartBlocks("Listo, ya quedó."), { body: "Listo, ya quedó.", restart: null });
  assert.deepEqual(parseRestartBlocks(null), { body: "", restart: null });
  // Mentioning a restart is not asking for one.
  assert.equal(parseRestartBlocks("Podría reiniciar si quieres").restart, null);
});

test("a block with no reason still restarts; broken JSON does not", () => {
  assert.deepEqual(parseRestartBlocks("```restart\n{}\n```").restart, { reason: null });
  assert.deepEqual(parseRestartBlocks('```restart\n{"restart": true}\n```').restart, { reason: null });
  // An explicit no is not a request.
  assert.equal(parseRestartBlocks('```restart\n{"restart": false}\n```').restart, null);
  assert.equal(parseRestartBlocks("```restart\nnot json\n```").restart, null);
  // The block never reaches the chat either way.
  assert.equal(parseRestartBlocks("ok\n\n```restart\nnot json\n```").body, "ok");
});

test("only the first block counts — two restarts would delete the first new computer", () => {
  const { restart } = parseRestartBlocks(
    '```restart\n{"reason": "first"}\n```\n```restart\n{"reason": "second"}\n```',
  );
  assert.deepEqual(restart, { reason: "first" });
});

test("the message on the new computer says why, and is recognised as that message", () => {
  const prompt = renderRestartedPrompt("to load the new tool");
  assert.ok(prompt.startsWith("[nexux:restarted] to load the new tool"));
  assert.match(prompt, /fresh machine/);
  // It says what survived, so the bot does not re-do sign-ins.
  assert.match(prompt, /sign-ins are as they were/);
  assert.deepEqual(restartedRun(prompt), { reason: "to load the new tool" });
  assert.deepEqual(restartedRun(renderRestartedPrompt(null)), { reason: null });
  assert.equal(restartedRun("Hola"), null);
});
