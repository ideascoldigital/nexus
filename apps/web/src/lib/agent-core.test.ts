import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_POLICY,
  HEADLESS_RULES,
  NEEDS_INPUT_MARKER,
  REMOTE_SHOT_DIR,
  buildAgentPrompt,
  buildDevPrompt,
  buildFeaturePrompt,
  buildFollowUpPrompt,
  buildPlanFollowUpPrompt,
  buildPlanPrompt,
  deliverySweepCommand,
  detectNeedsInput,
  extractPrUrls,
  gitlabAppendMrSectionCommand,
  gitlabUploadShotsCommand,
  mrRefFromUrl,
  parseDeliverySweep,
  parseGitRemote,
  parseShotUploads,
  prUrlMatchesRepo,
  renderAgentFile,
  renderLivePreviewScript,
  renderSkillFile,
  sandboxReachable,
  sandboxTarget,
  withFeaturePrOverride,
  type AgentPolicy,
} from "./agent-core";

// Characterization tests for the delegation layer a second brain (OpenCode,
// spec 16) plugs into: prompts, policy gates and sandbox addressing must not
// drift when the dispatcher lands.

const policy = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  ...DEFAULT_POLICY,
  ...over,
});

// --- sandboxTarget / sandboxReachable ---------------------------------------

test("local sandbox targets its docker container", () => {
  const t = sandboxTarget(
    { provider: "local", publicIp: null, instanceId: "ctr-1" },
    "/opt/nexus/app",
  );
  assert.equal(t.container, "ctr-1");
  assert.equal(t.host, undefined);
  assert.equal(t.cwd, "/opt/nexus/app");
});

test("local sandbox without container throws", () => {
  assert.throws(
    () =>
      sandboxTarget(
        { provider: "local", publicIp: null, instanceId: null },
        "/x",
      ),
    /no container/,
  );
});

test("cloud sandbox without public IP throws", () => {
  assert.throws(
    () =>
      sandboxTarget({ provider: "civo", publicIp: null, instanceId: "i" }, "/x"),
    /no public IP/,
  );
});

test("reachable = running + address (cloud) or container (local)", () => {
  const base = { provider: "civo", publicIp: "1.2.3.4", instanceId: null };
  assert.ok(sandboxReachable({ ...base, status: "running" }));
  assert.ok(!sandboxReachable({ ...base, status: "provisioning" }));
  assert.ok(
    !sandboxReachable({ ...base, status: "running", publicIp: null }),
  );
  assert.ok(
    sandboxReachable({
      provider: "local",
      status: "running",
      publicIp: null,
      instanceId: "ctr",
    }),
  );
});

// --- buildFeaturePrompt -----------------------------------------------------

test("feature prompt includes only non-empty sections", () => {
  const p = buildFeaturePrompt({
    title: "Dark mode",
    description: "  ",
    aiRefinement: null,
  });
  assert.equal(p, "Implement the following feature: Dark mode");
});

test("feature prompt carries description, refinement and phase goal", () => {
  const p = buildFeaturePrompt({
    title: "T",
    description: "D",
    aiRefinement: "R",
    devPhase: { name: "MVP", goal: "ship it" },
  });
  assert.ok(p.includes("Description:\nD"));
  assert.ok(p.includes("Additional context:\nR"));
  assert.ok(p.includes("Development phase: MVP"));
  assert.ok(p.includes("Phase goal: ship it"));
});

// --- buildAgentPrompt policy gates ------------------------------------------

test("runTests=false drops the test step", () => {
  const on = buildAgentPrompt({
    task: "t",
    branch: "b",
    policy: policy(),
    skills: [],
    runCommand: null,
  });
  const off = buildAgentPrompt({
    task: "t",
    branch: "b",
    policy: policy({ runTests: false }),
    skills: [],
    runCommand: null,
  });
  assert.ok(on.includes("Run the project's test suite"));
  assert.ok(!off.includes("Run the project's test suite"));
});

