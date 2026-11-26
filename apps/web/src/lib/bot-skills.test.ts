import assert from "node:assert/strict";
import { test } from "node:test";
import { composeSkillMessage, skillCommand, slashOptions, slashQuery, splitSkillCommand, withSkillCommand } from "./bot-skills";

test("slashQuery: only a lone command at the very start", () => {
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/Ski"), "ski");
  assert.equal(slashQuery("/pdf now"), null);
  assert.equal(slashQuery("hi /pdf"), null);
  assert.equal(slashQuery("/a/b"), null);
});

test("slashOptions: /skills first, the bot's skills after, best match first", () => {
  const skills = [{ name: "pdf", description: "Make PDFs" }, { name: "frontend-design", description: null }];
  assert.deepEqual(slashOptions("", skills).map((o) => o.command), ["skills", "pdf", "frontend-design"]);
  assert.deepEqual(slashOptions("de", skills).map((o) => o.command), ["frontend-design"]);
  assert.deepEqual(slashOptions("sk", skills).map((o) => o.command), ["skills"]);
  assert.deepEqual(slashOptions("pdfs", skills).map((o) => o.command), ["pdf"]);
  assert.equal(slashOptions("", skills)[2].description, "Use this skill for the message");
});

test("skillCommand: a loaded skill's name, case aside; anything else is not one", () => {
  assert.deepEqual(skillCommand("/PDF  make\nit nice", ["pdf"]), { skill: "pdf", rest: "make\nit nice" });
  assert.deepEqual(skillCommand("/pdf", ["pdf"]), { skill: "pdf", rest: "" });
  assert.equal(skillCommand("/other x", ["pdf"]), null);
  assert.equal(skillCommand("use /pdf", ["pdf"]), null);
});

test("withSkillCommand: spells the command out for the bot, keeps other messages as they are", () => {
  const out = withSkillCommand("/pdf the Q3 report", ["pdf"]);
  assert.match(out, /^Use your "pdf" skill/);
  assert.ok(out.endsWith("\n\nthe Q3 report"));
  assert.match(withSkillCommand("/pdf", ["pdf"]), /Ask me what I need/);
  assert.equal(withSkillCommand("/nope hi", ["pdf"]), "/nope hi");
  assert.equal(withSkillCommand("hello", []), "hello");
});

test("composeSkillMessage and splitSkillCommand round-trip a picked skill", () => {
  assert.equal(composeSkillMessage("pdf", "  the report "), "/pdf the report");
  assert.equal(composeSkillMessage("pdf", ""), "/pdf");
  assert.equal(composeSkillMessage(null, " hi "), "hi");
  assert.deepEqual(splitSkillCommand("/pdf the report"), { skill: "pdf", rest: "the report" });
  assert.deepEqual(splitSkillCommand("/pdf"), { skill: "pdf", rest: "" });
  assert.deepEqual(splitSkillCommand("/etc/hosts is odd"), { skill: null, rest: "/etc/hosts is odd" });
  assert.deepEqual(splitSkillCommand("hello"), { skill: null, rest: "hello" });
});
