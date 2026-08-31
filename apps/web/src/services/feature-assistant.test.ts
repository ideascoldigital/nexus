import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

// Env setup must stay above the service imports — the module graph reaches
// @nexux/db, whose client is built at module load.
import { testDbDir } from "./services.test-setup";
import { buildContext, runFeatureAssistantTurn } from "./feature-assistant";
import type { AgentDeps, ContextHit } from "./agent-deps";

after(() => {
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

function repoHit(over: Partial<ContextHit> = {}): ContextHit {
  return {
    filePath: "src/app.ts",
    snippet: "export function app() {}",
    sourceType: "file",
    ...over,
  };
}

type Recorded = {
  prompts: string[];
  histories: unknown[];
  defined: { name: string; workspaceId?: string }[];
  searches: { projectId: string; query: string; k: number }[];
};

function deps(opts: {
  reply?: string;
  repos?: ContextHit[];
  projectData?: ContextHit[];
  searchThrows?: boolean;
  workspaceId?: string;
} = {}): { deps: AgentDeps; rec: Recorded } {
  const rec: Recorded = {
    prompts: [],
    histories: [],
    defined: [],
    searches: [],
  };
  return {
    rec,
    deps: {
      defineAgent: async (spec) => {
        rec.defined.push({ name: spec.name, workspaceId: spec.workspaceId });
        return {
          run: async (input, runOpts) => {
            rec.prompts.push(input);
            rec.histories.push(runOpts?.history);
            return { message: opts.reply ?? "a plain reply" };
          },
        };
      },
      search: async (projectId, query, k) => {
        rec.searches.push({ projectId, query, k });
        if (opts.searchThrows) throw new Error("Ollama down");
        return {
          repos: opts.repos ?? [],
          projectData: opts.projectData ?? [],
        };
      },
      workspaceIdOfProject: async () => opts.workspaceId,
    },
  };
}

// --- buildContext -----------------------------------------------------------

test("no index hits means no context block", async () => {
  const { deps: d } = deps();
  assert.equal(await buildContext("p1", "query", d), null);
});

test("the index is queried with the user's own message", async () => {
  const { deps: d, rec } = deps({ repos: [repoHit()] });
  await buildContext("p1", "how does auth work", d);
  assert.deepEqual(rec.searches, [
    { projectId: "p1", query: "how does auth work", k: 6 },
  ]);
});

test("repo hits are rendered with their path", async () => {
  const { deps: d } = deps({ repos: [repoHit({ filePath: "src/auth.ts" })] });
  const context = await buildContext("p1", "q", d);
  assert.match(context ?? "", /Repository:/);
  assert.match(context ?? "", /`src\/auth\.ts`/);
});

test("line numbers are cited when the hit has them", async () => {
  const { deps: d } = deps({
    repos: [repoHit({ startLine: 12, endLine: 40 })],
  });
  assert.match((await buildContext("p1", "q", d)) ?? "", /\(lines 12-40\)/);
});

test("a hit without line numbers omits the range", async () => {
  const { deps: d } = deps({ repos: [repoHit()] });
  const context = await buildContext("p1", "q", d);
  assert.doesNotMatch(context ?? "", /lines/);
});

test("project knowledge is a separate labelled section", async () => {
  const { deps: d } = deps({
    projectData: [repoHit({ sourceType: "feature", heading: "Login" })],
  });
  const context = await buildContext("p1", "q", d);
  assert.match(context ?? "", /Project knowledge:/);
  assert.match(context ?? "", /\[feature\] Login/);
});

test("project knowledge falls back to the file path with no heading", async () => {
  const { deps: d } = deps({
    projectData: [
      repoHit({ sourceType: "document_section", heading: undefined }),
    ],
  });
  assert.match((await buildContext("p1", "q", d)) ?? "", /src\/app\.ts/);
});

test("snippets are collapsed to one line and clipped", async () => {
  // Raw chunks carry newlines and runs of whitespace that would wreck the
  // prompt's structure, and a long one would crowd out other hits.
  const { deps: d } = deps({
    repos: [repoHit({ snippet: `line one\n\n   line two ${"x".repeat(500)}` })],
  });
  const context = await buildContext("p1", "q", d);
  assert.equal(context?.includes("\n\n"), false);
  const rendered = (context ?? "").split("\n").find((l) => l.includes("line one"));
  assert.ok(rendered);
  assert.ok(rendered.length < 420, `line was ${rendered.length} chars`);
});

test("at most five repo hits and three knowledge hits are included", async () => {
  const { deps: d } = deps({
    repos: Array.from({ length: 9 }, (_, i) =>
      repoHit({ filePath: `src/f${i}.ts` })
    ),
    projectData: Array.from({ length: 9 }, (_, i) =>
      repoHit({ heading: `H${i}`, sourceType: "feature" })
    ),
  });
  const context = (await buildContext("p1", "q", d)) ?? "";
  const bullets = context.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(bullets.length, 8);
});

test("a failing index leaves the assistant unanchored rather than erroring", async () => {
  // Ollama being down must not take the whole feature assistant with it.
  const { deps: d } = deps({ searchThrows: true });
  assert.equal(await buildContext("p1", "q", d), null);
});

// --- runFeatureAssistantTurn ------------------------------------------------

test("the agent is defined for the project's workspace", async () => {
  const { deps: d, rec } = deps({ workspaceId: "ws-7" });
  await runFeatureAssistantTurn("p1", "hello", [], d);
  assert.deepEqual(rec.defined, [
    { name: "feature-assistant", workspaceId: "ws-7" },
  ]);
});

test("context is prepended to the user's message when the index has hits", async () => {
  const { deps: d, rec } = deps({ repos: [repoHit({ filePath: "src/a.ts" })] });
  const turn = await runFeatureAssistantTurn("p1", "add login", [], d);
  assert.equal(turn.usedContext, true);
  assert.match(rec.prompts[0], /^PROJECT CONTEXT/);
  assert.match(rec.prompts[0], /src\/a\.ts/);
  assert.match(rec.prompts[0], /USER:\nadd login/);
});

test("with no hits the user's message is sent verbatim", async () => {
  const { deps: d, rec } = deps();
  const turn = await runFeatureAssistantTurn("p1", "add login", [], d);
  assert.equal(turn.usedContext, false);
  assert.equal(rec.prompts[0], "add login");
});

test("conversation history is handed to the agent", async () => {
  const history = [{ role: "user" as const, content: "earlier" }];
  const { deps: d, rec } = deps();
  await runFeatureAssistantTurn("p1", "next", history, d);
  assert.deepEqual(rec.histories[0], history);
});

test("a plain reply yields no feature suggestion", async () => {
  const { deps: d } = deps({ reply: "Could you clarify the scope?" });
  const turn = await runFeatureAssistantTurn("p1", "q", [], d);
  assert.equal(turn.feature, null);
  assert.equal(turn.message, "Could you clarify the scope?");
});

test("a feature block is extracted and hidden from the visible reply", async () => {
  const { deps: d } = deps({
    reply:
      'Here is the feature.\n```json\n{"feature":{"title":"Add login","description":"Build it"}}\n```',
  });
  const turn = await runFeatureAssistantTurn("p1", "q", [], d);
  assert.deepEqual(turn.feature, {
    title: "Add login",
    description: "Build it",
  });
  assert.equal(turn.message, "Here is the feature.");
});

test("a feature with no description defaults to empty", async () => {
  const { deps: d } = deps({
    reply: '```json\n{"feature":{"title":"Add login"}}\n```',
  });
  const turn = await runFeatureAssistantTurn("p1", "q", [], d);
  assert.deepEqual(turn.feature, { title: "Add login", description: "" });
});

test("an overlong title is capped", async () => {
  const { deps: d } = deps({
    reply: `\`\`\`json\n{"feature":{"title":"${"t".repeat(400)}"}}\n\`\`\``,
  });
  const turn = await runFeatureAssistantTurn("p1", "q", [], d);
  assert.equal(turn.feature?.title.length, 200);
});

test("a block with no title is not a suggestion", async () => {
  const { deps: d } = deps({
    reply: 'text\n```json\n{"feature":{"description":"orphan"}}\n```',
  });
  const turn = await runFeatureAssistantTurn("p1", "q", [], d);
  assert.equal(turn.feature, null);
});

test("a malformed block is shown verbatim rather than losing the reply", async () => {
  const reply = "Here you go\n```json\n{broken\n```";
  const { deps: d } = deps({ reply });
  const turn = await runFeatureAssistantTurn("p1", "q", [], d);
  assert.equal(turn.feature, null);
  assert.equal(turn.message, reply);
});

test("an empty agent reply does not crash the turn", async () => {
  const { deps: d } = deps({ reply: "" });
  const turn = await runFeatureAssistantTurn("p1", "q", [], d);
  assert.equal(turn.message, "");
  assert.equal(turn.feature, null);
});
