import assert from "node:assert/strict";
import test from "node:test";

import { parseStackSuggestions } from "./suggestions";

/** Wrap suggestions in the trailing ```json block the assistant emits. */
const withBlock = (prose: string, payload: unknown) =>
  `${prose}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;

test("a response with no json block is returned untouched", () => {
  const { message, suggestions } = parseStackSuggestions("just prose");
  assert.equal(message, "just prose");
  assert.deepEqual(suggestions, []);
});

test("the json block is stripped from the message it is attached to", () => {
  const { message, suggestions } = parseStackSuggestions(
    withBlock("Add a cache.", {
      suggestions: [{ nodeId: "n1", reason: "faster reads" }],
    })
  );
  assert.equal(message, "Add a cache.");
  assert.deepEqual(suggestions, [{ nodeId: "n1", reason: "faster reads" }]);
});

test("malformed json degrades to prose instead of throwing", () => {
  const response = "Add a cache.\n\n```json\n{not json}\n```";
  const { message, suggestions } = parseStackSuggestions(response);
  assert.equal(message, response);
  assert.deepEqual(suggestions, []);
});

test("a json block without a suggestions array is left in the message", () => {
  const response = withBlock("Note", { somethingElse: true });
  const { message, suggestions } = parseStackSuggestions(response);
  assert.equal(message, response);
  assert.deepEqual(suggestions, []);
});

test("only a block at the very end counts as suggestions", () => {
  // A mid-message fence is example code the assistant is showing the user.
  const response =
    "```json\n{\"suggestions\":[{\"nodeId\":\"n1\",\"reason\":\"r\"}]}\n```\n\nmore prose";
  const { message, suggestions } = parseStackSuggestions(response);
  assert.equal(message, response);
  assert.deepEqual(suggestions, []);
});

test("a suggestion with no reason is dropped", () => {
  const { suggestions } = parseStackSuggestions(
    withBlock("x", { suggestions: [{ nodeId: "n1" }] })
  );
  assert.deepEqual(suggestions, []);
});

test("a suggestion with no target is dropped", () => {
  // Without nodeId, repositoryId or createService there is nothing to apply to.
  const { suggestions } = parseStackSuggestions(
    withBlock("x", { suggestions: [{ reason: "orphan", patch: { image: "redis" } }] })
  );
  assert.deepEqual(suggestions, []);
});

test("valid suggestions survive alongside dropped ones", () => {
  const { suggestions } = parseStackSuggestions(
    withBlock("x", {
      suggestions: [
        { reason: "no target" },
        { nodeId: "n1", reason: "keep me" },
        { nodeId: "n2" },
      ],
    })
  );
  assert.deepEqual(suggestions, [{ nodeId: "n1", reason: "keep me" }]);
});

test("repositoryId alone is a valid target", () => {
  const { suggestions } = parseStackSuggestions(
    withBlock("x", { suggestions: [{ repositoryId: "r1", reason: "r" }] })
  );
  assert.deepEqual(suggestions, [{ repositoryId: "r1", reason: "r" }]);
});

test("createService needs a catalogKey or an image to be a target", () => {
  const named = parseStackSuggestions(
    withBlock("x", {
      suggestions: [{ createService: { name: "cache" }, reason: "r" }],
    })
  );
  assert.deepEqual(named.suggestions, []);

  const keyed = parseStackSuggestions(
    withBlock("x", {
      suggestions: [
        { createService: { catalogKey: "redis", name: "cache" }, reason: "r" },
      ],
    })
  );
  assert.deepEqual(keyed.suggestions, [
    { createService: { catalogKey: "redis", name: "cache" }, reason: "r" },
  ]);
});

test("string patch fields are kept, non-strings are dropped", () => {
  const { suggestions } = parseStackSuggestions(
    withBlock("x", {
      suggestions: [
        {
          nodeId: "n1",
          reason: "r",
          patch: {
            image: "redis:7",
            workdir: "apps/web",
            command: 42,
            dockerfile: null,
          },
        },
      ],
    })
  );
  assert.deepEqual(suggestions[0].patch, {
    image: "redis:7",
    workdir: "apps/web",
  });
});

test("runMode is restricted to docker and local", () => {
  const good = parseStackSuggestions(
    withBlock("x", {
      suggestions: [{ nodeId: "n1", reason: "r", patch: { runMode: "local" } }],
    })
  );
  assert.deepEqual(good.suggestions[0].patch, { runMode: "local" });

  const bad = parseStackSuggestions(
    withBlock("x", {
      suggestions: [{ nodeId: "n1", reason: "r", patch: { runMode: "wasm" } }],
    })
  );
  assert.equal(bad.suggestions[0].patch, undefined);
});

