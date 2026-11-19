import assert from "node:assert/strict";
import { test } from "node:test";

import { renderBotSystemPrompt } from "@nexux/sandbox";

import {
  HANDOFF_FENCE,
  findTeammate,
  handoffForClaude,
  handoffRun,
  parseHandoffBlocks,
  renderHandoffPrompt,
} from "./bot-handoffs";
import { promptLabel, splitReply } from "./bot-routines";
import { botPreview, withEarlierContext } from "./bot-view";

const block = (o: unknown) => "```handoff\n" + JSON.stringify(o) + "\n```";

test("handoff blocks are parsed out; malformed ones dropped", () => {
  const text = [
    "Le pedí el banner a Creative Designer.",
    block({ to: "Creative Designer", message: "Banner 1080x1080 para el lanzamiento" }),
    block({ to: "", message: "x" }),
    block({ to: "Isa" }),
    "```handoff\nnope\n```",
  ].join("\n");
  const { body, handoffs } = parseHandoffBlocks(text);
  assert.equal(body, "Le pedí el banner a Creative Designer.");
  assert.deepEqual(handoffs, [{ to: "Creative Designer", message: "Banner 1080x1080 para el lanzamiento" }]);
  assert.deepEqual(splitReply(text).handoffs, handoffs);
  assert.equal(splitReply(text).body, "Le pedí el banner a Creative Designer.");
});

test("a teammate's message round-trips through the run prompt", () => {
  const p = renderHandoffPrompt({ fromId: "bot_1", fromName: "Marketero", hop: 2, sourceRunId: "run_9", message: "Hola\nsegunda línea" });
  assert.deepEqual(handoffRun(p), {
    fromId: "bot_1",
    fromName: "Marketero",
    hop: 2,
    sourceRunId: "run_9",
    wantsReply: false,
    message: "Hola\nsegunda línea",
  });
  // Older messages carried no thread.
  assert.equal(handoffRun("[nexux:from:bot_1:1] Marketero\nHola")?.sourceRunId, null);
  assert.equal(handoffRun("hola"), null);
  assert.equal(promptLabel(p), "Message from Marketero");
  assert.equal(
    botPreview({ prompt: p, status: "queued", result: null, error: null, needsInput: false }),
    "Marketero: Hola segunda línea",
  );
  assert.match(withEarlierContext("x", [{ prompt: p, result: "listo" }]), /Your teammate Marketero wrote: Hola/);
  const forClaude = handoffForClaude({ fromName: "Marketero", message: "Hola" });
  assert.match(forClaude, /teammate "Marketero" \(another bot .* not the user\)/);
  assert.match(forClaude, /Do NOT message Marketero back just to acknowledge/);
  assert.match(forClaude, /Hand back to "Marketero" only when they must act/);
});

test("teammates are matched by name, ignoring case and spacing", () => {
  const team = [
    { id: "a", name: "Creative Designer" },
    { id: "b", name: "Isa" },
  ];
  assert.equal(findTeammate(team, "creative  designer")?.id, "a");
  assert.equal(findTeammate(team, " ISA ")?.id, "b");
  assert.equal(findTeammate(team, "Designer"), null);
});

test("previews say who a message went to", () => {
  const reply = "Listo.\n" + block({ to: "Isa", message: "agenda la reunión" });
  assert.equal(botPreview({ prompt: "x", status: "completed", result: reply, error: null, needsInput: false }), "Listo.");
  const only = block({ to: "Isa", message: "agenda la reunión" });
  assert.equal(botPreview({ prompt: "x", status: "completed", result: only, error: null, needsInput: false }), "Sent to Isa");
});

test("the system prompt teaches the handoff block and lists the team", () => {
  const sys = renderBotSystemPrompt({
    name: "Marketero",
    needsInputMarker: "NEEDS_INPUT:",
    teammates: [{ name: "Creative Designer", role: "Diseño de piezas" }, { name: "Isa" }],
  });
  assert.ok(sys.includes("```" + HANDOFF_FENCE + "\n"));
  assert.match(sys, /- Creative Designer — Diseño de piezas\n- Isa/);
  const example = sys.slice(sys.indexOf("```" + HANDOFF_FENCE));
  assert.equal(parseHandoffBlocks(example.slice(0, example.indexOf("```", 3) + 3)).handoffs.length, 1);
  assert.match(renderBotSystemPrompt({ name: "Solo", needsInputMarker: "Q:" }), /no teammates yet/);
});

test("a teammate's run becomes a thread reply under the sender's run", async () => {
  const { shapeThreadReply } = await import("./bot-view");
  const base = { id: "r2", botId: "mkt", error: null, createdAt: new Date(0), finishedAt: new Date(1) };
  const prompt = renderHandoffPrompt({ fromId: "cd", fromName: "Creative Designer", hop: 1, sourceRunId: "r1", message: "copy?" });
  const [done] = shapeThreadReply({ ...base, prompt, status: "completed", result: "Me encargo. Aquí va el copy." });
  assert.equal(done?.sourceRunId, "r1");
  assert.equal(done?.text, "Me encargo. Aquí va el copy.");
  assert.equal(shapeThreadReply({ ...base, prompt, status: "running", result: null })[0]?.text, null);
  // Not a threaded handoff: no reply.
  assert.deepEqual(shapeThreadReply({ ...base, prompt: "hola", status: "completed", result: "x" }), []);
  assert.deepEqual(shapeThreadReply({ ...base, prompt: "[nexux:from:cd:1] CD\nx", status: "completed", result: "x" }), []);
});

test("a handoff can ask for the answer back; the answer returns as its own message", async () => {
  const { renderReplyPrompt, replyRun, replyForClaude } = await import("./bot-handoffs");
  const { handoffs } = parseHandoffBlocks(block({ to: "Content Writer", message: "3 frases", reply: true }));
  assert.deepEqual(handoffs, [{ to: "Content Writer", message: "3 frases", reply: true }]);
  assert.equal(parseHandoffBlocks(block({ to: "X", message: "m", reply: "yes" })).handoffs[0]?.reply, undefined);

  const p = renderHandoffPrompt({ fromId: "cd", fromName: "Creative Designer", hop: 1, sourceRunId: "r1", wantsReply: true, message: "3 frases" });
  assert.equal(handoffRun(p)?.wantsReply, true);
  assert.equal(handoffRun(p)?.sourceRunId, "r1");
  assert.equal(handoffRun(renderHandoffPrompt({ fromId: "cd", fromName: "CD", hop: 1, sourceRunId: "r1", message: "m" }))?.wantsReply, false);
  assert.match(handoffForClaude({ fromName: "Creative Designer", message: "m", wantsReply: true }), /gets your reply automatically/);

  const back = renderReplyPrompt({ teammateId: "cw", teammateName: "Content Writer", hop: 2, answer: "1. Tu equipo de IA" });
  assert.deepEqual(replyRun(back), { teammateId: "cw", teammateName: "Content Writer", hop: 2, answer: "1. Tu equipo de IA" });
  assert.equal(promptLabel(back), "Continuing with Content Writer's answer");
  assert.equal(botPreview({ prompt: back, status: "queued", result: null, error: null, needsInput: false }), "Content Writer replied");
  assert.match(replyForClaude({ teammateName: "Content Writer", answer: "x" }), /Continue the task/);
});
