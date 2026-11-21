import assert from "node:assert/strict";
import { test } from "node:test";

import {
  botActivity,
  botInputSchema,
  describeRunsOn,
  botPreview,
  botSteps,
  buildProgress,
  formatBuildProgress,
  logTail,
  shapeRun,
  shapeSession,
  promptHash,
  toContainerUrls,
  withEarlierContext,
  withRoutinesNote,
} from "./bot-view";
import { HANDBACK_PROMPT } from "./bot-prompts";

const base = {
  id: "s1",
  error: null,
  vncPort: 49153,
  vncPassword: "secret",
  createdAt: new Date(0),
  stoppedAt: null,
  lastActivityAt: new Date(0),
};

test("a ready session exposes its noVNC page; any other state does not", () => {
  const ready = shapeSession({ ...base, status: "ready" });
  assert.ok(ready?.vncUrl?.startsWith("http://127.0.0.1:49153/nexux-screen.html?"));
  assert.ok(ready?.vncFullUrl?.startsWith("http://127.0.0.1:49153/vnc.html?"));
  assert.equal(shapeSession({ ...base, status: "starting" })?.vncUrl, null);
  assert.equal(shapeSession({ ...base, status: "stopped" })?.vncUrl, null);
  assert.equal(shapeSession({ ...base, status: "ready", vncPort: null })?.vncUrl, null);
  assert.equal(shapeSession(null), null);
  // The password only ever travels inside the URL.
  assert.ok(!("vncPassword" in (ready as object)));
});

test("logTail keeps the last non-empty lines", () => {
  assert.equal(logTail("a\n\nb\nc\n", 2), "b\nc");
  assert.equal(logTail(""), "");
});

test("shapeRun drops the log and only tails it while running", () => {
  const running = shapeRun({ id: "r", status: "running", log: "x\ny\n" });
  assert.equal(running.logTail, "x\ny");
  assert.ok(!("log" in running));
  assert.equal(shapeRun({ id: "r", status: "completed", log: "x" }).logTail, null);
  assert.equal(shapeRun({ id: "r", status: "running", log: "" }).logTail, null);
});

test("botActivity reads the latest session and pending prompts", () => {
  assert.equal(botActivity(null, 0), "off");
  assert.equal(botActivity({ status: "starting" }, 1), "starting");
  assert.equal(botActivity({ status: "ready" }, 0), "idle");
  assert.equal(botActivity({ status: "ready" }, 2), "working");
  assert.equal(botActivity({ status: "error" }, 0), "error");
  assert.equal(botActivity({ status: "stopped" }, 0), "off");
});

test("botInputSchema trims, bounds and validates", () => {
  assert.equal(botInputSchema.parse({ name: "  QA  " }).name, "QA");
  assert.equal(botInputSchema.safeParse({ name: "" }).success, false);
  assert.equal(botInputSchema.safeParse({ name: "x", color: "red" }).success, false);
  assert.equal(botInputSchema.safeParse({ name: "x", idleMinutes: 1 }).success, false);
  assert.equal(botInputSchema.safeParse({ name: "x", color: "#AbCdEf", idleMinutes: 15 }).success, true);
});

test("buildProgress folds BuildKit plain output into the current step and line", () => {
  let p = { step: null as string | null, line: null as string | null };
  p = buildProgress(p, "#3 [1/6] FROM docker.io/library/debian:bookworm-slim\n#3 DONE 6.8s\n");
  assert.equal(p.step, "1/6");
  assert.equal(p.line, null);
  p = buildProgress(p, "#5 [2/6] RUN apt-get update\n#5 519.3 Get:179 http://deb.debian.org libxft2\r\n");
  assert.deepEqual(p, { step: "2/6", line: "Get:179 http://deb.debian.org libxft2" });
  p = buildProgress(p, "#4 [internal] load .dockerignore\n#4 DONE 0.0s\n");
  assert.equal(p.line, "Get:179 http://deb.debian.org libxft2");
  assert.equal(
    formatBuildProgress(p),
    "Building the computer image (first run only) · step 2/6 · Get:179 http://deb.debian.org libxft2",
  );
  assert.equal(buildProgress(p, `#5 1.0 ${"x".repeat(300)}`).line?.length, 118);
});

test("shapeSession shows boot progress only while starting", () => {
  const s = {
    id: "s1",
    status: "starting",
    error: null,
    vncPort: null,
    vncPassword: null,
    createdAt: new Date(0),
    stoppedAt: null,
    lastActivityAt: new Date(0),
  };
  assert.equal(shapeSession(s, "step 2/6")?.progress, "step 2/6");
  assert.equal(shapeSession({ ...s, status: "error" }, "step 2/6")?.progress, null);
});

