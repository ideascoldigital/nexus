import assert from "node:assert/strict";
import { test } from "node:test";

import { TOOLS, callTool, toolByName, toolsFor } from "./registry";
import { SCOPES, type NexuxContext, type Scope } from "./types";

// A context that records what it was asked to do. Every method throws unless a
// test opted into it: a tool reaching a capability its test did not expect is
// exactly the bug worth catching.
function stubContext(over: Partial<NexuxContext> = {}): {
  ctx: NexuxContext;
  calls: string[];
} {
  const calls: string[] = [];
  const unexpected = (name: string) => async () => {
    calls.push(name);
    throw new Error(`unexpected call: ${name}`);
  };
  const ctx = {
    listProjects: unexpected("listProjects"),
    getActivity: unexpected("getActivity"),
    listSandboxes: unexpected("listSandboxes"),
    getTask: unexpected("getTask"),
    getTaskLogs: unexpected("getTaskLogs"),
    createTask: unexpected("createTask"),
    launchSandbox: unexpected("launchSandbox"),
    powerSandbox: unexpected("powerSandbox"),
    validateStack: unexpected("validateStack"),
    describeStack: unexpected("describeStack"),
    ...over,
  } as NexuxContext;
  return { ctx, calls };
}

const ALL: Scope[] = [...SCOPES];

// --- the registry itself -----------------------------------------------------

test("every tool declares a known scope", () => {
  for (const tool of TOOLS) {
    assert.ok(
      (SCOPES as readonly string[]).includes(tool.scope),
      `${tool.name} declares an unknown scope: ${tool.scope}`,
    );
  }
});

test("tool names are unique and namespaced", () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool name");
  for (const name of names) assert.match(name, /^nexux_/);
});

test("every tool describes itself and its arguments", () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 20, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema.type, "object");
    // Silently ignoring an unknown argument is how a client's typo becomes a
    // call that does something other than what it asked for.
    assert.equal(
      tool.inputSchema.additionalProperties,
      false,
      `${tool.name} must refuse unknown arguments`,
    );
  }
});

test("anything that provisions or dispatches is behind a write scope", () => {
  // A read scope on a mutating tool is the mistake that matters here: it would
  // let a token issued as "read only" spend money.
  for (const tool of TOOLS) {
    const mutates = /create|launch|power/.test(tool.name);
    if (mutates) {
      assert.match(
        tool.scope,
        /:write$/,
        `${tool.name} mutates but declares ${tool.scope}`,
      );
    }
  }
});

test("launching a sandbox is not covered by the task-dispatch scope", () => {
  // The whole reason the two scopes are separate: a token that can queue work
  // onto existing machines must not be able to buy new ones.
  const launch = toolByName("nexux_launch_sandbox");
  const create = toolByName("nexux_create_task");
  assert.equal(launch?.scope, "sandboxes:write");
  assert.equal(create?.scope, "tasks:write");
  assert.notEqual(launch?.scope, create?.scope);
});

// --- listing -----------------------------------------------------------------

test("listing is filtered to what the scopes allow", () => {
  const listed = toolsFor(["tasks:read"]).map((t) => t.name);
  assert.ok(listed.includes("nexux_activity"));
  // Advertising a tool that will always be refused invites retrying it, and
  // tells the holder of a narrow token what a broader one could do.
  assert.ok(!listed.includes("nexux_create_task"));
  assert.ok(!listed.includes("nexux_launch_sandbox"));
});

test("no scopes lists no tools", () => {
  assert.deepEqual(toolsFor([]), []);
});

test("every scope is reachable — no tool is unlistable", () => {
  const listed = new Set(toolsFor(ALL).map((t) => t.name));
  assert.equal(listed.size, TOOLS.length);
});

// --- calling -----------------------------------------------------------------

test("a tool runs when its scope is held", async () => {
  const { ctx } = stubContext({
    listProjects: async () => [{ id: "p1", name: "Main", createdAt: "now" }],
  });
  const res = await callTool(ctx, ["projects:read"], "nexux_list_projects", {});
  assert.ok(res.ok);
  assert.deepEqual(res.result, [{ id: "p1", name: "Main", createdAt: "now" }]);
});

test("a tool whose scope is missing is refused, and never runs", async () => {
  const { ctx, calls } = stubContext();
  const res = await callTool(ctx, ["tasks:read"], "nexux_create_task", {
    projectId: "p1",
    sandboxId: "s1",
    prompt: "do the thing",
  });
  assert.ok(!res.ok);
  assert.deepEqual(calls, [], "the context was never touched");
});

test("an out-of-scope tool is indistinguishable from one that does not exist", async () => {
  // Naming the scope would confirm the tool exists and is worth attacking.
  const { ctx } = stubContext();
  const denied = await callTool(ctx, ["tasks:read"], "nexux_launch_sandbox", {
    projectId: "p1",
  });
  const missing = await callTool(ctx, ["tasks:read"], "nexux_launch_sandbox_x", {});
  assert.ok(!denied.ok && !missing.ok);
  assert.match(denied.error, /unknown tool/i);
  assert.ok(
    !/scope/i.test(denied.error),
    "the refusal must not mention scopes",
  );
});

