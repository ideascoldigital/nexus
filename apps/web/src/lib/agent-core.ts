// Pure agent-delegation logic: prompt builders, agent policy defaults and
// sandbox addressing. No prisma/telegram/embeddings imports — this module is
// unit-testable (agent-core.test.ts) and is the seam the brain dispatcher
// (spec 16) plugs into. task-manager.ts / dev-console.ts re-export from here.

import { getConfig } from "@nexux/config";
import { AGENT_USER, safeSlug, sandboxPrivateKeyPath } from "@nexux/sandbox";

/** How to reach a sandbox: SSH (cloud) or docker exec (local). */
export type SandboxTarget = {
  host?: string;
  container?: string;
  user: string;
  privateKeyPath?: string;
  cwd: string;
};

export function sandboxTarget(
  sandbox: {
    provider: string;
    publicIp: string | null;
    instanceId: string | null;
  },
  cwd: string,
  user: string = AGENT_USER,
): SandboxTarget {
  if (sandbox.provider === "local") {
    if (!sandbox.instanceId) {
      throw new Error("Local sandbox has no container yet");
    }
    return { container: sandbox.instanceId, user, cwd };
  }
  if (!sandbox.publicIp) throw new Error("Sandbox has no public IP");
  return {
    host: sandbox.publicIp,
    user,
    privateKeyPath: sandboxPrivateKeyPath(getConfig().dataDir),
    cwd,
  };
}

/** Is the sandbox reachable for exec? (running + address/container known) */
export function sandboxReachable(sandbox: {
  status: string;
  provider: string;
  publicIp: string | null;
  instanceId: string | null;
}): boolean {
  if (sandbox.status !== "running") return false;
  return sandbox.provider === "local"
    ? Boolean(sandbox.instanceId)
    : Boolean(sandbox.publicIp);
}

export type AgentPolicy = {
  baseBranch: string | null;
  createPr: boolean;
  runTests: boolean;
  captureScreenshots: boolean;
  agentInstructions: string | null;
  installAgentBrowser: boolean;
  livePreview: boolean;
  previewPort: number;
  /** Which agent CLI runs delegated work: "claude" | "opencode". */
  brain: string;
  claudeModel: string | null;
  openCodeModel: string | null;
  /** Cap on one agent run, in minutes. */
  taskTimeoutMinutes: number;
};

export const DEFAULT_POLICY: AgentPolicy = {
  baseBranch: null,
  createPr: true,
  runTests: true,
  captureScreenshots: true,
  agentInstructions: null,
  installAgentBrowser: true,
  livePreview: false,
  previewPort: 3000,
  brain: "claude",
  claudeModel: null,
  openCodeModel: null,
  taskTimeoutMinutes: 45,
};

/** The --model/-m value for the policy's active brain. */
export function policyModel(
  policy: Pick<AgentPolicy, "brain" | "claudeModel" | "openCodeModel">,
): string | undefined {
  return (
    (policy.brain === "opencode" ? policy.openCodeModel : policy.claudeModel) ??
    undefined
  );
}

/**
 * Layer a feature's own PR preference over the project policy. `Feature.createPr`
 * is nullable on purpose: null means "inherit", so the feature keeps following
 * `SandboxConfig.createPr` and moves whenever that default changes. Only an
 * explicit true/false pins the feature and wins here.
 */
export function withFeaturePrOverride(
  policy: AgentPolicy,
  createPr: boolean | null | undefined,
): AgentPolicy {
  return createPr == null ? policy : { ...policy, createPr };
}

/** Where the agent drops screenshots on the instance — outside the repo. */
export const REMOTE_SHOT_DIR = "/tmp/nexux-screenshots";

// The run is a single headless pass: `claude -p` exits the moment the agent
// ends its reply, so anything "scheduled for later" never happens. One task
// died exactly this way — it parked on a Monitor/ScheduleWakeup waiting for a
// Chromium download and finished with zero commits.
export const HEADLESS_RULES = `You run in a single headless pass: the session ends permanently the moment you finish your reply. There is no later — never use Monitor, ScheduleWakeup, TaskUpdate or any "wait for a notification / check back later" pattern; those wakeups will never fire. If you must wait for something (an install, a server boot, a download), poll for it synchronously in the same Bash call with a bounded timeout, and if it isn't ready within ~3 minutes, move on without it and say so in your report.`;