test("screenshots need BOTH captureScreenshots and installAgentBrowser", () => {
  const both = buildAgentPrompt({
    task: "t",
    branch: "b",
    policy: policy(),
    skills: [],
    runCommand: null,
  });
  const noBrowser = buildAgentPrompt({
    task: "t",
    branch: "b",
    policy: policy({ installAgentBrowser: false }),
    skills: [],
    runCommand: null,
  });
  assert.ok(both.includes(REMOTE_SHOT_DIR));
  assert.ok(!noBrowser.includes("Capture screenshots"));
});

test("agent is told to commit but never push or open the PR", () => {
  const p = buildAgentPrompt({
    task: "t",
    branch: "feat/x",
    policy: policy(),
    skills: [],
    runCommand: null,
  });
  assert.ok(p.includes("Commit your work on branch `feat/x`"));
  assert.ok(p.includes("Do NOT push and do NOT open a pull request"));
});

test("skills, search context and standing instructions are injected", () => {
  const p = buildAgentPrompt({
    task: "t",
    branch: "b",
    policy: policy({ agentInstructions: "always use pnpm" }),
    skills: [{ name: "dataviz", description: "charts" }],
    runCommand: "pnpm dev",
    searchContext: "hit: src/app.ts",
  });
  assert.ok(p.includes("- **dataviz**: charts"));
  assert.ok(p.includes("# Project context\nhit: src/app.ts"));
  assert.ok(p.includes("# Project instructions\nalways use pnpm"));
  assert.ok(p.includes("`pnpm dev`"));
});

test("selected subagents are listed (slugged) in the prompt", () => {
  const p = buildAgentPrompt({
    task: "t",
    branch: "b",
    policy: policy(),
    skills: [],
    agents: [{ name: "DB Migrator", description: "writes migrations" }],
    runCommand: null,
  });
  assert.ok(p.includes("# Subagents available"));
  assert.ok(p.includes("- **db-migrator**: writes migrations"));
});

test("no subagents section when none are selected", () => {
  const p = buildAgentPrompt({
    task: "t",
    branch: "b",
    policy: policy(),
    skills: [],
    runCommand: null,
  });
  assert.ok(!p.includes("# Subagents available"));
});

// --- renderAgentFile / renderSkillFile (native ~/.claude materialization) ---

test("renderAgentFile emits slugged frontmatter + system prompt body", () => {
  const md = renderAgentFile({
    name: "DB Migrator",
    description: 'writes "safe" migrations',
    systemPrompt: "You migrate databases.",
    model: "opus",
  });
  assert.ok(md.startsWith("---\n"));
  assert.ok(md.includes("name: db-migrator"));
  // Description is a double-quoted YAML scalar with the inner quote escaped.
  assert.ok(md.includes('description: "writes \\"safe\\" migrations"'));
  assert.ok(md.includes('model: "opus"'));
  assert.ok(md.trimEnd().endsWith("You migrate databases."));
});

test("renderAgentFile omits model when absent, falls back to name for description", () => {
  const md = renderAgentFile({
    name: "helper",
    description: null,
    systemPrompt: "hi",
  });
  assert.ok(!md.includes("model:"));
  assert.ok(md.includes('description: "helper"'));
});

test("renderSkillFile emits SKILL.md frontmatter + body", () => {
  const md = renderSkillFile({
    name: "Data Viz",
    description: "charts",
    body: "# How to chart\nUse bars.",
  });
  assert.ok(md.includes("name: data-viz"));
  assert.ok(md.includes('description: "charts"'));
  assert.ok(md.includes("# How to chart\nUse bars."));
});

test("dev prompt injects semantic project context when present", () => {
  const withCtx = buildDevPrompt({
    task: "add a chart",
    workDir: "/opt/nexus/app",
    resumed: false,
    instructions: null,
    searchContext: "hit: src/chart.ts",
  });
  assert.ok(withCtx.includes("# Project context\n\nhit: src/chart.ts"));
  const without = buildDevPrompt({
    task: "add a chart",
    workDir: "/opt/nexus/app",
    resumed: false,
    instructions: null,
  });
  assert.ok(!without.includes("# Project context"));
});