test("botSteps turns tool lines into chips, dropping bookkeeping and repeats", () => {
  const log = [
    "[claude] session started",
    "Let me open the page.",
    "[claude] mcp__browser__browser_navigate https://example.com",
    "[claude] mcp__browser__browser_snapshot",
    "[claude] mcp__browser__browser_click Sign in button",
    "[claude] mcp__browser__browser_click Sign in button",
    "[claude] WebSearch best ai model",
    "[claude] TodoWrite",
    "[claude] mcp__other__do_thing",
    "[claude] finished (success)",
  ].join("\n");
  assert.deepEqual(botSteps(log), [
    { app: "Browser", action: "Opened", detail: "https://example.com" },
    { app: "Browser", action: "Clicked", detail: "Sign in button" },
    { app: "Search", action: "Searched", detail: "best ai model" },
    { app: "Tool", action: "do thing", detail: null },
  ]);
  assert.equal(botSteps(Array(30).fill(0).map((_, i) => `[claude] Bash echo ${i}`).join("\n")).length, 12);
});

test("botPreview is one clean line per run state", () => {
  const run = { prompt: "do **it**", status: "completed", result: "## Done\n\nSee [the page](https://x.y) now", error: null, needsInput: false };
  assert.equal(botPreview(run), "Done See the page now");
  assert.equal(botPreview({ ...run, status: "running" }), "Working…");
  assert.equal(botPreview({ ...run, status: "queued" }), "You: do it");
  assert.equal(botPreview({ ...run, status: "error", error: "boom" }), "Error: boom");
  assert.equal(botPreview(null), null);
});

test("the input schema accepts known shapes only", () => {
  assert.ok(botInputSchema.safeParse({ name: "A", shape: "flower" }).success);
  assert.ok(!botInputSchema.safeParse({ name: "A", shape: "dragon" }).success);
});

test("a fresh computer's first prompt carries the earlier chat", () => {
  assert.equal(withEarlierContext("hi", []), "hi");
  const out = withEarlierContext(
    "intenta de nuevo",
    [
      { prompt: "Inicia sesión en Google Ads", result: "NEEDS_INPUT: necesito la contraseña" },
      { prompt: HANDBACK_PROMPT, result: "x".repeat(900) },
    ],
    700,
  );
  assert.match(out, /computer was reset/);
  assert.match(out, /The user asked: Inicia sesión en Google Ads\nYou answered: NEEDS_INPUT/);
  assert.match(out, /took control of your computer, then handed it back/);
  assert.ok(!out.includes("x".repeat(701)));
  assert.ok(out.endsWith("New message from the user:\nintenta de nuevo"));
});

test("links to the user's machine are rewritten for the bot's container", () => {
  assert.equal(
    toContainerUrls("el logo: http://localhost:3100/icon.svg y http://127.0.0.1:8080/x"),
    "el logo: http://host.docker.internal:3100/icon.svg y http://host.docker.internal:8080/x",
  );
  assert.equal(toContainerUrls("https://localhost/a"), "https://host.docker.internal/a");
  assert.equal(toContainerUrls("http://[::1]:5173"), "http://host.docker.internal:5173");
  // Only real links: words and other hosts stay.
  assert.equal(toContainerUrls("corre en localhost:3000"), "corre en localhost:3000");
  assert.equal(toContainerUrls("https://localhostify.com/a"), "https://localhostify.com/a");
  assert.equal(toContainerUrls("https://example.com/localhost"), "https://example.com/localhost");
});

test("fresh-session context says why: new computer vs new instructions", () => {
  const h = [{ prompt: "hola", result: "hola!" }];
  assert.match(withEarlierContext("x", h), /computer was reset/);
  assert.match(withEarlierContext("x", h, 700, "memory"), /instructions were updated.*same computer/);
});

test("routines ride with each message; the system prompt hash notices changes", () => {
  assert.equal(withRoutinesNote("hola", []), "hola");
  assert.equal(
    withRoutinesNote("hola", [{ name: "Gastos", cron: "0 8 * * 1", enabled: false }]),
    '[Nexus: your routines now — "Gastos" (Every Monday around 8:00 AM, `0 8 * * 1`, paused)]\n\nhola',
  );
  assert.equal(promptHash("a"), promptHash("a"));
  assert.notEqual(promptHash("a"), promptHash("b"));
  assert.equal(promptHash("a").length, 16);
});

test("a computer says which machine it is on, never a bare null", () => {
  assert.deepEqual(describeRunsOn(null), { kind: "local", label: "this machine" });
  assert.deepEqual(describeRunsOn(undefined), { kind: "local", label: "this machine" });
  // A socket endpoint is on this machine: local, but worth naming.
  assert.deepEqual(describeRunsOn("unix:///Users/me/.litek8s/docker.sock"), {
    kind: "local",
    label: "/Users/me/.litek8s/docker.sock",
  });
  assert.deepEqual(describeRunsOn("ssh://dev@devbox"), { kind: "remote", label: "dev@devbox" });
});

test("a session carries where it runs, so the screen can be labelled", () => {
  const row = {
    id: "s1",
    status: "ready",
    error: null,
    vncPort: 6080,
    vncPassword: "pw",
    createdAt: new Date(),
    stoppedAt: null,
    lastActivityAt: new Date(),
  };
  assert.equal(shapeSession(row)?.runsOn.kind, "local");
  assert.equal(shapeSession({ ...row, dockerHost: "ssh://devbox" })?.runsOn.kind, "remote");
});