/** Prompt sent to the agent CLI for a feature-driven task. */
export function buildFeaturePrompt(feature: {
  title: string;
  description: string | null;
  aiRefinement: string | null;
  devPhase?: { name: string; goal: string | null } | null;
  /** Latest plan-mode plan for this feature — becomes the implementer's map. */
  planContent?: string | null;
}): string {
  const parts = [`Implement the following feature: ${feature.title}`];
  if (feature.description?.trim()) {
    parts.push(`\nDescription:\n${feature.description.trim()}`);
  }
  if (feature.aiRefinement?.trim()) {
    parts.push(`\nAdditional context:\n${feature.aiRefinement.trim()}`);
  }
  if (feature.devPhase) {
    parts.push(
      `\nDevelopment phase: ${feature.devPhase.name}${
        feature.devPhase.goal?.trim()
          ? `\nPhase goal: ${feature.devPhase.goal.trim()}`
          : ""
      }`
    );
  }
  if (feature.planContent?.trim()) {
    parts.push(
      `\nImplementation plan (prepared in read-only plan mode against this workspace's real checkouts):\n\n${feature.planContent.trim()}\n\nFollow the plan unless the code contradicts it — and when you deviate, say where and why in your report.`
    );
  }
  return parts.join("\n");
}

/**
 * Prompt for a read-only planning run (Claude plan mode) on the dev sandbox.
 * The run cannot edit anything, so it may share the sandbox with live work;
 * its whole deliverable is the reply text, which becomes a Plan row.
 */
export function buildPlanPrompt(opts: {
  feature: {
    title: string;
    description: string | null;
    aiRefinement: string | null;
    devPhase?: { name: string; goal: string | null } | null;
  };
  workDir: string;
  searchContext?: string | null;
}): string {
  const sections: string[] = [
    `# Planning task\nProduce an implementation plan for the following feature. Do NOT implement it — you are in read-only plan mode.\n\n${buildFeaturePrompt(opts.feature)}`,
    `# Working agreement\nYou are in the project's development workspace at ${opts.workDir}. Sibling checkouts of this project's other repositories live next to it — the feature may belong in any of them, so identify the right repo(s) before planning file-level changes. Ground every claim in code you actually read; never plan against guessed file names.\n${HEADLESS_RULES}`,
  ];
  if (opts.searchContext) {
    sections.push(`# Project context\n${opts.searchContext}`);
  }
  sections.push(
    `# Required output
End your reply with the complete plan in markdown — the reply text is the deliverable and is saved verbatim as the feature's plan. Structure it as:
## Summary — the approach in a few sentences
## Affected repos & files — each with what changes and why
## Implementation steps — ordered, each independently verifiable
## Test plan — what proves it works, including existing suites to run
## Risks — what could break, and what to watch in review
## Open questions — decisions that need the user (omit the section if none)`,
  );
  return sections.join("\n\n");
}

/**
 * Follow-up on an earlier plan: same read-only rules, revised full document.
 * When the planning session is resumed the agent still remembers the code it
 * explored; when it is gone, the previous plan travels in the prompt and the
 * agent must re-read the code before changing any claim.
 */
export function buildPlanFollowUpPrompt(opts: {
  followUp: string;
  resumed: boolean;
  previousPlan: string | null;
  workDir: string;
}): string {
  const sections: string[] = [
    `# Plan follow-up\n${opts.followUp.trim()}`,
    opts.resumed
      ? `# Context\nThis continues your planning session for this feature — the code you explored and the plan you produced are in your memory. Revise the plan according to the follow-up.`
      : `# Context\nYou are revising an earlier plan from a session you no longer remember. The previous plan is below. Re-read the relevant code before changing or keeping any claim in it — do not trust the plan over the code.${
          opts.previousPlan ? `\n\n## Previous plan\n${opts.previousPlan}` : ""
        }`,
    `# Working agreement\nYou are in the project's development workspace at ${opts.workDir}, in read-only plan mode — do NOT implement anything. Sibling checkouts of the project's other repositories live next to it.\n${HEADLESS_RULES}`,
    `# Required output\nEnd your reply with the COMPLETE revised plan in markdown — the full document with every section (Summary, Affected repos & files, Implementation steps, Test plan, Risks, Open questions), not a diff or a delta. The reply text replaces the previous plan verbatim.`,
  ];
  return sections.join("\n\n");
}