// --- buildFollowUpPrompt ----------------------------------------------------

test("resumed follow-up keeps context; cold one re-reads the diff", () => {
  const base = { task: "t", branch: "b", policy: policy() };
  const resumed = buildFollowUpPrompt({ ...base, resumed: true });
  const cold = buildFollowUpPrompt({ ...base, resumed: false });
  assert.ok(resumed.includes("continues your earlier work"));
  assert.ok(cold.includes("git diff origin/HEAD...HEAD"));
});

// --- buildDevPrompt ---------------------------------------------------------

test("dev prompt forbids commits and adapts to session resume state", () => {
  const fresh = buildDevPrompt({
    task: "fix bug",
    workDir: "/opt/nexus/app",
    resumed: false,
    instructions: null,
  });
  const resumed = buildDevPrompt({
    task: "fix bug",
    workDir: "/opt/nexus/app",
    resumed: true,
    instructions: "keep Spanish",
  });
  assert.ok(fresh.includes("Do NOT commit, push, or open pull requests"));
  assert.ok(fresh.includes("start of a new session"));
  assert.ok(resumed.includes("continues your previous session"));
  assert.ok(resumed.includes("# Standing instructions\n\nkeep Spanish"));
  assert.ok(!fresh.includes("# Standing instructions"));
});

// --- detectNeedsInput -------------------------------------------------------

test("NEEDS_INPUT marker anywhere flags the reply", () => {
  assert.ok(
    detectNeedsInput(`did stuff\n${NEEDS_INPUT_MARKER} which DB?\n`),
  );
});

test("a trailing question also counts", () => {
  assert.ok(detectNeedsInput("All done.\nShould I also update the docs?"));
});

test("plain completion does not", () => {
  assert.ok(!detectNeedsInput("All done. Deployed."));
  assert.ok(!detectNeedsInput(null));
  assert.ok(!detectNeedsInput(""));
});

// --- withFeaturePrOverride ---------------------------------------------------
// A feature may pin whether its sandbox run opens a PR. null means "inherit",
// so the project's SandboxConfig.createPr keeps winning and the feature moves
// with it — only an explicit boolean overrides.

const PR_OFF: AgentPolicy = { ...DEFAULT_POLICY, createPr: false };

test("a null override leaves the project policy untouched", () => {
  assert.equal(withFeaturePrOverride(DEFAULT_POLICY, null), DEFAULT_POLICY);
  assert.equal(withFeaturePrOverride(PR_OFF, null).createPr, false);
});

test("an undefined override (feature-less run) inherits too", () => {
  assert.equal(withFeaturePrOverride(PR_OFF, undefined).createPr, false);
});

test("a feature can force a PR the project default would skip", () => {
  assert.equal(withFeaturePrOverride(PR_OFF, true).createPr, true);
});

test("a feature can opt out of a PR the project default would open", () => {
  assert.equal(withFeaturePrOverride(DEFAULT_POLICY, false).createPr, false);
});

test("the override only touches createPr", () => {
  const out = withFeaturePrOverride(DEFAULT_POLICY, false);
  assert.deepEqual({ ...out, createPr: true }, { ...DEFAULT_POLICY, createPr: true });
});

test("overriding does not mutate the policy it was given", () => {
  const base: AgentPolicy = { ...DEFAULT_POLICY, createPr: true };
  withFeaturePrOverride(base, false);
  assert.equal(base.createPr, true);
});

// --- commit type follows the branch ------------------------------------------
// The branch now carries the conventional type (fix/…, feat/…). A commit that
// picks its own is a disagreement a reviewer has to stop and resolve.

