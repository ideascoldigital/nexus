import assert from "node:assert/strict";
import { test } from "node:test";

// Env setup must stay above the @nexux/db import.
import { setActiveWorkspace } from "../app/api/workspace-routes.test-setup";
import { prisma } from "@nexux/db";

import { POST as createBotRoute } from "../app/api/bots/route";
import {
  nexusClaudeArgs,
  parseClaudeOutput,
  renderNexusIntro,
  renderNexusSystemPrompt,
} from "./nexus-assistant";

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

test("the Nexus chat runs with Nexus's tools and nothing else", () => {
  const args = nexusClaudeArgs({
    prompt: "hola",
    systemPrompt: "SYS",
    mcpConfig: '{"mcpServers":{}}',
    allowedTools: ["mcp__nexus__nexux_create_project", "mcp__nexus__nexux_scan_directory"],
  });
  assert.equal(flag(args, "-p"), "hola");
  assert.equal(flag(args, "--tools"), ""); // no Bash, Read, Edit, Write, web
  assert.ok(args.includes("--strict-mcp-config")); // not the user's MCP servers
  assert.equal(flag(args, "--allowedTools"), "mcp__nexus__nexux_create_project,mcp__nexus__nexux_scan_directory");
  assert.equal(flag(args, "--setting-sources"), "local"); // not the user's settings or hooks
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(!args.includes("--resume"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  const resumed = nexusClaudeArgs({ prompt: "x", systemPrompt: "", mcpConfig: "{}", allowedTools: [], resume: "s1", model: "opus" });
  assert.equal(flag(resumed, "--resume"), "s1");
  assert.equal(flag(resumed, "--model"), "opus");
  assert.ok(!resumed.includes("--effort"));
  const effort = nexusClaudeArgs({ prompt: "x", systemPrompt: "", mcpConfig: "{}", allowedTools: [], effort: "xhigh" });
  assert.equal(flag(effort, "--effort"), "xhigh");
  const bogus = nexusClaudeArgs({ prompt: "x", systemPrompt: "", mcpConfig: "{}", allowedTools: [], effort: "--yolo" });
  assert.ok(!bogus.includes("--effort"));
});

test("a reply, its session and cost are read from the CLI's JSON", () => {
  const out = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "¡Hola!", session_id: "abc", total_cost_usd: 0.02 });
  assert.deepEqual(parseClaudeOutput(out, "", 0), { ok: true, result: "¡Hola!", error: undefined, sessionId: "abc", costUsd: 0.02 });
  const failed = JSON.stringify({ is_error: true, result: "Credit balance is too low", session_id: "abc" });
  assert.equal(parseClaudeOutput(failed, "", 1).error, "Credit balance is too low");
  assert.deepEqual(parseClaudeOutput("", "Error: not logged in\n", 1), { ok: false, error: "Error: not logged in" });
  assert.deepEqual(parseClaudeOutput("", "", null, true), { ok: false, canceled: true });
});

test("stream-json: the result event is read, not whatever line came last", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Listo.", session_id: "s1" }),
    JSON.stringify({ type: "system", subtype: "status" }),
  ].join("\n");
  assert.equal(parseClaudeOutput(stream, "", 0).result, "Listo.");
  // Stopped before any result: never "status" as the error.
  const stopped = JSON.stringify({ type: "system", subtype: "status" });
  assert.notEqual(parseClaudeOutput(stopped, "", 143).error, "status");
});

test("the new-project chat asks where the code comes from; a project chat knows its project", () => {
  assert.match(renderNexusSystemPrompt(null), /no project yet/);
  assert.match(renderNexusSystemPrompt(null), /never ask the user to paste a token/);
  assert.match(renderNexusSystemPrompt({ id: "p1", name: "Acme" }), /project "Acme" \(projectId p1\)/);
  // fnpm is the default when installed; otherwise only mentioned.
  assert.match(renderNexusSystemPrompt(null, { fnpm: true }), /fnpm setup <pm>; fnpm install && fnpm run <script>/);
  assert.doesNotMatch(renderNexusSystemPrompt(null), /fnpm setup/);
  assert.match(renderNexusIntro("revisa las campañas"), /^\[nexux:intro\]/);
  assert.match(renderNexusIntro(null), /Spanish/);
});

test("a project chat is created from the New Bot dialog, with no computer and its greeting queued", async () => {
  await prisma.workspace.upsert({ where: { id: "ws-default" }, update: {}, create: { id: "ws-default", name: "Mine" } });
  setActiveWorkspace("ws-default");
  const res = await createBotRoute(
    new Request("http://x/api/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "nexus", name: "Tienda" }),
    }) as never,
  );
  assert.equal(res.status, 201);
  const chat = await res.json();
  assert.equal(chat.kind, "nexus");
  assert.equal(chat.name, "Tienda");
  assert.equal(chat.projectId, null);
  // The greeting is queued on its host session (tests never start Claude).
  for (let i = 0; i < 20; i++) {
    if (await prisma.botRun.count({ where: { botId: chat.id } })) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const run = await prisma.botRun.findFirst({ where: { botId: chat.id }, include: { session: true } });
  assert.match(run?.prompt ?? "", /^\[nexux:intro\]/);
  assert.equal(run?.session.containerName, "nexus-host");
  assert.equal(run?.session.status, "host");
});
