import assert from "node:assert/strict";
import { test } from "node:test";

// Env setup must stay above every other import — @nexux/db builds its client
// at module load against the throwaway SQLite file this configures.
import "../app/api/routes.test-setup";

import { prisma } from "@nexux/db";
import {
  escapeSlack,
  isChannelId,
  isSlackConfigured,
  mdToMrkdwn,
  normalizeChannelName,
  renderDevTaskSlack,
  renderTaskFinishedSlack,
  truncateForSlack,
} from "./slack";
import { htmlToMrkdwn } from "./slack-socket";

// Network calls (chat.postMessage, uploads) are exercised against a real
// workspace by hand; covered here: the mrkdwn renderers and the
// configured-detection that gates every send.

test("escapeSlack escapes mrkdwn's three specials and nothing else", () => {
  assert.equal(escapeSlack("a < b & c > d 'quoted'"),
    "a &lt; b &amp; c &gt; d 'quoted'");
});

test("finished-task message mirrors the Telegram content in mrkdwn", () => {
  const msg = renderTaskFinishedSlack({
    id: "t1",
    status: "completed",
    prompt: "ignored — feature title wins",
    error: null,
    result: "All done. <script> is escaped.",
    durationMs: 95_000,
    costUsd: 1.5,
    prUrl: "https://git.example.com/x/y/-/merge_requests/1",
    previewUrl: null,
    sandboxName: "acme-cris-dev",
    featureTitle: "Radio cards",
  });
  assert.ok(msg.startsWith("✅ *Radio cards*"));
  assert.ok(msg.includes("Sandbox: `acme-cris-dev`"));
  assert.ok(msg.includes("&lt;script&gt;"), "result is escaped");
  assert.ok(msg.includes("1m 35s · $1.50"));
  assert.ok(msg.includes("PR: https://git.example.com/x/y/-/merge_requests/1"));
  assert.ok(
    msg.includes("Reply in this thread to continue the task. #task_t1"),
    "the thread reply is the follow-up — the tag is how the socket finds it",
  );
});

test("failed task leads with the error; needs_input flags the dev prompt", () => {
  const failed = renderTaskFinishedSlack({
    id: "t2",
    status: "error",
    prompt: "do the thing",
    error: "git push failed",
    result: null,
    durationMs: null,
    costUsd: null,
    prUrl: null,
    previewUrl: null,
    sandboxName: "sb",
    featureTitle: null,
  });
  assert.ok(failed.startsWith("❌ *do the thing*"));
  assert.ok(failed.includes("Error: git push failed"));

  const asking = renderDevTaskSlack({
    id: "t3",
    status: "completed",
    phase: "needs_input",
    prompt: "refactor the login",
    error: null,
    result: "NEEDS_INPUT: which provider?",
    durationMs: null,
    costUsd: null,
    prUrl: null,
    sandboxName: "sb-dev",
  });
  assert.ok(asking.startsWith("🙋"));
  assert.ok(asking.includes("needs your input"));
});

test("isSlackConfigured needs a token plus at least one routable channel", async () => {
  assert.equal(await isSlackConfigured(), false, "nothing configured yet");

  await prisma.settings.create({
    data: { key: "slack_bot_token", value: "xoxb-test" },
  });
  assert.equal(await isSlackConfigured(), false, "token alone routes nowhere");

  // A per-project channel is enough…
  const project = await prisma.project.create({ data: { name: "slack-cfg" } });
  await prisma.sandboxConfig.create({
    data: {
      projectId: project.id,
      region: "lon1",
      size: "g4s.kube.small",
      diskImage: "ubuntu-22.04",
      sshPublicKey: "",
      slackChannelId: "C0PROJECT",
    },
  });
  assert.equal(await isSlackConfigured(), true);

  // …and so is the global one on its own.
  await prisma.sandboxConfig.deleteMany({ where: { projectId: project.id } });
  assert.equal(await isSlackConfigured(), false);
  await prisma.settings.create({
    data: { key: "slack_channel_id", value: "C0GLOBAL" },
  });
  assert.equal(await isSlackConfigured(), true);
});

test("channel refs: ids pass through, names normalize to Slack's rules", () => {
  assert.equal(isChannelId("C0123456789"), true);
  assert.equal(isChannelId("#deploys"), false);
  assert.equal(isChannelId("deploys"), false);
  assert.equal(normalizeChannelName("#Deploys Prod"), "deploys-prod");
  assert.equal(normalizeChannelName("nexux.notifs"), "nexux-notifs");
  assert.equal(normalizeChannelName("###"), "");
});

test("handleReply's Telegram HTML converts to mrkdwn for thread answers", () => {
  assert.equal(
    htmlToMrkdwn("🔄 Follow-up started on <code>sb-dev</code> — a &lt;b&gt; &amp; c"),
    "🔄 Follow-up started on `sb-dev` — a <b> & c",
  );
});

test("settings saved from a non-default workspace (ws:<id>: prefix) are found", async () => {
  // The first-setup bug: the Settings page prefixes keys per workspace, so
  // the tokens existed only as ws:<id>:slack_* and bare-key reads missed them.
  await prisma.settings.updateMany({
    where: { key: { in: ["slack_bot_token", "slack_channel_id"] } },
    data: { isActive: false },
  });
  assert.equal(await isSlackConfigured(), false);
  await prisma.settings.create({
    data: { key: "ws:cmr123abc:slack_bot_token", value: "xoxb-scoped" },
  });
  await prisma.settings.create({
    data: { key: "ws:cmr123abc:slack_channel_id", value: "#deploys" },
  });
  assert.equal(await isSlackConfigured(), true, "scoped keys must count");
});

test("agent markdown converts to mrkdwn: bold, tables, headings, links", () => {
  const md = [
    "**Two commits, deliberately split**",
    "| commit | scope |",
    "|---|---|",
    "| 05a5ba5 | feat(clusters) — drawer title |",
    "## Why the split matters",
    "[the MR](https://git.example.com/x/-/merge_requests/290)",
  ].join("\n");
  const out = mdToMrkdwn(md);
  assert.ok(out.includes("*Two commits, deliberately split*"), "** → *");
  assert.ok(!out.includes("|---|"), "separator rows dropped");
  assert.ok(out.includes("• 05a5ba5 — feat(clusters) — drawer title"));
  assert.ok(out.includes("• commit — scope"), "header row is a bullet too");
  assert.ok(out.includes("*Why the split matters*"), "heading → bold");
  assert.ok(
    out.includes("<https://git.example.com/x/-/merge_requests/290|the MR>"),
    "md links → slack links",
  );
});

test("truncation cuts at a boundary, closes fences, and says so", () => {
  const long = `intro line\n\`\`\`\ncode ${"x".repeat(200)}\n\`\`\`\ntail`;
  const cut = truncateForSlack(long, 60);
  assert.ok(cut.length < long.length);
  assert.equal((cut.match(/```/g) ?? []).length % 2, 0, "fences balanced");
  assert.ok(cut.endsWith("_… truncated — the full report is in Nexus._"));
  assert.equal(truncateForSlack("short", 100), "short", "no-op under the cap");
});
