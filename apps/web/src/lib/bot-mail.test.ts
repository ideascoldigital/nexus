import assert from "node:assert/strict";
import test from "node:test";

import {
  mailForClaude,
  mailRun,
  parseMailBlocks,
  parseMailState,
  renderMailPrompt,
  validAddresses,
} from "./bot-mail";

const block = (d: unknown) => "```mail\n" + JSON.stringify(d) + "\n```";

test("mail blocks come out of the reply, one draft each", () => {
  const reply = [
    "Los 2 correos están listos para que los revises.",
    block({ from: "me@acme.com", to: "ana@example.com", subject: "Bienvenida", body: "Hola Ana,\n\nGracias.\n" }),
    block({ to: "leo@example.com", cc: "  ", subject: "Seguimiento", body: "Hola Leo" }),
  ].join("\n\n");
  const { body, mails } = parseMailBlocks(reply);
  assert.equal(body, "Los 2 correos están listos para que los revises.");
  assert.equal(mails.length, 2);
  assert.deepEqual(mails[0], { from: "me@acme.com", to: "ana@example.com", subject: "Bienvenida", body: "Hola Ana,\n\nGracias." });
  assert.deepEqual(mails[1], { to: "leo@example.com", subject: "Seguimiento", body: "Hola Leo" }); // empty cc dropped
});

test("a block without a recipient, without content, or not JSON is dropped", () => {
  const reply = [
    block({ subject: "x", body: "y" }),
    block({ to: "a@b.co", subject: "", body: "  " }),
    "```mail\nnot json\n```",
  ].join("\n");
  assert.deepEqual(parseMailBlocks(reply), { body: "", mails: [] });
  assert.deepEqual(parseMailBlocks(null), { body: "", mails: [] });
});

test("the send run round-trips the final draft, edits included", () => {
  const mail = { from: "me@acme.com", to: "ana@example.com", cc: "leo@example.com", subject: "Hola\nAna", body: "Línea 1\n\nLínea 2" };
  const p = renderMailPrompt({ sourceRunId: "run_1", index: 2, mode: "send", mail });
  assert.match(p, /^\[nexux:mail:run_1:2:send\] Hola Ana\n/);
  assert.deepEqual(mailRun(p), { sourceRunId: "run_1", index: 2, mode: "send", mail });
  assert.equal(mailRun("just a prompt"), null);
  assert.equal(mailRun("[nexux:mail:r:0:send] x\n{broken"), null);
});

test("Claude is told to send verbatim, or to only save a draft", () => {
  const mail = { to: "ana@example.com", subject: "S", body: "B" };
  const send = mailForClaude({ mode: "send", mail });
  assert.match(send, /pressed Send/);
  assert.match(send, /-----\nB\n-----/);
  assert.match(send, /signed in with/);
  const draft = mailForClaude({ mode: "draft", mail: { ...mail, from: "me@acme.com", cc: "x@y.co" } });
  assert.match(draft, /do NOT send it/);
  assert.match(draft, /Cc: x@y\.co/);
  assert.match(draft, /Send from me@acme\.com|from me@acme\.com/);
});

test("address lists: each part must look like an address", () => {
  assert.equal(validAddresses("ana@example.com"), true);
  assert.equal(validAddresses("ana@example.com, Leo <leo@example.co>; x@y.io"), true);
  assert.equal(validAddresses("", { required: true }), false);
  assert.equal(validAddresses(""), true);
  assert.equal(validAddresses("ana@example"), false);
  assert.equal(validAddresses("ana example.com"), false);
});

test("mail state tolerates junk", () => {
  assert.deepEqual(parseMailState(null), {});
  assert.deepEqual(parseMailState("[1]"), {});
  assert.deepEqual(parseMailState("{"), {});
  assert.deepEqual(parseMailState('{"0":{"status":"discarded"}}'), { "0": { status: "discarded" } });
});
