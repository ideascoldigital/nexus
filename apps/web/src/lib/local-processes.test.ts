import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { firstLocalUrl, isAlive, listLocalProcesses, startLocalProcess, stopLocalProcess } from "./local-processes";

// getConfig() reads NEXUX_DATA_DIR on each call, and the shell is picked per
// start — set here, before any test runs. A plain sh keeps the user's profile out.
process.env.NEXUX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-run-"));
process.env.SHELL = "/bin/sh";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a dev server's local URL is found in its output, colours and all", () => {
  assert.equal(firstLocalUrl("  ▲ Next.js 16\n  - Local:        \x1b[36mhttp://localhost:3002\x1b[39m\n"), "http://localhost:3002");
  assert.equal(firstLocalUrl("listening on http://0.0.0.0:3000."), "http://localhost:3000");
  assert.equal(firstLocalUrl("nothing here"), null);
});

test("a process starts detached, is listed while it runs, and stops with its group", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-repo-"));
  const p = startLocalProcess({ projectId: "p1", repo: "api", label: "API", command: "echo up at http://localhost:4321 && sleep 30", cwd });
  await wait(300);
  const [view] = listLocalProcesses("p1");
  assert.equal(view?.running, true);
  assert.equal(view?.url, "http://localhost:4321");
  assert.ok(fs.readFileSync(p.logPath, "utf8").includes("$ echo up"));
  assert.ok(stopLocalProcess(p.id));
  await wait(300);
  assert.equal(isAlive(p.pid), false);
  const after = listLocalProcesses("p1");
  assert.equal(after[0]?.running, false);
  assert.ok(after[0]?.stoppedAt);
});

test("running a repository again replaces the one already running", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-repo-"));
  const a = startLocalProcess({ projectId: "p2", repo: "ui", label: "UI", command: "sleep 30", cwd });
  await wait(200);
  const b = startLocalProcess({ projectId: "p2", repo: "ui", label: "UI", command: "sleep 30", cwd });
  await wait(300);
  assert.equal(isAlive(a.pid), false);
  assert.equal(isAlive(b.pid), true);
  stopLocalProcess(b.id);
});

test("a multi-line command or a missing folder is refused", () => {
  assert.throws(() => startLocalProcess({ projectId: "p", repo: "r", label: "r", command: "ls\nrm x", cwd: os.tmpdir() }));
  assert.throws(() => startLocalProcess({ projectId: "p", repo: "r", label: "r", command: "ls", cwd: "/nope/not/here" }));
});