/** A project agent, as materialized into the sandbox's ~/.claude/agents. */
export type AgentDef = {
  name: string;
  description: string | null;
  systemPrompt: string;
  model?: string | null;
};

/** A project skill, as materialized into the sandbox's ~/.claude/skills. */
export type SkillDef = {
  name: string;
  description: string | null;
  body?: string | null;
};

/** Single-line, double-quoted YAML scalar — safe for frontmatter values. */
function yamlValue(value: string): string {
  const oneLine = value.replace(/\s*\n\s*/g, " ").trim();
  return `"${oneLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Reconstruct a Claude Code subagent file: YAML frontmatter (name slug,
 * description, model) followed by the system prompt body. Written to
 * ~/.claude/agents/<slug>.md so the headless run can delegate to it.
 */
export function renderAgentFile(agent: AgentDef): string {
  const front = [
    "---",
    `name: ${safeSlug(agent.name)}`,
    `description: ${yamlValue(agent.description?.trim() || agent.name)}`,
  ];
  if (agent.model?.trim()) front.push(`model: ${yamlValue(agent.model.trim())}`);
  front.push("---", "");
  return `${front.join("\n")}${(agent.systemPrompt ?? "").trim()}\n`;
}

/**
 * Reconstruct a SKILL.md: YAML frontmatter (name slug, description) followed
 * by the skill body. Written to ~/.claude/skills/<slug>/SKILL.md so Claude
 * Code auto-loads the full instructions, not just the name.
 */
export function renderSkillFile(skill: SkillDef): string {
  const front = [
    "---",
    `name: ${safeSlug(skill.name)}`,
    `description: ${yamlValue(skill.description?.trim() || skill.name)}`,
    "---",
    "",
  ];
  return `${front.join("\n")}${(skill.body ?? "").trim()}\n`;
}

/**
 * Wraps the task with the project's standing policy: subagents and skills to
 * apply, quality gates (tests, review pass), screenshots, and the commit
 * contract. Branching, pushing and PR creation are done by Nexus around the
 * agent — the agent is only asked to commit.
 */
export function buildAgentPrompt(opts: {
  task: string;
  branch: string;
  policy: AgentPolicy;
  skills: Array<{ name: string; description: string | null }>;
  agents?: Array<{ name: string; description: string | null }>;
  runCommand: string | null;
  searchContext?: string | null;
}): string {
  const { task, branch, policy, skills, runCommand } = opts;
  const agents = opts.agents ?? [];
  const sections: string[] = [
    `# Task\n${task}`,
    `# Working agreement
You are working autonomously in a sandboxed clone of this repository, on branch \`${branch}\`.
Follow the repository's own conventions (CLAUDE.md / AGENTS.md if present) at all times.
${HEADLESS_RULES}`,
  ];

  if (opts.searchContext) {
    sections.push(`# Project context\n${opts.searchContext}`);
  }

  if (agents.length > 0) {
    sections.push(
      `# Subagents available\nThese specialized subagents are installed for this project (under \`~/.claude/agents/\`). Delegate to them with the Task tool whenever a subtask matches one:\n` +
        agents
          .map(
            (a) =>
              `- **${safeSlug(a.name)}**${a.description ? `: ${a.description}` : ""}`,
          )
          .join("\n"),
    );
  }

  if (skills.length > 0) {
    sections.push(
      `# Skills to apply\nThis project has these skills installed (their full instructions live under \`~/.claude/skills/\`). Apply the relevant ones and say which you used:\n` +
        skills
          .map((s) => `- **${s.name}**${s.description ? `: ${s.description}` : ""}`)
          .join("\n"),
    );
  }

  const steps: string[] = [
    "Explore the codebase before changing anything; match existing patterns.",
    "Implement the task.",
  ];
  if (policy.runTests) {
    steps.push(
      "Run the project's test suite and linter/typechecker (check package.json scripts / Makefile). Fix every failure you introduced. If a pre-existing failure blocks you, say so explicitly instead of silently skipping it.",
    );
  }
  steps.push(
    "Self-review your diff as a critical reviewer would: look for bugs, missed edge cases, security issues and leftover debug code. Fix what you find.",
  );
  // Commit BEFORE the optional screenshot step: it is the deliverable, and a
  // screenshot detour (missing browser, slow install) must never cost it.
  // The branch already carries the type (`fix/…`, `feat/…`), so the commit is
  // told to match it rather than pick its own — a `feat:` commit on a `fix/`
  // branch is the kind of disagreement a reviewer has to stop and resolve.
  const branchType = branch.split("/")[0];
  steps.push(
    `Commit your work on branch \`${branch}\` using a conventional-commit message whose type matches the branch (\`${branchType}: <imperative summary>\`, lowercase, no trailing period, under 72 characters; add a body explaining *why* when the change is not self-evident). Do NOT push and do NOT open a pull request — Nexus does that. Commit now, before any screenshot work — a run that ends without a commit delivers nothing.`,
  );
  if (policy.captureScreenshots && policy.installAgentBrowser) {
    steps.push(
      [
        "Capture screenshots **of the running product** — the app rendered in a browser, as a user sees it. Never screenshot source code, the editor, the terminal or test output. These screenshots go into the pull request, so they are the reviewer's only visual evidence: treat them as a deliverable, not an afterthought.",
        "  a. Start the app in the background" +
          (runCommand
            ? ` with: \`${runCommand}\` (the project's configured run command)`
            : " using the project's dev/start script (check package.json scripts, Makefile or docker-compose)") +
          ", redirecting output to a log file, and wait until its port actually answers (poll with curl).",
        "  b. Drive it with the `agent-browser` CLI (run `agent-browser --help` first if you are unsure of its flags). Navigate to **every page this change affects** — not just the home page — and perform the user flow that exercises it.",
        "  c. Screenshot each affected screen in its meaningful states (e.g. default, hover/active, filled, error). If you can reach the pre-change state (e.g. `git stash`), capture a before/after pair.",
        `  d. Save the images to \`${REMOTE_SHOT_DIR}/\` — one file per screen/state, named for what it shows (e.g. \`settings-page-after.png\`, not \`screenshot1.png\`). This directory is OUTSIDE the repository on purpose: screenshots are review evidence, not source. **Never commit images into the repo** — Nexus collects them from there.`,
        "  e. Stop the app when done.",
        "  If the app genuinely cannot be started, the browser/driver isn't usable within a ~3-minute synchronous wait, or the change has no user-visible surface (e.g. a pure refactor), skip this step and say so explicitly in your report. Never fabricate a screenshot, and never substitute a screenshot of code for a screenshot of the product.",
      ].join("\n"),
    );
  }

  sections.push(
    `# Required steps\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
  );

  if (policy.agentInstructions?.trim()) {
    sections.push(`# Project instructions\n${policy.agentInstructions.trim()}`);
  }

  sections.push(
    `# Final answer
End with a short markdown report:
## Summary — what you changed and why
## Tests — what you ran and the outcome
## Screenshots — paths of the committed product screenshots, and what each one shows (or why there are none)
## Risks — anything a reviewer must check`,
  );

  return sections.join("\n\n");
}

