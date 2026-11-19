import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  buildClaudeCommand,
  createStreamParser,
  describeEvent,
  finalizeClaudeRun,
  sandboxShellCommand,
  type StreamEvent,
} from "./remote";

// These tests pin the headless-agent contract that a second brain
// (OpenCode — spec 16) must preserve: command construction, stream-json
// parsing, and the shared run-result shape consumed by task-manager and
// dev-console. If a dispatcher refactor changes any of this, they fail.

// --- buildClaudeCommand -----------------------------------------------------

test("base command: -p prompt with bypassPermissions + stream-json", () => {
  const cmd = buildClaudeCommand("do the thing");
  assert.equal(
    cmd,
    "claude -p 'do the thing' --permission-mode bypassPermissions --output-format stream-json --verbose",
  );
});

test("resume flag precedes model and -p", () => {
  const cmd = buildClaudeCommand("hi", {
    resumeSessionId: "sess-123",
    model: "opus",
  });
  assert.equal(
    cmd,
    "claude --resume 'sess-123' --model 'opus' -p 'hi' --permission-mode bypassPermissions --output-format stream-json --verbose",
  );
});

test("blank model is omitted, model is trimmed", () => {
  assert.ok(!buildClaudeCommand("hi", { model: "  " }).includes("--model"));
  assert.ok(
    buildClaudeCommand("hi", { model: " sonnet " }).includes("--model 'sonnet'"),
  );
});

test("single quotes in the prompt cannot escape the shell quoting", () => {
  const cmd = buildClaudeCommand("it's a '; rm -rf / #");
  // shq turns ' into '\'' — the payload must stay inside quotes.
  assert.ok(cmd.includes(`-p 'it'\\''s a '\\''; rm -rf / #'`));
});

// --- createStreamParser -----------------------------------------------------

function ev(e: StreamEvent): string {
  return JSON.stringify(e) + "\n";
}

test("captures the final result event across chunk boundaries", () => {
  const parser = createStreamParser();
  const line = ev({
    type: "result",
    subtype: "success",
    result: "done",
    total_cost_usd: 0.42,
    duration_ms: 1234,
    session_id: "s-1",
  });
  // Split mid-JSON: the parser must reassemble before parsing.
  parser.handleChunk(line.slice(0, 25));
  parser.handleChunk(line.slice(25));
  parser.flush();
  assert.equal(parser.getFinal()?.session_id, "s-1");
  assert.equal(parser.getFinal()?.total_cost_usd, 0.42);
});

test("trailing partial line without newline needs flush()", () => {
  const parser = createStreamParser();
  parser.handleChunk(ev({ type: "result", result: "ok" }).trimEnd());
  assert.equal(parser.getFinal(), null, "no newline yet — not parsed");
  parser.flush();
  assert.equal(parser.getFinal()?.result, "ok");
});

test("last result event wins", () => {
  const parser = createStreamParser();
  parser.handleChunk(ev({ type: "result", result: "first" }));
  parser.handleChunk(ev({ type: "result", result: "second" }));
  assert.equal(parser.getFinal()?.result, "second");
});

test("non-JSON noise passes through to the log; garbled JSON is dropped", () => {
  const logs: string[] = [];
  const parser = createStreamParser((c) => logs.push(c));
  parser.handleChunk("npm WARN deprecated something\n");
  parser.handleChunk('{"type": "assistant", truncated-garbage\n');
  parser.flush();
  assert.deepEqual(logs, ["npm WARN deprecated something\n"]);
  assert.equal(parser.getFinal(), null);
});

test("assistant/tool events become readable log lines", () => {
  const logs: string[] = [];
  const parser = createStreamParser((c) => logs.push(c));
  parser.handleChunk(ev({ type: "system", subtype: "init" }));
  parser.handleChunk(
    ev({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ],
      },
    }),
  );
  parser.handleChunk(ev({ type: "result", subtype: "success" }));
  assert.deepEqual(logs, [
    "[claude] session started\n",
    "[claude] Bash npm test\n",
    "[claude] finished (success)\n",
  ]);
});

