import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

// Env setup must stay above the service imports — the module graph reaches
// @nexux/db, whose client is built at module load.
import { testDbDir } from "./services.test-setup";
import {
  runStackAssistantTurn,
  type StackTurnDeps,
} from "./stack-assistant-agent";

after(() => {
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const toolCall = (tool: string, args: Record<string, unknown> = {}) =>
  `\`\`\`json\n${JSON.stringify({ tool, args })}\n\`\`\``;

type Recorded = {
  prompts: string[];
  histories: { role: string; content: string }[][];
  tools: { tool: string; projectId: string; args: Record<string, unknown> }[];
  defined: { name: string; workspaceId?: string }[];
};

/**
 * `replies` is consumed one per agent turn; the last one repeats once the
 * list runs out, so a loop that never stops keeps seeing a tool request.
 */
function deps(opts: {
  replies: string[];
  toolResult?: unknown;
  toolThrows?: boolean;
  workspaceId?: string;
}): { deps: StackTurnDeps; rec: Recorded } {
  const rec: Recorded = { prompts: [], histories: [], tools: [], defined: [] };
  let turn = 0;
  return {
    rec,
    deps: {
      defineAgent: async (spec) => {
        rec.defined.push({ name: spec.name, workspaceId: spec.workspaceId });
        return {
          run: async (input, runOpts) => {
            rec.prompts.push(input);
            rec.histories.push(
              (runOpts?.history ?? []).map((h) => ({
                role: h.role,
                content: h.content,
              }))
            );
            const reply =
              opts.replies[turn] ?? opts.replies[opts.replies.length - 1];
            turn++;
            return { message: reply };
          },
        };
      },
      workspaceIdOfProject: async () => opts.workspaceId,
      runTool: async (tool, projectId, args) => {
        rec.tools.push({ tool, projectId, args });
        if (opts.toolThrows) throw new Error("tool exploded");
        return opts.toolResult ?? { ok: true };
      },
    },
  };
}

test("the agent is defined for the project's workspace", async () => {
  const { deps: d, rec } = deps({ replies: ["done"], workspaceId: "ws-3" });
  await runStackAssistantTurn("p1", "hi", [], d);
  assert.deepEqual(rec.defined, [
    { name: "stack-assistant", workspaceId: "ws-3" },
  ]);
});

test("a prose reply ends the turn without calling a tool", async () => {
  const { deps: d, rec } = deps({ replies: ["Your stack looks fine."] });
  const turn = await runStackAssistantTurn("p1", "hi", [], d);
  assert.deepEqual(turn.toolCalls, []);
  assert.equal(rec.tools.length, 0);
  assert.equal(turn.message, "Your stack looks fine.");
});

test("a tool request is executed and the answer continues the turn", async () => {
  const { deps: d, rec } = deps({
    replies: [toolCall("get_stack_context"), "Here is what I found."],
  });
  const turn = await runStackAssistantTurn("p1", "what runs here?", [], d);
  assert.deepEqual(turn.toolCalls, ["get_stack_context"]);
  assert.equal(rec.tools[0].tool, "get_stack_context");
  assert.equal(rec.tools[0].projectId, "p1");
  assert.equal(turn.message, "Here is what I found.");
});

test("tool arguments reach the tool", async () => {
  const { deps: d, rec } = deps({
    replies: [toolCall("read_repo_file", { path: "src/app.ts" }), "ok"],
  });
  await runStackAssistantTurn("p1", "read it", [], d);
  assert.deepEqual(rec.tools[0].args, { path: "src/app.ts" });
});

test("the tool result is fed back as the next prompt", async () => {
  const { deps: d, rec } = deps({
    replies: [toolCall("get_stack_context"), "done"],
    toolResult: { services: ["db"] },
  });
  await runStackAssistantTurn("p1", "q", [], d);
  assert.match(rec.prompts[1], /^TOOL_RESULT get_stack_context: /);
  assert.match(rec.prompts[1], /"services"/);
});

test("the exchange is appended to the history the agent sees", async () => {
  const { deps: d, rec } = deps({
    replies: [toolCall("get_stack_context"), "done"],
  });
  await runStackAssistantTurn("p1", "what runs here?", [], d);
  // Second turn sees the original question and the tool-request reply.
  const second = rec.histories[1];
  assert.equal(second.length, 2);
  assert.deepEqual(second[0], { role: "user", content: "what runs here?" });
  assert.equal(second[1].role, "assistant");
});

test("prior conversation history is preserved across tool calls", async () => {
  const history = [{ role: "user" as const, content: "earlier turn" }];
  const { deps: d, rec } = deps({
    replies: [toolCall("get_stack_context"), "done"],
  });
  await runStackAssistantTurn("p1", "now this", history, d);
  assert.equal(rec.histories[0][0].content, "earlier turn");
  assert.equal(rec.histories[1][0].content, "earlier turn");
  assert.equal(rec.histories[1].length, 3);
});

test("the caller's history array is not mutated", async () => {
  const history = [{ role: "user" as const, content: "earlier" }];
  const { deps: d } = deps({ replies: [toolCall("get_stack_context"), "done"] });
  await runStackAssistantTurn("p1", "q", history, d);
  assert.equal(history.length, 1);
});

test("several tools can be called in one turn", async () => {
  const { deps: d } = deps({
    replies: [
      toolCall("get_stack_context"),
      toolCall("read_repo_file", { path: "a.ts" }),
      toolCall("search_project", { query: "auth" }),
      "final answer",
    ],
  });
  const turn = await runStackAssistantTurn("p1", "q", [], d);
  assert.deepEqual(turn.toolCalls, [
    "get_stack_context",
    "read_repo_file",
    "search_project",
  ]);
  assert.equal(turn.message, "final answer");
});

test("a model that only ever calls tools is stopped at the iteration cap", async () => {
  // Without the cap this loops forever, burning tokens on every turn.
  const { deps: d, rec } = deps({ replies: [toolCall("get_stack_context")] });
  const turn = await runStackAssistantTurn("p1", "q", [], d);
  assert.equal(turn.toolCalls.length, 6);
  assert.equal(rec.tools.length, 6);
});

test("an oversized tool result is truncated before being fed back", async () => {
  // The result goes into the next prompt; unbounded, it would blow the
  // context window.
  const { deps: d, rec } = deps({
    replies: [toolCall("read_repo_file"), "done"],
    toolResult: { body: "x".repeat(60_000) },
  });
  await runStackAssistantTurn("p1", "q", [], d);
  assert.ok(
    rec.prompts[1].length < 25_000,
    `prompt was ${rec.prompts[1].length} chars`
  );
  assert.match(rec.prompts[1], /\(truncated\)$/);
});

test("a small tool result is fed back whole", async () => {
  const { deps: d, rec } = deps({
    replies: [toolCall("get_stack_context"), "done"],
    toolResult: { services: ["db"] },
  });
  await runStackAssistantTurn("p1", "q", [], d);
  assert.doesNotMatch(rec.prompts[1], /truncated/);
});

test("an unknown tool is not dispatched and ends the turn", async () => {
  // parseToolRequest rejects it, so the reply is treated as prose.
  const { deps: d, rec } = deps({ replies: [toolCall("rm_rf", { path: "/" })] });
  const turn = await runStackAssistantTurn("p1", "q", [], d);
  assert.deepEqual(turn.toolCalls, []);
  assert.equal(rec.tools.length, 0);
});

test("suggestions are parsed out of the final reply", async () => {
  const { deps: d } = deps({
    replies: [
      'Add a cache.\n```json\n{"suggestions":[{"nodeId":"n1","reason":"faster"}]}\n```',
    ],
  });
  const turn = await runStackAssistantTurn("p1", "q", [], d);
  assert.deepEqual(turn.suggestions, [{ nodeId: "n1", reason: "faster" }]);
  assert.equal(turn.message, "Add a cache.");
});

test("the raw reply is kept alongside the visible one", async () => {
  // The client re-parses rawMessage after reload to rebuild Apply buttons.
  const reply =
    'Add a cache.\n```json\n{"suggestions":[{"nodeId":"n1","reason":"r"}]}\n```';
  const { deps: d } = deps({ replies: [reply] });
  const turn = await runStackAssistantTurn("p1", "q", [], d);
  assert.equal(turn.rawMessage, reply);
  assert.notEqual(turn.message, turn.rawMessage);
});

test("an empty agent reply yields an empty turn rather than throwing", async () => {
  const { deps: d } = deps({ replies: [""] });
  const turn = await runStackAssistantTurn("p1", "q", [], d);
  assert.equal(turn.message, "");
  assert.deepEqual(turn.suggestions, []);
  assert.deepEqual(turn.toolCalls, []);
});

test("a failing tool surfaces rather than being silently swallowed", async () => {
  const { deps: d } = deps({
    replies: [toolCall("get_stack_context"), "done"],
    toolThrows: true,
  });
  await assert.rejects(
    () => runStackAssistantTurn("p1", "q", [], d),
    /tool exploded/
  );
});