/**
 * Follow-up on an earlier task: same branch, same PR. When the agent session
 * is resumed the agent already remembers what it did, so the prompt stays
 * short; if the session is gone, it must re-read its own diff first.
 */
export function buildFollowUpPrompt(opts: {
  task: string;
  branch: string;
  policy: AgentPolicy;
  resumed: boolean;
}): string {
  const { task, branch, policy, resumed } = opts;
  const sections: string[] = [`# Follow-up request\n${task}`];

  sections.push(
    resumed
      ? `# Context\nThis continues your earlier work on branch \`${branch}\`. Keep the same conventions and build on what you already committed.`
      : `# Context\nYou are continuing earlier work on branch \`${branch}\` from a previous session you no longer remember. Start by reading the branch's diff (\`git log\` and \`git diff origin/HEAD...HEAD\`) so you know what was already done.`,
  );

  sections.push(`# Working agreement\n${HEADLESS_RULES}`);

  const steps = ["Make the requested changes."];
  if (policy.runTests) {
    steps.push("Re-run the tests/linter and fix anything you break.");
  }
  steps.push(
    `Commit on \`${branch}\` with a clear message — before any screenshot work. Do NOT push and do NOT touch the pull request — Nexus updates it.`,
  );
  if (policy.captureScreenshots && policy.installAgentBrowser) {
    steps.push(
      "If the change is user-visible, refresh the product screenshots under `.nexux/screenshots/` (start the app, drive it with `agent-browser`, capture the rendered UI — never screenshot code). Best-effort: skip and say so if the browser isn't usable within a ~3-minute synchronous wait.",
    );
  }
  sections.push(
    `# Required steps\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
  );

  if (policy.agentInstructions?.trim()) {
    sections.push(`# Project instructions\n${policy.agentInstructions.trim()}`);
  }

  sections.push(
    `# Final answer\nEnd with a short markdown report:\n## Summary — what changed in this follow-up\n## Tests — what you ran and the outcome\n## Screenshots — any updated screenshots (or why there are none)\n## Risks — anything a reviewer must check`,
  );

  return sections.join("\n\n");
}

