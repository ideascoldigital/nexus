import assert from "node:assert/strict";
import { test } from "node:test";

import { NEEDS_INPUT_MARKER } from "./agent-core";
import { draftBody } from "./run-draft-view";

test("prose streams as it is", () => {
  assert.equal(draftBody("Hola, Cristhian. Estoy "), "Hola, Cristhian. Estoy");
  assert.equal(draftBody(null), "");
});

test("a card block is held back until the reply is finished", () => {
  assert.equal(draftBody("¿Cuál prefieres?\n\n```choices\n- A\n- B"), "¿Cuál prefieres?");
  assert.equal(draftBody("Listo.\n```mail\nto: x"), "Listo.");
});

test("ordinary code blocks stream, and the needs-input marker is hidden", () => {
  assert.equal(draftBody("Mira:\n```ts\nconst a = 1"), "Mira:\n```ts\nconst a = 1");
  assert.equal(draftBody(`Hecho.\n${NEEDS_INPUT_MARKER} ¿Qué carpeta?`), "Hecho.\n ¿Qué carpeta?");
});