// --- describeEvent ----------------------------------------------------------

test("tool_use detail falls back to url, query, then element", () => {
  const line = (input: Record<string, unknown>) =>
    describeEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "T", input }] },
    } as StreamEvent);
  assert.equal(line({ url: "https://a.b", query: "q" }), "[claude] T https://a.b");
  assert.equal(line({ query: "best model", element: "e" }), "[claude] T best model");
  assert.equal(line({ element: "Search button", text: "secret" }), "[claude] T Search button");
});

test("tool_use detail priority: file_path > command > pattern > path", () => {
  const line = describeEvent({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Edit",
          input: { file_path: "/a.ts", command: "ignored", pattern: "x" },
        },
      ],
    },
  });
  assert.equal(line, "[claude] Edit /a.ts");
});

test("assistant text is truncated to 4 lines", () => {
  const line = describeEvent({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "l1\nl2\nl3\nl4\nl5\nl6" }],
    },
  });
  assert.equal(line, "l1\nl2\nl3\nl4");
});

test("unknown event types produce no log line", () => {
  assert.equal(describeEvent({ type: "user" }), null);
  assert.equal(describeEvent({}), null);
});

// --- finalizeClaudeRun ------------------------------------------------------

test("success: code 0 + result event → ok with cost/duration/session", () => {
  const out = finalizeClaudeRun(
    {
      type: "result",
      result: "did it",
      total_cost_usd: 1.5,
      duration_ms: 99,
      session_id: "s-2",
    },
    { code: 0, stderr: "" },
  );
  assert.deepEqual(out, {
    ok: true,
    result: "did it",
    costUsd: 1.5,
    durationMs: 99,
    sessionId: "s-2",
    error: undefined,
  });
});

test("is_error in the result event fails the run even with exit code 0", () => {
  const out = finalizeClaudeRun(
    { type: "result", is_error: true, result: "credit exhausted" },
    { code: 0, stderr: "" },
  );
  assert.equal(out.ok, false);
  assert.equal(out.error, "credit exhausted");
});

test("non-zero exit code fails the run even with a success event", () => {
  const out = finalizeClaudeRun(
    { type: "result", result: "looked fine" },
    { code: 137, stderr: "" },
  );
  assert.equal(out.ok, false);
});