export const NEEDS_INPUT_MARKER = "NEEDS_INPUT:";

/** "# Attachments" prompt section for files pushed into the sandbox. */
export function renderAttachmentsSection(
  attachments: Array<{ name: string; mime: string; remotePath: string }>,
): string | null {
  if (attachments.length === 0) return null;
  return [
    "# Attachments",
    "",
    "The user sent these files with the task — they are on disk in the sandbox:",
    ...attachments.map((a) => `- ${a.remotePath} (${a.mime})`),
    "",
    "Inspect them with the Read tool (it renders images visually). They are inputs from the user, not part of the repo — don't commit them unless asked.",
  ].join("\n");
}

/** Prompt for a dedicated dev-sandbox chat turn (no PR pipeline). */
export function buildDevPrompt(opts: {
  task: string;
  workDir: string;
  resumed: boolean;
  instructions: string | null;
  searchContext?: string | null;
  attachments?: Array<{ name: string; mime: string; remotePath: string }>;
}): string {
  const parts: string[] = [];
  parts.push(`# Instruction\n\n${opts.task.trim()}`);
  const attachmentsSection = renderAttachmentsSection(opts.attachments ?? []);
  if (attachmentsSection) parts.push(attachmentsSection);
  if (opts.searchContext) {
    parts.push(`# Project context\n\n${opts.searchContext}`);
  }
  parts.push(
    [
      "# Dev-session ground rules",
      "",
      `You are working in this project's dedicated development sandbox at ${opts.workDir}. This is an interactive working session, not a delivery pipeline:`,
      "- Do NOT commit, push, or open pull requests unless the instruction above explicitly asks you to. The user decides when code leaves the working tree.",
      opts.resumed
        ? "- This continues your previous session — your earlier work is in the working tree and in your memory. Build on it."
        : "- This is the start of a new session on an existing checkout. Inspect the working tree before assuming a clean slate.",
      "- Leave the app/dev servers in whatever state the instruction implies; don't tear things down defensively.",
      `- If you are blocked, need a decision, or want direction from the user, end your reply with a final line starting exactly with "${NEEDS_INPUT_MARKER}" followed by your question.`,
      `- If the user asks for images/screenshots (or seeing one would clearly help), capture the RUNNING app with the \`agent-browser\` CLI and save PNGs into \`${REMOTE_SHOT_DIR}/\` — Nexus collects that directory after the run and sends the images back to the user (including on Telegram). If this prompt has you open a PR/MR with user-visible changes, capture the change's screenshots the same way: Nexus embeds them into the MR description automatically.`,
      `- ${HEADLESS_RULES}`,
    ].join("\n"),
  );
  if (opts.instructions?.trim()) {
    parts.push(`# Standing instructions\n\n${opts.instructions.trim()}`);
  }
  return parts.join("\n\n");
}

/** Did the agent explicitly ask for direction? */
export function detectNeedsInput(result: string | null | undefined): boolean {
  if (!result) return false;
  const lines = result
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return lines.some((l) => l.startsWith(NEEDS_INPUT_MARKER)) || last.endsWith("?");
}

