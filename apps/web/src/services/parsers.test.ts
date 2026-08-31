import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

// Env setup must stay above the service imports — these modules reach
// @nexux/db, whose client is built at module load.
import { testDbDir } from "./services.test-setup";
import { parseAgentConfig, parseSkillConfig } from "./agents-generator";
import { parseStackServices } from "./sandbox";
import { parseToolRequest } from "./stack-assistant-agent";

after(() => {
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

// --- parseAgentConfig / parseSkillConfig ------------------------------------
// Both parse an assistant reply into a config object; they behave identically,
// so each case runs against both.

const configParsers: [string, (r: string) => unknown][] = [
  ["parseAgentConfig", parseAgentConfig],
  ["parseSkillConfig", parseSkillConfig],
];

for (const [name, parse] of configParsers) {
  test(`${name} reads a fenced json block`, () => {
    assert.deepEqual(parse('```json\n{"name":"reviewer"}\n```'), {
      name: "reviewer",
    });
  });

  test(`${name} reads a bare object when there is no fence`, () => {
    assert.deepEqual(parse('Here it is: {"name":"reviewer"}'), {
      name: "reviewer",
    });
  });

  test(`${name} prefers the fenced block over surrounding braces`, () => {
    assert.deepEqual(parse('{"decoy":1}\n```json\n{"real":2}\n```'), {
      real: 2,
    });
  });

  test(`${name} returns null when there is no json at all`, () => {
    assert.equal(parse("no config here"), null);
    assert.equal(parse(""), null);
  });

  test(`${name} returns null on malformed json rather than throwing`, () => {
    assert.equal(parse("```json\n{broken\n```"), null);
  });

  test(`${name} keeps nested structure intact`, () => {
    const parsed = parse(
      '```json\n{"tools":["a","b"],"meta":{"model":"gpt"}}\n```'
    ) as { tools: string[]; meta: { model: string } };
    assert.deepEqual(parsed.tools, ["a", "b"]);
    assert.equal(parsed.meta.model, "gpt");
  });
}

// --- parseStackServices -----------------------------------------------------
// Narrows the Sandbox.stackServices JSON snapshot, which is untyped in the DB.

test("a well-formed service list is returned as-is", () => {
  const services = [
    { name: "db", image: "postgres:17", ports: [{ host: 5432, container: 5432 }] },
  ];
  assert.deepEqual(parseStackServices(services), services);
});

test("a non-array snapshot yields no services", () => {
  // The column is nullable Json — anything can be in there.
  assert.deepEqual(parseStackServices(null), []);
  assert.deepEqual(parseStackServices(undefined), []);
  assert.deepEqual(parseStackServices({}), []);
  assert.deepEqual(parseStackServices("postgres"), []);
});

test("an empty list stays empty", () => {
  assert.deepEqual(parseStackServices([]), []);
});

test("entries without a string name and image are dropped", () => {
  const parsed = parseStackServices([
    { name: "keep", image: "redis:7" },
    { name: "no-image" },
    { image: "no-name" },
    { name: 1, image: "numeric-name" },
    null,
    "a string",
  ]);
  assert.deepEqual(parsed, [{ name: "keep", image: "redis:7" }]);
});

test("a service missing its ports still survives", () => {
  // ports is not part of the guard; the UI treats it as optional.
  assert.deepEqual(parseStackServices([{ name: "db", image: "postgres" }]), [
    { name: "db", image: "postgres" },
  ]);
});

// --- parseToolRequest -------------------------------------------------------
// A reply that IS a tool call, rather than prose for the user.

test("a known tool call is recognized", () => {
  assert.deepEqual(
    parseToolRequest('```json\n{"tool":"get_stack_context","args":{}}\n```'),
    { tool: "get_stack_context", args: {} }
  );
});

test("tool arguments are carried through", () => {
  const parsed = parseToolRequest(
    '```json\n{"tool":"read_repo_file","args":{"path":"src/app.ts"}}\n```'
  );
  assert.deepEqual(parsed, {
    tool: "read_repo_file",
    args: { path: "src/app.ts" },
  });
});

test("every registered tool is accepted", () => {
  for (const tool of ["get_stack_context", "read_repo_file", "search_project"]) {
    assert.equal(
      parseToolRequest(`\`\`\`json\n{"tool":"${tool}"}\n\`\`\``)?.tool,
      tool,
      tool
    );
  }
});

test("an unregistered tool is refused", () => {
  // Guards against the model inventing a tool that would then be dispatched.
  assert.equal(
    parseToolRequest('```json\n{"tool":"rm_rf","args":{"path":"/"}}\n```'),
    null
  );
});

test("missing args default to an empty object", () => {
  assert.deepEqual(parseToolRequest('```json\n{"tool":"search_project"}\n```'), {
    tool: "search_project",
    args: {},
  });
});

test("non-object args default to an empty object", () => {
  assert.deepEqual(
    parseToolRequest('```json\n{"tool":"search_project","args":"oops"}\n```'),
    { tool: "search_project", args: {} }
  );
});

test("prose with no fenced block is not a tool call", () => {
  assert.equal(parseToolRequest("Let me look at your stack."), null);
});

test("a non-string tool name is refused", () => {
  assert.equal(parseToolRequest('```json\n{"tool":42}\n```'), null);
  assert.equal(parseToolRequest('```json\n{"args":{}}\n```'), null);
});

test("malformed json is not a tool call", () => {
  assert.equal(parseToolRequest("```json\n{broken\n```"), null);
});
