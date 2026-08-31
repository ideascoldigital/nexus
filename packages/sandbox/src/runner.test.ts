import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  buildOpenCodeCommand,
  createOpenCodeStreamParser,
  describeOpenCodeEvent,
  finalizeOpenCodeRun,
} from "./runner";

// The OpenCode runner must honor the same contract remote.test.ts pins for
// claude: command quoting, chunk-safe parsing, shared result shape.

// --- buildOpenCodeCommand ---------------------------------------------------

test("base command: run --format json --auto with quoted prompt", () => {
  assert.equal(
    buildOpenCodeCommand("do the thing"),
    "opencode run --format json --auto 'do the thing'",
  );
});

test("session and model flags precede the prompt", () => {
  assert.equal(
    buildOpenCodeCommand("hi", {
      resumeSessionId: "ses_123",
      model: "anthropic/claude-sonnet-4-5",
    }),
    "opencode run -s 'ses_123' -m 'anthropic/claude-sonnet-4-5' --format json --auto 'hi'",
  );
});

test("blank model omitted; single quotes in prompt cannot escape", () => {
  assert.ok(!buildOpenCodeCommand("hi", { model: " " }).includes("-m"));
  const cmd = buildOpenCodeCommand("it's '; rm -rf / #");
  assert.ok(cmd.endsWith(`--auto 'it'\\''s '\\''; rm -rf / #'`));
});

// --- createOpenCodeStreamParser ---------------------------------------------

test("collects session id and last text across chunk boundaries", () => {
  const parser = createOpenCodeStreamParser();
  const line =
    JSON.stringify({
      part: { type: "text", text: "final answer", sessionID: "ses_9" },
    }) + "\n";
  parser.handleChunk(line.slice(0, 18));
  parser.handleChunk(line.slice(18));
  parser.flush();
  assert.equal(parser.getSessionId(), "ses_9");
  assert.equal(parser.getLastText(), "final answer");
});

test("payload nested under properties is also mined", () => {
  const parser = createOpenCodeStreamParser();
  parser.handleChunk(
    JSON.stringify({
      type: "message.part.updated",
      properties: { part: { type: "text", text: "hola", sessionID: "ses_1" } },
    }) + "\n",
  );
  assert.equal(parser.getSessionId(), "ses_1");
  assert.equal(parser.getLastText(), "hola");
});

test("last text wins; tool parts do not overwrite it", () => {
  const parser = createOpenCodeStreamParser();
  parser.handleChunk(
    JSON.stringify({ part: { type: "text", text: "first" } }) + "\n",
  );
  parser.handleChunk(
    JSON.stringify({ part: { type: "tool", tool: "bash" } }) + "\n",
  );
  parser.handleChunk(
    JSON.stringify({ part: { type: "text", text: "second" } }) + "\n",
  );
  assert.equal(parser.getLastText(), "second");
});

test("noise passes through to the log; garbled JSON dropped", () => {
  const logs: string[] = [];
  const parser = createOpenCodeStreamParser((c) => logs.push(c));
  parser.handleChunk("npm WARN something\n");
  parser.handleChunk('{"part": {"type": "text", broken\n');
  parser.flush();
  assert.deepEqual(logs, ["npm WARN something\n"]);
  assert.equal(parser.getLastText(), undefined);
});

// --- describeOpenCodeEvent --------------------------------------------------

test("tool parts render as [opencode] lines with best input detail", () => {
  assert.equal(
    describeOpenCodeEvent({
      part: {
        type: "tool",
        tool: "edit",
        state: { input: { filePath: "/a.ts", command: "ignored" } },
      },
    }),
    "[opencode] edit /a.ts",
  );
  assert.equal(
    describeOpenCodeEvent({
      part: { type: "tool", tool: "bash", state: { input: { command: "ls" } } },
    }),
    "[opencode] bash ls",
  );
});

test("text parts are truncated to 4 lines; unknown events are silent", () => {
  assert.equal(
    describeOpenCodeEvent({
      part: { type: "text", text: "1\n2\n3\n4\n5" },
    }),
    "1\n2\n3\n4",
  );
  assert.equal(describeOpenCodeEvent({ type: "server.connected" }), null);
});

// --- finalizeOpenCodeRun ----------------------------------------------------

test("exit 0 → ok with last text as result and sessionId for resume", () => {
  const out = finalizeOpenCodeRun(
    { sessionId: "ses_2", lastText: "done" },
    { code: 0, stderr: "" },
    1234,
  );
  assert.deepEqual(out, {
    ok: true,
    result: "done",
    costUsd: undefined,
    durationMs: 1234,
    sessionId: "ses_2",
    error: undefined,
  });
  // Round-trip: the sessionId feeds -s on the follow-up run.
  assert.ok(
    buildOpenCodeCommand("next", { resumeSessionId: out.sessionId }).includes(
      "-s 'ses_2'",
    ),
  );
});

test("non-zero exit → error from stderr tail, falls back to last text", () => {
  const tail = finalizeOpenCodeRun(
    { lastText: "partial" },
    { code: 1, stderr: "a\nb\nc\nd" },
    10,
  );
  assert.equal(tail.ok, false);
  assert.equal(tail.error, "b\nc\nd");

  const fallback = finalizeOpenCodeRun(
    { lastText: "boom reason" },
    { code: 1, stderr: " " },
    10,
  );
  assert.equal(fallback.error, "boom reason");

  const bare = finalizeOpenCodeRun({}, { code: 137, stderr: "" }, 10);
  assert.equal(bare.error, "opencode exited with code 137");
});