// ---- Delivery sweep ---------------------------------------------------------
// The agent is only asked to commit; Nexus pushes and opens the PR. But the
// commit doesn't always land in the checkout the task was dispatched against:
// a frontend feature dispatched at the backend repo's workDir gets (correctly)
// implemented in the sibling checkout, and an earlier run may have left the
// branch committed but undelivered (createPr flipped on afterwards, a failed
// push). Counting commits only in workDir made both look like "the agent did
// nothing" and skipped delivery entirely — the sweep finds where the branch
// actually holds work no remote has yet.

/** A checkout holding undelivered work for a task branch. */
export type DeliveryTarget = {
  /** Absolute path of the checkout on the sandbox. */
  dir: string;
  /** Commits on the branch that no remote ref has. */
  unpushed: number;
  /** That checkout's own origin — may differ from the workDir repo's. */
  originUrl: string;
};

const SWEEP_MARK = "NEXUX_SWEEP";

/**
 * Shell one-liner (run with cwd = workDir) that scans every checkout in the
 * workspace parent — workDir included — for the task branch, and reports
 * `NEXUX_SWEEP|<abs dir>|<unpushed count>|<origin url>` per hit. Checkouts
 * without an origin are skipped: there is nowhere to deliver to.
 */
export function deliverySweepCommand(branch: string): string {
  const b = branch.replace(/['\\]/g, "");
  return (
    `for d in ../*/; do ` +
    `git -C "$d" rev-parse --verify --quiet 'refs/heads/${b}' >/dev/null 2>&1 || continue; ` +
    `u=$(git -C "$d" remote get-url origin 2>/dev/null) || continue; ` +
    `n=$(git -C "$d" rev-list --count 'refs/heads/${b}' --not --remotes 2>/dev/null || echo 0); ` +
    `echo "${SWEEP_MARK}|$(cd "$d" && pwd)|$n|$u"; ` +
    `done; true`
  );
}

/** Parse the sweep output; keeps only checkouts with undelivered commits. */
export function parseDeliverySweep(stdout: string): DeliveryTarget[] {
  const targets: DeliveryTarget[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(`${SWEEP_MARK}|`)) continue;
    const [, dir, count, ...rest] = line.trim().split("|");
    const unpushed = parseInt(count ?? "", 10);
    const originUrl = rest.join("|");
    if (!dir || !originUrl || !Number.isFinite(unpushed) || unpushed <= 0) {
      continue;
    }
    targets.push({ dir, unpushed, originUrl });
  }
  return targets;
}

/** host/path of a repo URL, tolerant of credentials, scp syntax and .git. */
function stripRepoUrl(url: string): string {
  let u = url.trim().replace(/^[a-z+]+:\/\//i, "");
  u = u.replace(/^[^@/]*@/, ""); // https creds and scp user@
  u = u.replace(":", "/"); // scp-style host:path
  return u.replace(/\.git$/, "").replace(/\/+$/, "");
}

function normalizeRepoUrl(url: string): string {
  return stripRepoUrl(url).toLowerCase();
}

/**
 * Split a git remote into host and project path, case preserved — GitLab's
 * API addresses projects by path, and lowercasing someone else's namespace
 * is not ours to do.
 */
export function parseGitRemote(
  url: string,
): { host: string; path: string } | null {
  const u = stripRepoUrl(url);
  const slash = u.indexOf("/");
  if (slash <= 0 || slash >= u.length - 1) return null;
  return { host: u.slice(0, slash), path: u.slice(slash + 1) };
}

/**
 * Does this PR/MR URL live in the repo behind this origin URL? PR pages sit
 * under the repo path (`<repo>/pull/N`, `<repo>/-/merge_requests/N`), so a
 * path-prefix match on the normalized repo identifies it — the slash boundary
 * keeps `owner/app` from claiming `owner/app-ui`'s PRs.
 */
export function prUrlMatchesRepo(prUrl: string, originUrl: string): boolean {
  if (!prUrl.trim() || !originUrl.trim()) return false;
  const repo = normalizeRepoUrl(originUrl);
  const pr = normalizeRepoUrl(prUrl);
  return pr === repo || pr.startsWith(`${repo}/`);
}

/**
 * A GitLab MR URL, decomposed for API calls: instance host, project path
 * (case preserved) and the MR iid. Null for anything else — GitHub PRs use
 * a different attach mechanism (assets branch) and don't come through here.
 */
export function mrRefFromUrl(
  url: string,
): { host: string; path: string; iid: string } | null {
  const m = url.trim().match(/^https:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/);
  if (!m) return null;
  return { host: m[1], path: m[2], iid: m[3] };
}

/**
 * Shell command appending a markdown section to an MR's description —
 * read-modify-write against the GitLab API with the sandbox's own
 * GITLAB_TOKEN. Args travel as argv into a heredoc'd python script, so the
 * section content itself never touches shell quoting; it is read from a
 * file staged separately. Idempotent: an already-present section is a no-op.
 */
export function gitlabAppendMrSectionCommand(
  ref: { host: string; path: string; iid: string },
  sectionFile: string,
): string {
  const script = `cat > /tmp/nexux-mr-append.py <<'NEXUX_PY'
import json, os, sys, urllib.request, urllib.parse
host, path, iid, section_file = sys.argv[1:5]
tok = os.environ["GITLAB_TOKEN"]
base = f"https://{host}/api/v4/projects/{urllib.parse.quote(path, safe='')}/merge_requests/{iid}"
req = urllib.request.Request(base, headers={"PRIVATE-TOKEN": tok})
mr = json.load(urllib.request.urlopen(req))
section = open(section_file).read()
desc = mr.get("description") or ""
if section.strip() and section.strip() not in desc:
    data = urllib.parse.urlencode({"description": desc + section}).encode()
    req = urllib.request.Request(base, data=data, method="PUT", headers={"PRIVATE-TOKEN": tok})
    urllib.request.urlopen(req)
print("NEXUX_MR_APPENDED")
NEXUX_PY
python3 /tmp/nexux-mr-append.py '${ref.host}' '${ref.path.replace(/'/g, "")}' '${ref.iid}' '${sectionFile}'`;
  return script;
}

/**
 * PR/MR links inside an agent's report. The dev console has no delivery
 * phase — when the user tells the agent to open a PR there, the only place
 * the link exists is the reply text, so it is mined from there.
 */
export function extractPrUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.match(
    /https:\/\/[^\s<>()"'\]]+?(?:\/pull\/\d+|\/-\/merge_requests\/\d+)/g,
  );
  return [...new Set(matches ?? [])];
}

// ---- Screenshot publishing (GitLab) -----------------------------------------
// GitHub embeds PR screenshots from the assets branch (contents API). GitLab
// has a first-class equivalent: the project uploads API, whose files render
// inline in MR descriptions for anyone with project access — no branch needed.

const SHOT_MARK = "NEXUX_SHOT";

/**
 * Shell one-liner uploading every collected screenshot to the GitLab project
 * uploads API, printing `NEXUX_SHOT|<file name>|<response json>` per upload.
 * glab can't send multipart, so this is curl with the same GITLAB_TOKEN the
 * bootstrap gives glab (sourced from /etc/profile.d by bash -lc).
 */
export function gitlabUploadShotsCommand(repo: {
  host: string;
  path: string;
}): string {
  const api = `https://${repo.host}/api/v4/projects/${encodeURIComponent(repo.path)}/uploads`;
  return (
    `[ -n "\${GITLAB_TOKEN:-}" ] || { echo "${SHOT_MARK}_ERR|GITLAB_TOKEN is not set"; exit 0; }; ` +
    `for f in ${REMOTE_SHOT_DIR}/*; do ` +
    `[ -f "$f" ] || continue; ` +
    `NAME=$(basename "$f"); ` +
    `RES=$(curl -fsS --max-time 120 -H "PRIVATE-TOKEN: \${GITLAB_TOKEN}" -F "file=@$f" '${api}') ` +
    `&& echo "${SHOT_MARK}|$NAME|$RES" ` +
    `|| echo "${SHOT_MARK}_ERR|$NAME upload failed"; ` +
    `done; true`
  );
}

/**
 * Absolute image URLs out of the upload responses. `full_path`
 * (`/-/project/<id>/uploads/…`) resolves anywhere on the instance, so a
 * sibling repo's MR can embed it too; older GitLab only returns the
 * project-relative `url`.
 */
export function parseShotUploads(
  stdout: string,
  repo: { host: string; path: string },
): Array<{ name: string; url: string }> {
  const links: Array<{ name: string; url: string }> = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(`${SHOT_MARK}|`)) continue;
    const first = line.indexOf("|");
    const second = line.indexOf("|", first + 1);
    if (second < 0) continue;
    const name = line.slice(first + 1, second);
    try {
      const body = JSON.parse(line.slice(second + 1)) as {
        url?: unknown;
        full_path?: unknown;
      };
      const rel =
        typeof body.full_path === "string" && body.full_path.startsWith("/")
          ? body.full_path
          : typeof body.url === "string" && body.url.startsWith("/")
            ? `/${repo.path}${body.url}`
            : null;
      if (name && rel) links.push({ name, url: `https://${repo.host}${rel}` });
    } catch {
      // Not JSON — a proxy error page or truncated response. Skip the line.
    }
  }
  return links;
}