test("the commit is told to match the branch's type", () => {
  const p = buildAgentPrompt({
    task: "t",
    branch: "fix/broken-redirect-ab12x",
    policy: policy(),
    skills: [],
    runCommand: null,
  });
  assert.ok(p.includes("`fix: <imperative summary>`"), "names the branch type");
  assert.ok(!p.includes("`feat: <imperative summary>`"));
});

test("a feat branch asks for a feat commit", () => {
  const p = buildAgentPrompt({
    task: "t",
    branch: "feat/add-login-zz999",
    policy: policy(),
    skills: [],
    runCommand: null,
  });
  assert.ok(p.includes("`feat: <imperative summary>`"));
});

test("the agent is still told not to push or open the PR", () => {
  // Nexus owns those steps; an agent that pushes races the pipeline.
  const p = buildAgentPrompt({
    task: "t",
    branch: "chore/bump-deps-aa111",
    policy: policy(),
    skills: [],
    runCommand: null,
  });
  assert.ok(p.includes("Do NOT push and do NOT open a pull request"));
});

// --- delivery sweep ----------------------------------------------------------
// Born from a real incident: a frontend feature dispatched at the backend
// repo's workDir was implemented (correctly) in the sibling checkout, counted
// as "no commits", and never delivered — the MR only existed after a manual
// rescue. The sweep is what finds work the workDir count can't see.

test("deliverySweepCommand scans siblings for the branch and strips quotes", () => {
  const cmd = deliverySweepCommand("feat/thing-ab'c\\12");
  assert.ok(cmd.includes("refs/heads/feat/thing-abc12"), "quotes stripped");
  assert.ok(cmd.includes("../*/"), "scans the workspace parent");
  assert.ok(cmd.includes("--not --remotes"), "counts undelivered commits");
  assert.ok(cmd.endsWith("true"), "a no-hit sweep must not fail the run");
});

test("parseDeliverySweep keeps only checkouts with undelivered commits", () => {
  const out = [
    "some unrelated noise",
    "NEXUX_SWEEP|/opt/nexus/acme-ui|1|https://oauth2:tok@git.example.com/acme/group/acme-ui.git",
    "NEXUX_SWEEP|/opt/nexus/acme-api|0|https://git.example.com/acme/group/acme-api.git",
    "NEXUX_SWEEP|/opt/nexus/broken||https://x.example/repo.git",
    "NEXUX_SWEEP|/opt/nexus/no-origin|3|",
  ].join("\n");
  const targets = parseDeliverySweep(out);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].dir, "/opt/nexus/acme-ui");
  assert.equal(targets[0].unpushed, 1);
  assert.match(targets[0].originUrl, /acme-ui\.git$/);
});

test("prUrlMatchesRepo pairs a PR/MR with its repo across URL styles", () => {
  // GitLab MR vs https origin with embedded credentials.
  assert.equal(
    prUrlMatchesRepo(
      "https://git.example.com/acme/group/acme-ui/-/merge_requests/280",
      "https://oauth2:tok@git.example.com/acme/group/acme-ui.git",
    ),
    true,
  );
  // GitHub PR vs scp-style origin.
  assert.equal(
    prUrlMatchesRepo(
      "https://github.com/acme/app/pull/12",
      "git@github.com:acme/app.git",
    ),
    true,
  );
  // Sibling repo of the same feature must not claim the PR…
  assert.equal(
    prUrlMatchesRepo(
      "https://git.example.com/acme/group/acme-ui/-/merge_requests/280",
      "https://git.example.com/acme/group/acme-api.git",
    ),
    false,
  );
  // …and neither must a repo whose name is a prefix of the PR's repo.
  assert.equal(
    prUrlMatchesRepo(
      "https://github.com/acme/app-ui/pull/3",
      "git@github.com:acme/app.git",
    ),
    false,
  );
  assert.equal(prUrlMatchesRepo("", "git@github.com:acme/app.git"), false);
});

// --- GitLab screenshot uploads ------------------------------------------------
// MR descriptions must carry the screenshots inline (<img>), and GitLab's way
// is the project uploads API — the assets-branch trick is GitHub-only.