test("holding every other scope does not grant the one a tool needs", async () => {
  const { ctx, calls } = stubContext();
  const others = ALL.filter((s) => s !== "sandboxes:write");
  const res = await callTool(ctx, others, "nexux_launch_sandbox", {
    projectId: "p1",
  });
  assert.ok(!res.ok);
  assert.deepEqual(calls, []);
});

test("bad arguments are an answer, not a crash", async () => {
  const { ctx, calls } = stubContext();
  const res = await callTool(ctx, ["sandboxes:read"], "nexux_list_sandboxes", {});
  assert.ok(!res.ok);
  assert.match(res.error, /projectId/);
  assert.deepEqual(calls, [], "parse failed before the context was reached");
});

test("a failure from the host is reported, not swallowed", async () => {
  const { ctx } = stubContext({
    createTask: async () => {
      throw new Error("This sandbox is already running a task");
    },
  });
  const res = await callTool(ctx, ["tasks:write"], "nexux_create_task", {
    projectId: "p1",
    sandboxId: "s1",
    prompt: "go",
  });
  assert.ok(!res.ok);
  assert.match(res.error, /already running/);
});

test("arguments reach the host in the shape it expects", async () => {
  let received: unknown;
  const { ctx } = stubContext({
    createTask: async (input) => {
      received = input;
      return {
        id: "t1",
        projectId: input.projectId,
        sandboxId: input.sandboxId,
        featureId: null,
        status: "queued",
        needsInput: false,
        prompt: input.prompt,
        branch: null,
        prUrl: null,
        createdAt: "now",
        finishedAt: null,
      };
    },
  });

  await callTool(ctx, ["tasks:write"], "nexux_create_task", {
    projectId: " p1 ",
    sandboxId: "s1",
    prompt: "  add login  ",
  });

  assert.deepEqual(received, {
    projectId: "p1",
    sandboxId: "s1",
    prompt: "add login",
    // Omitted optionals become explicit nulls, which is what createTask reads.
    featureId: null,
    followUpOf: null,
  });
});

test("a missing task is an answer rather than an error", async () => {
  const { ctx } = stubContext({ getTask: async () => null });
  const res = await callTool(ctx, ["tasks:read"], "nexux_task_status", {
    taskId: "gone",
  });
  assert.ok(res.ok, "a stale id is an ordinary outcome");
  assert.deepEqual(res.result, { found: false, taskId: "gone" });
});

test("the log tail is clamped rather than refused", async () => {
  let asked: number | undefined;
  const { ctx } = stubContext({
    getTaskLogs: async (_id, tail) => {
      asked = tail;
      return "log";
    },
  });
  await callTool(ctx, ["tasks:read"], "nexux_task_logs", {
    taskId: "t1",
    tailLines: 99999,
  });
  assert.equal(asked, 2000, "a client asking for everything gets the maximum");
});

test("a power action outside the allowed pair is refused", async () => {
  const { ctx, calls } = stubContext();
  const res = await callTool(ctx, ["sandboxes:write"], "nexux_sandbox_power", {
    sandboxId: "s1",
    action: "destroy",
  });
  assert.ok(!res.ok);
  assert.match(res.error, /pause, resume/);
  assert.deepEqual(calls, [], "destroy never reached the host");
});


// --- spec 24 piece 4: validation ---------------------------------------------

test("validating a stack is a read, not a write", async () => {
  // It provisions nothing: the static checks are pure and the observed half
  // reads a report off a sandbox that already exists. A write scope here would
  // mean a read-only token could not ask whether its own project holds
  // together, which is the question the tool exists for.
  const tool = toolByName("nexux_validate_stack");
  assert.equal(tool?.scope, "projects:read");
  assert.equal(toolByName("nexux_describe_stack")?.scope, "projects:read");

  const { ctx, calls } = stubContext({
    validateStack: async (projectId: string) => {
      calls.push(`validateStack:${projectId}`);
      return { ok: true, findings: [], observed: null };
    },
  });
  const res = await callTool(ctx, ["projects:read"], "nexux_validate_stack", {
    projectId: "p1",
  });
  assert.equal(res.ok, true);
  assert.ok(calls.includes("validateStack:p1"));
});

test("validation answers without a projectId are refused", async () => {
  const { ctx } = stubContext();
  for (const name of ["nexux_validate_stack", "nexux_describe_stack"]) {
    const res = await callTool(ctx, ["projects:read"], name, {});
    assert.equal(res.ok, false, `${name} accepted a missing projectId`);
  }
});

test("the validation tools are listed for a read-only token", async () => {
  // A tool that is refused but advertised invites a client to keep trying it;
  // one that is usable but hidden is never found.
  const names = toolsFor(["projects:read"]).map((t) => t.name);
  assert.ok(names.includes("nexux_validate_stack"));
  assert.ok(names.includes("nexux_describe_stack"));
});