/** PID files for the live preview — killed by PID, never pkill (the script's
 * own command line contains "nexux-preview" and "cloudflared tunnel", so a
 * pkill -f would match — and kill — the shell running it). */
export const PREVIEW_APP_PID = "/tmp/nexux-app.pid";
export const PREVIEW_TUNNEL_PID = "/tmp/nexux-tunnel.pid";

/**
 * The remote script behind "Start preview": stop the previous app+tunnel by
 * PID, run the app, wait until it answers on the port, then expose it through
 * a Cloudflare quick tunnel. Pure so the shell is testable — the run command
 * travels in a quoted heredoc because inline it would have to survive three
 * levels of quoting (this template, execRemote's `bash -lc`, ssh's own).
 */
export function renderLivePreviewScript(opts: {
  cwd: string;
  runCommand: string;
  port: number;
}): string {
  return `
set -u
for f in ${PREVIEW_APP_PID} ${PREVIEW_TUNNEL_PID}; do
  if [ -f "$f" ]; then
    kill -TERM -"$(cat "$f")" 2>/dev/null || kill -TERM "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  fi
done
sleep 1

cat > /tmp/nexux-preview.sh <<'NEXUX_RUN_EOF'
#!/bin/bash
[ -f /etc/profile.d/nexus-env.sh ] && . /etc/profile.d/nexus-env.sh
cd ${opts.cwd}
exec ${opts.runCommand}
NEXUX_RUN_EOF
chmod +x /tmp/nexux-preview.sh

: > /tmp/nexux-app.log
: > /tmp/nexux-tunnel.log
setsid /tmp/nexux-preview.sh > /tmp/nexux-app.log 2>&1 < /dev/null &
echo $! > ${PREVIEW_APP_PID}

# Wait for the app to actually answer before exposing it (a cold Next build
# takes a while).
for i in $(seq 1 90); do
  curl -fs -o /dev/null "http://localhost:${opts.port}" 2>/dev/null && break
  sleep 2
done
if ! curl -fs -o /dev/null "http://localhost:${opts.port}" 2>/dev/null; then
  echo "APP_FAILED"
  tail -n 25 /tmp/nexux-app.log
  exit 0
fi

# --http-host-header: dev servers commonly refuse Hosts they don't know
# (webpack's "Invalid Host header", Vite's allowedHosts), and the tunnel
# forwards its public trycloudflare hostname by default — so the app answered
# on localhost and 403'd every visitor. Pinning the origin-facing Host to
# localhost passes every framework's check without per-app config.
setsid cloudflared tunnel --no-autoupdate --url "http://localhost:${opts.port}" \\
  --http-host-header "localhost:${opts.port}" \\
  > /tmp/nexux-tunnel.log 2>&1 < /dev/null &
echo $! > ${PREVIEW_TUNNEL_PID}

# The quick-tunnel URL shows up in the log a few seconds in.
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\\.trycloudflare\\.com' /tmp/nexux-tunnel.log | head -1)
  [ -n "$URL" ] && { echo "PREVIEW:$URL"; exit 0; }
  sleep 2
done
echo "TUNNEL_FAILED"
tail -n 25 /tmp/nexux-tunnel.log
`.trim();
}