test("an unknown patch key is not carried through", () => {
  const { suggestions } = parseStackSuggestions(
    withBlock("x", {
      suggestions: [
        { nodeId: "n1", reason: "r", patch: { image: "redis", rmRf: "/" } },
      ],
    })
  );
  assert.deepEqual(suggestions[0].patch, { image: "redis" });
});

test("ports need numeric host and container to survive", () => {
  const { suggestions } = parseStackSuggestions(
    withBlock("x", {
      suggestions: [
        {
          nodeId: "n1",
          reason: "r",
          patch: {
            ports: [
              { host: 6379, container: 6379 },
              { host: "6379", container: 6379 },
              { host: 5432 },
            ],
          },
        },
      ],
    })
  );
  assert.deepEqual(suggestions[0].patch?.ports, [{ host: 6379, container: 6379 }]);
});

test("an env entry keeps its key and defaults a missing value to empty", () => {
  const { suggestions } = parseStackSuggestions(
    withBlock("x", {
      suggestions: [
        {
          nodeId: "n1",
          reason: "r",
          patch: {
            env: [
              { key: "A", value: "1" },
              { key: "B" },
              { value: "keyless" },
            ],
          },
        },
      ],
    })
  );
  assert.deepEqual(suggestions[0].patch?.env, [
    { key: "A", value: "1" },
    { key: "B", value: "" },
  ]);
});

test("volumes need string host and container to survive", () => {
  const { suggestions } = parseStackSuggestions(
    withBlock("x", {
      suggestions: [
        {
          nodeId: "n1",
          reason: "r",
          patch: {
            volumes: [
              { host: "pgdata", container: "/var/lib/postgresql/data" },
              { host: 1, container: "/data" },
            ],
          },
        },
      ],
    })
  );
  assert.deepEqual(suggestions[0].patch?.volumes, [
    { host: "pgdata", container: "/var/lib/postgresql/data" },
  ]);
});

test("a patch that sanitizes down to nothing is omitted entirely", () => {
  const { suggestions } = parseStackSuggestions(
    withBlock("x", {
      suggestions: [{ nodeId: "n1", reason: "r", patch: { image: 5 } }],
    })
  );
  assert.deepEqual(suggestions, [{ nodeId: "n1", reason: "r" }]);
});

test("an empty suggestions array still strips the block", () => {
  const { message, suggestions } = parseStackSuggestions(
    withBlock("Nothing to change.", { suggestions: [] })
  );
  assert.equal(message, "Nothing to change.");
  assert.deepEqual(suggestions, []);
});

// --- dependency edges ---

test("dependsOn carries the arrows a suggestion asked for", () => {
  const { suggestions } = parseStackSuggestions(
    withBlock("The api needs the database.", {
      suggestions: [
        { nodeId: "api", dependsOn: ["postgres", "redis"], reason: "it queries both" },
      ],
    }),
  );
  assert.deepEqual(suggestions[0].dependsOn, ["postgres", "redis"]);
});

test("names are trimmed and de-duplicated", () => {
  const { suggestions } = parseStackSuggestions(
    withBlock("x", {
      suggestions: [
        { nodeId: "api", dependsOn: [" postgres ", "postgres", "redis"], reason: "r" },
      ],
    }),
  );
  assert.deepEqual(suggestions[0].dependsOn, ["postgres", "redis"]);
});

test("a malformed entry loses that entry, not the suggestion", () => {
  // A model answering with an object or a null in the list should cost one
  // arrow, not the whole proposal the user was about to apply.
  const { suggestions } = parseStackSuggestions(
    withBlock("x", {
      suggestions: [
        { nodeId: "api", dependsOn: ["postgres", null, { name: "redis" }, ""], reason: "r" },
      ],
    }),
  );
  assert.equal(suggestions.length, 1);
  assert.deepEqual(suggestions[0].dependsOn, ["postgres"]);
});

test("dependsOn that is not an array is ignored", () => {
  const { suggestions } = parseStackSuggestions(
    withBlock("x", {
      suggestions: [{ nodeId: "api", dependsOn: "postgres", reason: "r" }],
    }),
  );
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].dependsOn, undefined);
});

test("dependsOn alone is not a target — an edge needs a node to hang off", () => {
  const { suggestions } = parseStackSuggestions(
    withBlock("x", {
      suggestions: [{ dependsOn: ["postgres"], reason: "r" }],
    }),
  );
  assert.deepEqual(suggestions, []);
});

test("a suggestion may carry edges and no patch", () => {
  // "The api needs the database" is a complete thought with nothing to change
  // about the node itself.
  const { suggestions } = parseStackSuggestions(
    withBlock("x", {
      suggestions: [{ nodeId: "api", dependsOn: ["postgres"], reason: "r" }],
    }),
  );
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].patch, undefined);
  assert.deepEqual(suggestions[0].dependsOn, ["postgres"]);
});
