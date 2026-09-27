import assert from "node:assert/strict";
import { test } from "node:test";

import { parseToolRequest, renderToolCatalog, runToolLoop, type LoopTool } from "./loop";

const call = (tool: string, args: Record<string, unknown> = {}) => "```json\n" + JSON.stringify({ tool, args }) + "\n```";

function scripted(replies: string[]) {
  const seen: string[] = [];
  let i = 0;
  return {
    seen,
    agent: {
      run: async (input: string) => {
        seen.push(input);
        return { message: replies[Math.min(i++, replies.length - 1)] };
      },
    },
  };
}

function tools(ran: string[]): LoopTool[] {
  return [
    { name: "read_it", description: "reads", inputSchema: { type: "object" }, kind: "read", run: async (a) => (ran.push("read_it"), { got: a }) },
    { name: "launch_it", description: "spends money", inputSchema: { type: "object" }, kind: "write", run: async () => (ran.push("launch_it"), { launched: true }) },
  ];
}

test("reads run and feed their result back; prose ends the turn", async () => {
  const ran: string[] = [];
  const { agent, seen } = scripted([call("read_it", { x: 1 }), "all good"]);
  const turn = await runToolLoop({ agent, tools: tools(ran), message: "hi", history: [] });
  assert.deepEqual(ran, ["read_it"]);
  assert.match(seen[1], /^TOOL_RESULT read_it: \{"got":\{"x":1\}\}/);
  assert.equal(turn.raw, "all good");
  assert.equal(turn.pending, null);
  assert.equal(turn.history.length, 4, "both exchanges are in the returned history");
});

test("a write is never run — the turn stops and hands it back", async () => {
  const ran: string[] = [];
  const { agent } = scripted([call("read_it"), call("launch_it", { p: "galtex" }), "should not get here"]);
  const turn = await runToolLoop({ agent, tools: tools(ran), message: "launch", history: [] });
  assert.deepEqual(ran, ["read_it"], "the write did not run");
  assert.deepEqual(turn.pending, { tool: "launch_it", args: { p: "galtex" } });
});

test("a tool outside the list is prose, not a call", () => {
  assert.equal(parseToolRequest(call("rm_rf"), new Set(["read_it"])), null);
});

test("the catalogue marks writes and carries each schema", () => {
  const text = renderToolCatalog(tools([]));
  assert.match(text, /launch_it \[WRITE — needs the user's approval\]/);
  assert.match(text, /read_it — reads Args schema: \{"type":"object"\}/);
});

test("a model that never stops calling tools is cut off with a readable reply", async () => {
  const { agent } = scripted([call("read_it")]);
  const turn = await runToolLoop({ agent, tools: tools([]), message: "go", history: [], maxIterations: 3 });
  assert.equal(turn.toolCalls.length, 3);
  assert.match(turn.raw, /ran out of tool steps/);
});
