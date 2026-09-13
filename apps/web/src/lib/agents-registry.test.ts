import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { resolveRegistryAgent, searchRegistryAgents } from "./agents-registry";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type CatalogAgent = {
  name: string;
  path: string;
  category?: string;
  description?: string;
  downloads?: number;
};

const CATALOG: CatalogAgent[] = [
  {
    name: "code-reviewer",
    path: "quality/code-reviewer.md",
    category: "quality",
    description: '"reviews code for defects"',
    downloads: 100,
  },
  {
    name: "db-expert",
    path: "data/db-expert.md",
    category: "data",
    description: "database tuning and migrations",
    downloads: 500,
  },
  {
    name: "sparse",
    path: "misc/sparse.md",
    // no category / description / downloads — the registry omits them freely
  },
];

/**
 * Stand in for the aitmpl catalog. Returns the call count so a test can assert
 * the 10-minute cache actually spared the 2MB download.
 */
function stubCatalog(agents: CatalogAgent[] = CATALOG) {
  const calls = { n: 0 };
  globalThis.fetch = (async () => {
    calls.n += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ agents }),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

// --- searchRegistryAgents ----------------------------------------------------
// Feeds the agent picker. The catalog is 400+ entries, so what the list shows
// first is most of what a user ever sees.

test("an empty query lists the catalog, most-downloaded first", () => {
  stubCatalog();
  return searchRegistryAgents("").then((agents) => {
    assert.deepEqual(
      agents.map((a) => a.name),
      ["db-expert", "code-reviewer", "sparse"],
    );
  });
});

test("a query matches the agent's name", async () => {
  stubCatalog();
  const agents = await searchRegistryAgents("code-reviewer");
  assert.deepEqual(
    agents.map((a) => a.name),
    ["code-reviewer"],
  );
});

test("a query also matches category and description", async () => {
  // Someone looking for "database" help does not know the agent is called
  // db-expert; matching only on name would return nothing for the obvious word.
  stubCatalog();
  assert.deepEqual(
    (await searchRegistryAgents("data")).map((a) => a.name),
    ["db-expert"],
  );
  assert.deepEqual(
    (await searchRegistryAgents("tuning")).map((a) => a.name),
    ["db-expert"],
  );
});

test("matching ignores case", async () => {
  stubCatalog();
  assert.deepEqual(
    (await searchRegistryAgents("CODE-REVIEWER")).map((a) => a.name),
    ["code-reviewer"],
  );
});

test("a query matching nothing returns an empty list, not everything", async () => {
  // Falling back to the whole catalog would read as "your search was ignored".
  stubCatalog();
  assert.deepEqual(await searchRegistryAgents("nosuchagent"), []);
});

test("surrounding whitespace in a query is ignored", async () => {
  stubCatalog();
  assert.deepEqual(
    (await searchRegistryAgents("  db-expert  ")).map((a) => a.name),
    ["db-expert"],
  );
});

test("the quotes the registry wraps descriptions in are stripped", async () => {
  // The catalog stores some descriptions pre-quoted; shown raw they render as
  // a stray pair of quotation marks in the picker.
  stubCatalog();
  const [agent] = await searchRegistryAgents("code-reviewer");
  assert.equal(agent.description, "reviews code for defects");
});

test("missing catalog fields fall back rather than surfacing undefined", async () => {
  // The picker sorts on downloads and groups on category; undefined in either
  // would sort unpredictably and render as an empty group.
  stubCatalog();
  const [agent] = await searchRegistryAgents("sparse");
  assert.equal(agent.category, "general");
  assert.equal(agent.description, "");
  assert.equal(agent.downloads, 0);
});

// The two tests below need a catalog that has not already been cached by the
// tests above. The cache is module-level with no reset hook, so they load their
// own instance of the module rather than reaching into its private state.
function freshModule(): Promise<typeof import("./agents-registry")> {
  return import(`./agents-registry?case=${freshModule.n++}`);
}
freshModule.n = 0;

test("the result list is capped at 30", async () => {
  // The catalog is 400+ entries and the response is rendered in full.
  const many = Array.from({ length: 50 }, (_, i) => ({
    name: `agent-${i}`,
    path: `x/agent-${i}.md`,
    downloads: i,
  }));
  stubCatalog(many);
  const agents = await (await freshModule()).searchRegistryAgents("agent");
  assert.equal(agents.length, 30);
  // Capped after sorting, so the cap keeps the most-downloaded, not the first 30.
  assert.equal(agents[0].name, "agent-49");
});

test("the catalog is fetched once and then cached", async () => {
  // It is a 2MB download; re-fetching it per keystroke is the thing the cache
  // exists to prevent.
  const calls = stubCatalog();
  const { searchRegistryAgents: search } = await freshModule();
  await search("a");
  await search("b");
  await search("c");
  assert.equal(calls.n, 1);
});

// --- resolveRegistryAgent ----------------------------------------------------
// The path comes from the catalog, which is a third-party file on GitHub Pages.
// It is interpolated into a raw.githubusercontent URL, so it decides what gets
// fetched.

test("a path containing .. is refused", async () => {
  // Not reachable from today's catalog, but the catalog is not ours: a path
  // that climbs out of the agents directory would fetch an arbitrary file from
  // the repo and store it as an agent's system prompt.
  stubCatalog();
  await assert.rejects(
    () => resolveRegistryAgent("../../../etc/passwd.md"),
    /Invalid agent path/,
  );
  await assert.rejects(
    () => resolveRegistryAgent("agents/../../secrets.md"),
    /Invalid agent path/,
  );
});

test("a path that is not a .md file is refused", async () => {
  stubCatalog();
  await assert.rejects(
    () => resolveRegistryAgent("quality/code-reviewer.txt"),
    /Invalid agent path/,
  );
});

test("a refused path is never fetched", async () => {
  // The guard has to run before the request, not after: a rejection that still
  // made the call has already hit whatever the path pointed at.
  const calls = stubCatalog();
  const before = calls.n;
  await assert.rejects(() => resolveRegistryAgent("../x.md"));
  assert.equal(calls.n, before);
});

test("frontmatter becomes the agent, body becomes the system prompt", async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () =>
      "---\nname: code-reviewer\ndescription: reviews code\nmodel: opus\ntools: Read, Grep\n---\n\nYou review code.\n",
  })) as unknown as typeof globalThis.fetch;

  const agent = await resolveRegistryAgent("quality/code-reviewer.md");
  assert.equal(agent.name, "code-reviewer");
  assert.equal(agent.description, "reviews code");
  assert.equal(agent.model, "opus");
  assert.equal(agent.tools, "Read, Grep");
  assert.equal(agent.systemPrompt, "You review code.");
  assert.match(agent.repoUrl, /quality\/code-reviewer\.md$/);
});

test("optional frontmatter fields resolve to null, not the string 'undefined'", async () => {
  // These are stored on the Agent row; "undefined" would be persisted verbatim
  // and later sent to the model as the agent's configured model name.
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => "---\nname: minimal\n---\n\nBody.\n",
  })) as unknown as typeof globalThis.fetch;

  const agent = await resolveRegistryAgent("x/minimal.md");
  assert.equal(agent.model, null);
  assert.equal(agent.tools, null);
  assert.equal(agent.description, "");
});

test("an agent file with no name is rejected", async () => {
  // Name is the identity the agent is stored under; an empty one produces an
  // unselectable row.
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => "---\ndescription: nameless\n---\n\nBody.\n",
  })) as unknown as typeof globalThis.fetch;

  await assert.rejects(
    () => resolveRegistryAgent("x/nameless.md"),
    /no name in its frontmatter/,
  );
});

test("a failed download surfaces its status", async () => {
  globalThis.fetch = (async () => ({
    ok: false,
    status: 404,
    text: async () => "",
  })) as unknown as typeof globalThis.fetch;

  await assert.rejects(
    () => resolveRegistryAgent("x/gone.md"),
    /Could not fetch the agent \(404\)/,
  );
});