test("no result event → error carries the stderr tail (last 3 lines)", () => {
  const out = finalizeClaudeRun(null, {
    code: 1,
    stderr: "a\nb\nc\nd\ne\n",
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, "c\nd\ne");
});

test("no result event and empty stderr → exit-code message", () => {
  const out = finalizeClaudeRun(null, { code: 255, stderr: "  " });
  assert.equal(out.error, "claude exited with code 255 without a result event");
});

test("session id from the final event is what callers persist for resume", () => {
  // devSessionId / SandboxTask.sessionId round-trip: finalize exposes the
  // session, buildClaudeCommand consumes it as --resume.
  const out = finalizeClaudeRun(
    { type: "result", result: "ok", session_id: "round-trip" },
    { code: 0, stderr: "" },
  );
  const next = buildClaudeCommand("follow-up", {
    resumeSessionId: out.sessionId,
  });
  assert.ok(next.startsWith("claude --resume 'round-trip' "));
});

// --- sandboxShellCommand ----------------------------------------------------
// What the sandbox row hands a user for their own terminal. The in-app
// terminal has the key path and the user name built in; a pasted command has
// to carry both or it fails as an authentication problem.

// String.raw so the backslashes stay backslashes: this is the shape the path
// really has on the platform where quoting it matters.
const KEY = String.raw`C:\Users\jane\.nexux\ssh\id_ed25519`;
const SPACED_KEY = String.raw`C:\Program Files\nexux\ssh\id_ed25519`;
const opts = { privateKeyPath: KEY, user: "nexus" };

test("a cloud sandbox gets a runnable ssh command, key and all", () => {
  const cmd = sandboxShellCommand(
    { provider: "civo", publicIp: "1.2.3.4" },
    opts,
  );
  assert.equal(
    cmd,
    `ssh -i "${KEY}" -o IdentitiesOnly=yes nexus@1.2.3.4`,
  );
});

test("the key path is quoted, because an install path has spaces", () => {
  const cmd = sandboxShellCommand(
    { provider: "aws", publicIp: "1.2.3.4" },
    { ...opts, privateKeyPath: SPACED_KEY },
  );
  // Double quotes rather than single: this is pasted into bash, PowerShell or
  // cmd, and only one of those three understands single quotes.
  assert.ok(cmd?.includes(`-i "${SPACED_KEY}"`));
  // The space must not split the argument — everything after it up to the
  // closing quote is still the path.
  assert.ok(cmd?.includes("Program Files"));
});

test("IdentitiesOnly is passed, or a loaded agent exhausts MaxAuthTries", () => {
  const cmd = sandboxShellCommand(
    { provider: "civo", publicIp: "1.2.3.4" },
    opts,
  );
  assert.ok(cmd?.includes("-o IdentitiesOnly=yes"));
});

test("the public address wins over the tailnet one", () => {
  // The tailnet address only works from a peer that can see this node; the
  // public one always answers, so it is the safe default to hand somebody.
  const cmd = sandboxShellCommand(
    { provider: "civo", publicIp: "1.2.3.4", tailscaleIp: "100.64.0.190" },
    opts,
  );
  assert.ok(cmd?.endsWith("nexus@1.2.3.4"));
});

test("a tailnet-only sandbox is still reachable", () => {
  const cmd = sandboxShellCommand(
    { provider: "civo", publicIp: null, tailscaleIp: "100.64.0.190" },
    opts,
  );
  assert.ok(cmd?.endsWith("nexus@100.64.0.190"));
});

test("a local sandbox execs into its container instead", () => {
  // No sshd in a container — the same door execRemote uses.
  const cmd = sandboxShellCommand(
    { provider: "local", instanceId: "nexux-app-abc123" },
    opts,
  );
  assert.equal(cmd, "docker exec -it -u nexus nexux-app-abc123 bash -l");
  assert.ok(!cmd?.includes(KEY), "a container needs no ssh key");
});

test("a machine with no address yet yields nothing, not a broken command", () => {
  // Rendering `ssh nexus@null` would be worse than rendering no button.
  assert.equal(sandboxShellCommand({ provider: "civo" }, opts), null);
  assert.equal(
    sandboxShellCommand({ provider: "civo", publicIp: "" }, opts),
    null,
  );
  assert.equal(sandboxShellCommand({ provider: "local" }, opts), null);
});

test("the label the row shows is the tail of the command it copies", () => {
  // The UI shortens the command by taking its last token rather than
  // rebuilding it, so the two can never disagree about the user.
  const cmd = sandboxShellCommand(
    { provider: "civo", publicIp: "1.2.3.4" },
    { ...opts, privateKeyPath: SPACED_KEY },
  )!;
  assert.equal(cmd.split(" ").pop(), "nexus@1.2.3.4");
});

test("permissionMode plan swaps bypassPermissions for read-only planning", () => {
  const cmd = buildClaudeCommand("plan the thing", { permissionMode: "plan" });
  assert.ok(cmd.includes("--permission-mode plan"));
  assert.ok(!cmd.includes("bypassPermissions"));
});

test("a run killed by our own timeout says so, with the minutes", () => {
  const r = finalizeClaudeRun(
    null,
    { code: -1, stderr: "", timedOut: true },
    { timeoutMs: 45 * 60_000 },
  );
  assert.equal(r.ok, false);
  assert.match(r.error!, /45-minute timeout/);
  assert.match(r.error!, /raise the task timeout/);
  // Without our flag the old message survives — a real crash stays a crash.
  const crash = finalizeClaudeRun(null, { code: -1, stderr: "" });
  assert.match(crash.error!, /without a result event/);
});