test("parseGitRemote splits host and path, preserving case", () => {
  assert.deepEqual(
    parseGitRemote("https://oauth2:tok@git.example.com/acme/Group/acme-ui.git"),
    { host: "git.example.com", path: "acme/Group/acme-ui" },
  );
  assert.deepEqual(parseGitRemote("git@github.com:Acme/app.git"), {
    host: "github.com",
    path: "Acme/app",
  });
  assert.equal(parseGitRemote("not-a-url"), null);
  assert.equal(parseGitRemote(""), null);
});

test("gitlabUploadShotsCommand targets the encoded project and guards the token", () => {
  const cmd = gitlabUploadShotsCommand({
    host: "git.example.com",
    path: "acme/group/acme-ui",
  });
  assert.ok(cmd.includes("projects/acme%2Fgroup%2Facme-ui/uploads"));
  assert.ok(cmd.includes("PRIVATE-TOKEN"), "authenticates with GITLAB_TOKEN");
  assert.ok(cmd.includes(REMOTE_SHOT_DIR), "reads the collected screenshots");
  assert.ok(
    cmd.includes('[ -n "${GITLAB_TOKEN:-}" ]'),
    "a sandbox without the token reports instead of curl-erroring per file",
  );
  assert.ok(cmd.endsWith("true"), "an empty shot dir must not fail the run");
});

test("parseShotUploads builds absolute URLs and skips failures", () => {
  const repo = { host: "git.example.com", path: "acme/group/acme-ui" };
  const out = [
    // Modern GitLab: full_path resolves instance-wide.
    'NEXUX_SHOT|home.png|{"url":"/uploads/abc/home.png","full_path":"/-/project/42/uploads/abc/home.png"}',
    // Older GitLab: only the project-relative url.
    'NEXUX_SHOT|form.png|{"url":"/uploads/def/form.png"}',
    "NEXUX_SHOT_ERR|broken.png upload failed",
    "NEXUX_SHOT|weird.png|<html>proxy error</html>",
  ].join("\n");
  assert.deepEqual(parseShotUploads(out, repo), [
    {
      name: "home.png",
      url: "https://git.example.com/-/project/42/uploads/abc/home.png",
    },
    {
      name: "form.png",
      url: "https://git.example.com/acme/group/acme-ui/uploads/def/form.png",
    },
  ]);
});

test("extractPrUrls mines PR/MR links out of a chat reply", () => {
  const reply = [
    "Done. Opened https://github.com/acme-io/acme-templates/pull/79.",
    "It supersedes https://github.com/acme-io/acme-templates/pull/79 (same one).",
    "The API half: https://git.example.com/acme/group/acme-api/-/merge_requests/9",
    "Compare view: https://github.com/acme/app/compare/main...feat — not a PR.",
  ].join("\n");
  assert.deepEqual(extractPrUrls(reply), [
    "https://github.com/acme-io/acme-templates/pull/79",
    "https://git.example.com/acme/group/acme-api/-/merge_requests/9",
  ]);
  assert.deepEqual(extractPrUrls(null), []);
  assert.deepEqual(extractPrUrls("no links here"), []);
});

// --- buildPlanPrompt / plan feed-forward --------------------------------------

test("plan prompt is explicitly read-only and demands the plan as the reply", () => {
  const p = buildPlanPrompt({
    feature: { title: "Dark mode", description: "toggle", aiRefinement: null },
    workDir: "/opt/nexus/acme-api",
    searchContext: "hit: src/theme.ts",
  });
  assert.ok(p.includes("Do NOT implement it"));
  assert.ok(p.includes("read-only plan mode"));
  assert.ok(p.includes("Implement the following feature: Dark mode"));
  assert.ok(p.includes("/opt/nexus/acme-api"));
  assert.ok(p.includes("Sibling checkouts"), "multi-repo workspaces are the norm");
  assert.ok(p.includes("# Project context\nhit: src/theme.ts"));
  assert.ok(p.includes("## Affected repos & files"));
  assert.ok(
    p.includes(HEADLESS_RULES),
    "a plan run is a single headless pass like any other",
  );
});

