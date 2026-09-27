import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import "../../app/api/routes.test-setup";
import { prisma } from "@nexux/db";
import type { NexuxContext } from "@nexux/mcp";

import { approveAction, cancelAction, createThread, runThreadTurn, type AssistantDeps } from "./threads";

const call = (tool: string, args: Record<string, unknown> = {}) => "```json\n" + JSON.stringify({ tool, args }) + "\n```";

type Rec = { launches: unknown[]; histories: Array<Array<{ role: string; content: string }>>; prompts: string[] };

function deps(replies: string[]): { deps: AssistantDeps; rec: Rec } {
  const rec: Rec = { launches: [], histories: [], prompts: [] };
  let i = 0;
  const ctx = {
    listProjects: async () => [{ id: "p1", name: "galtex", createdAt: "2026-01-01T00:00:00.000Z" }],
    launchSandbox: async (input: unknown) => {
      rec.launches.push(input);
      return { id: "s1", projectId: "p1", name: "sbx", status: "provisioning", provider: "local", runsOn: "omarchy", dockerEndpointId: null, previewUrl: null, createdAt: "2026-01-01T00:00:00.000Z" };
    },
  } as unknown as NexuxContext;
  return {
    rec,
    deps: {
      ctx: () => ctx,
      defineAgent: async () => ({
        run: async (input, opts) => {
          rec.prompts.push(input);
          rec.histories.push((opts?.history ?? []).map((h) => ({ role: h.role, content: String(h.content) })));
          return { message: replies[Math.min(i++, replies.length - 1)] };
        },
      }),
    },
  };
}

beforeEach(async () => {
  await prisma.assistantThread.deleteMany({});
});

const kinds = async (threadId: string) =>
  (await prisma.assistantEvent.findMany({ where: { threadId }, orderBy: { createdAt: "asc" } })).map((e) => e.kind);

test("a read runs through the MCP tools and the turn is kept as events", async () => {
  const t = await createThread();
  const { deps: d } = deps([call("nexux_list_projects"), "You have one project: galtex."]);
  const thread = await runThreadTurn(t.id, "what projects do I have?", {}, d);
  assert.deepEqual(await kinds(t.id), ["user", "tool_call", "tool_result", "assistant"]);
  assert.equal(thread?.title, "what projects do I have?");
  const result = thread!.events.find((e) => e.kind === "tool_result")!.content as { text: string };
  assert.match(result.text, /TOOL_RESULT nexux_list_projects: .*galtex/);
});

test("a write becomes a pending action and does not run", async () => {
  const t = await createThread();
  const { deps: d, rec } = deps([call("nexux_launch_sandbox", { projectId: "p1", provider: "local", dockerEndpoint: "omarchy" })]);
  const thread = await runThreadTurn(t.id, "launch one on omarchy", {}, d);
  assert.equal(rec.launches.length, 0, "nothing launched");
  const action = thread!.actions[0];
  assert.equal(action.status, "pending");
  assert.match(action.summary, /Launch a local sandbox on omarchy for project p1/);
  await assert.rejects(() => runThreadTurn(t.id, "and another", {}, d), /waiting for your decision/);
});

test("approving runs it once, records the result, and the assistant reacts", async () => {
  const t = await createThread();
  const { deps: d, rec } = deps([call("nexux_launch_sandbox", { projectId: "p1" }), "It is provisioning on omarchy."]);
  const first = await runThreadTurn(t.id, "launch one", {}, d);
  const actionId = first!.actions[0].id;
  const after = await approveAction(t.id, actionId, d);
  assert.equal(rec.launches.length, 1);
  assert.equal(after!.actions[0].status, "done");
  assert.deepEqual((await kinds(t.id)).slice(-2), ["tool_result", "assistant"]);
  // The resumed turn saw the whole exchange, ending with the approval request.
  const lastHistory = rec.histories.at(-1)!;
  assert.equal(lastHistory.at(-1)!.role, "assistant");
  assert.match(rec.prompts.at(-1)!, /^TOOL_RESULT nexux_launch_sandbox: .*provisioning/);
  await assert.rejects(() => approveAction(t.id, actionId, d), /already done/);
  assert.equal(rec.launches.length, 1, "a second click does not launch twice");
});

test("cancelling records it for the model and runs nothing", async () => {
  const t = await createThread();
  const { deps: d, rec } = deps([call("nexux_launch_sandbox", { projectId: "p1" }), "ok"]);
  const first = await runThreadTurn(t.id, "launch one", {}, d);
  const promptsBefore = rec.prompts.length;
  const after = await cancelAction(t.id, first!.actions[0].id);
  assert.equal(after!.actions[0].status, "cancelled");
  assert.equal(rec.launches.length, 0);
  assert.equal(rec.prompts.length, promptsBefore, "no turn ran");
  // The next turn's history carries the refusal.
  await runThreadTurn(t.id, "never mind", {}, d);
  assert.ok(rec.histories.at(-1)!.some((h) => /declined this action/.test(h.content)));
});

test("history is rebuilt from events across turns, verbatim", async () => {
  const t = await createThread();
  const { deps: d, rec } = deps([call("nexux_list_projects"), "one project", "sure"]);
  await runThreadTurn(t.id, "projects?", {}, d);
  await runThreadTurn(t.id, "thanks", {}, d);
  const h = rec.histories.at(-1)!;
  assert.deepEqual(h.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(h[0].content, "projects?");
  assert.match(h[2].content, /^TOOL_RESULT nexux_list_projects/);
});

test("a thread limited to read scopes never offers a write", async () => {
  const t = await createThread({ scopes: ["projects:read"] });
  const { deps: d, rec } = deps([call("nexux_launch_sandbox", { projectId: "p1" })]);
  const thread = await runThreadTurn(t.id, "launch", {}, d);
  assert.equal(thread!.actions.length, 0, "the tool is not in its list, so the reply is prose");
  assert.equal(rec.launches.length, 0);
});
