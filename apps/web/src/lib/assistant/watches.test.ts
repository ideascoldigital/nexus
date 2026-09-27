import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

import "../../app/api/routes.test-setup";
import { prisma } from "@nexux/db";
import type { NexuxContext } from "@nexux/mcp";

import { createThread, type AssistantDeps } from "./threads";
import { fireAssistantWatches, watchMet, watchTool } from "./watches";

let projectId: string;
let sandboxId: string;

before(async () => {
  const ws = await prisma.workspace.create({ data: { name: "ws-watch" } });
  projectId = (await prisma.project.create({ data: { name: "p", workspaceId: ws.id } })).id;
});

beforeEach(async () => {
  await prisma.assistantThread.deleteMany({});
  await prisma.sandbox.deleteMany({ where: { projectId } });
  sandboxId = (
    await prisma.sandbox.create({
      data: { projectId, name: "sbx", status: "provisioning", provider: "local", region: "omarchy", size: "docker", workDir: "/tmp/x" },
    })
  ).id;
});

function deps(replies: string[]): { deps: AssistantDeps; prompts: string[]; toolNames: string[][] } {
  const prompts: string[] = [];
  const toolNames: string[][] = [];
  let i = 0;
  return {
    prompts,
    toolNames,
    deps: {
      ctx: () => ({}) as NexuxContext,
      defineAgent: async (spec) => {
        toolNames.push([...spec.instructions.matchAll(/^- (\S+)/gm)].map((m) => m[1]));
        return {
          run: async (input) => {
            prompts.push(input);
            return { message: replies[Math.min(i++, replies.length - 1)] };
          },
        };
      },
    },
  };
}

test("when a watch is met", () => {
  assert.equal(watchMet("sandbox", "running", { status: "provisioning" }), false);
  assert.equal(watchMet("sandbox", "running", { status: "running" }), true);
  assert.equal(watchMet("sandbox", "running", { status: "error" }), true, "failing to come up is news too");
  assert.equal(watchMet("task", "finished", { status: "running", needsInput: false }), false);
  assert.equal(watchMet("task", "finished", { status: "completed", needsInput: false }), true);
  assert.equal(watchMet("task", "finished", { status: "running", needsInput: true }), true, "a blocked task will not finish on its own");
  assert.equal(watchMet("task", "needs_input", { status: "completed", needsInput: false }), false);
});

test("the watch tool starts a watch, or says it already happened", async () => {
  const t = await createThread();
  const started = (await watchTool(t.id).run({ kind: "sandbox", id: sandboxId, until: "running" })) as { watching: boolean };
  assert.equal(started.watching, true);
  assert.equal(await prisma.assistantWatch.count({ where: { threadId: t.id, status: "open" } }), 1);
  await prisma.sandbox.update({ where: { id: sandboxId }, data: { status: "running" } });
  const already = (await watchTool(t.id).run({ kind: "sandbox", id: sandboxId, until: "running" })) as { alreadyHappened: boolean };
  assert.equal(already.alreadyHappened, true);
  assert.deepEqual(await watchTool(t.id).run({ kind: "sandbox", id: "nope", until: "running" }), { error: "No sandbox nope" });
});

test("a met watch reports once into its thread, and the reply turn gets reads only", async () => {
  const t = await createThread();
  await watchTool(t.id).run({ kind: "sandbox", id: sandboxId, until: "running" });
  const { deps: d, prompts, toolNames } = deps(["The sandbox sbx is up on omarchy."]);

  await fireAssistantWatches("sandbox", sandboxId, d); // still provisioning
  assert.equal(prompts.length, 0, "nothing to report yet");

  await prisma.sandbox.update({ where: { id: sandboxId }, data: { status: "running" } });
  await fireAssistantWatches("sandbox", sandboxId, d);
  await fireAssistantWatches("sandbox", sandboxId, d); // a second notification
  assert.equal(prompts.length, 1, "reported once");
  assert.match(prompts[0], /^WATCH_REPORT sandbox .* \(until running\): .*"status":"running"/);

  const kinds = (await prisma.assistantEvent.findMany({ where: { threadId: t.id }, orderBy: { createdAt: "asc" } })).map((e) => e.kind);
  assert.deepEqual(kinds, ["watch_report", "assistant"]);
  assert.equal((await prisma.assistantWatch.findFirstOrThrow({ where: { threadId: t.id } })).status, "fired");
  assert.ok(!toolNames[0].includes("nexux_launch_sandbox"), "no writes in a report turn");
  assert.ok(toolNames[0].includes("watch"));
});

test("an expired watch never reports", async () => {
  const t = await createThread();
  await prisma.assistantWatch.create({
    data: { threadId: t.id, kind: "sandbox", targetId: sandboxId, until: "running", expiresAt: new Date(Date.now() - 1000) },
  });
  await prisma.sandbox.update({ where: { id: sandboxId }, data: { status: "running" } });
  const { deps: d, prompts } = deps(["x"]);
  await fireAssistantWatches("sandbox", sandboxId, d);
  assert.equal(prompts.length, 0);
  assert.equal((await prisma.assistantWatch.findFirstOrThrow({ where: { threadId: t.id } })).status, "expired");
});