test("a saved plan rides into the implementing prompt", () => {
  const withPlan = buildFeaturePrompt({
    title: "Dark mode",
    description: null,
    aiRefinement: null,
    planContent: "## Summary\nFlip the tokens.",
  });
  assert.ok(withPlan.includes("Implementation plan"));
  assert.ok(withPlan.includes("Flip the tokens."));
  assert.ok(withPlan.includes("when you deviate, say where and why"));
  const without = buildFeaturePrompt({
    title: "Dark mode",
    description: null,
    aiRefinement: null,
  });
  assert.ok(!without.includes("Implementation plan"));
});

test("plan follow-up prompt: resumed relies on memory, cold carries the plan", () => {
  const resumed = buildPlanFollowUpPrompt({
    followUp: "split step 3 into two",
    resumed: true,
    previousPlan: "## Summary\nold plan",
    workDir: "/opt/nexus/app",
  });
  assert.ok(resumed.includes("split step 3 into two"));
  assert.ok(resumed.includes("are in your memory"));
  assert.ok(!resumed.includes("## Previous plan"), "no need to repeat it");
  assert.ok(resumed.includes("read-only plan mode"));
  assert.ok(resumed.includes("COMPLETE revised plan"), "full document, not a diff");

  const cold = buildPlanFollowUpPrompt({
    followUp: "split step 3 into two",
    resumed: false,
    previousPlan: "## Summary\nold plan",
    workDir: "/opt/nexus/app",
  });
  assert.ok(cold.includes("## Previous plan\n## Summary\nold plan"));
  assert.ok(cold.includes("Re-read the relevant code"));
});

test("mrRefFromUrl decomposes GitLab MR urls and rejects the rest", () => {
  assert.deepEqual(
    mrRefFromUrl("https://git.example.com/acme/group/acme-ui/-/merge_requests/302"),
    { host: "git.example.com", path: "acme/group/acme-ui", iid: "302" },
  );
  assert.equal(mrRefFromUrl("https://github.com/acme/app/pull/12"), null);
  assert.equal(mrRefFromUrl("not a url"), null);
});

test("the MR-append command carries args as argv, never inlined content", () => {
  const cmd = gitlabAppendMrSectionCommand(
    { host: "git.example.com", path: "acme/group/acme-ui", iid: "302" },
    "/tmp/section.md",
  );
  assert.ok(cmd.includes("PRIVATE-TOKEN"), "authenticates with GITLAB_TOKEN");
  assert.ok(
    cmd.includes("python3 /tmp/nexux-mr-append.py 'git.example.com' 'acme/group/acme-ui' '302' '/tmp/section.md'"),
    "section content stays in its file — only paths ride the shell",
  );
  assert.ok(cmd.includes("not in desc"), "idempotent re-append guard");
});

test("the live-preview script tunnels the configured port with a localhost Host", () => {
  const script = renderLivePreviewScript({
    cwd: "/opt/nexus/acme-ui",
    runCommand: "npm start",
    port: 3010,
  });
  assert.ok(
    script.includes('--url "http://localhost:3010"'),
    "the tunnel targets the configured port, not a default",
  );
  assert.ok(
    script.includes('--http-host-header "localhost:3010"'),
    "dev servers with host checks (webpack's Invalid Host header) must see localhost",
  );
  assert.ok(
    script.includes('curl -fs -o /dev/null "http://localhost:3010"'),
    "readiness waits on the same port the tunnel exposes",
  );
  assert.ok(script.includes("cd /opt/nexus/acme-ui"), "runs in the checkout");
  assert.ok(script.includes("exec npm start"), "run command via the heredoc script");
  assert.ok(!script.includes("pkill"), "previous preview dies by PID, never by pattern");
});
