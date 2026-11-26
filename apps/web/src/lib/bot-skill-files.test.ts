import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { renderSkillMd, skillFiles } from "./bot-skill-files";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nexux-skill-"));

test("renderSkillMd: frontmatter Claude Code reads, a description even when there is none", () => {
  const md = renderSkillMd({ name: "notes", description: 'Say "hi"\nnicely', body: "  Do it.  " });
  assert.equal(md, '---\nname: notes\ndescription: "Say \\"hi\\" nicely"\n---\n\nDo it.\n');
  assert.match(renderSkillMd({ name: "x", description: null, body: null }), /description: "The x skill\."/);
});

test("skillFiles: a skill on disk goes with its folder, minus .git and node_modules", async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: pdf\n---\nbody");
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.writeFileSync(path.join(dir, "scripts", "run.py"), "print(1)");
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "x.js"), "x");
    const out = await skillFiles({ name: "pdf", description: null, body: null, path: path.join(dir, "SKILL.md") });
    assert.equal(out.name, "pdf");
    assert.deepEqual(out.files.map((f) => f.path).sort(), ["SKILL.md", "scripts/run.py"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skillFiles: no folder (or a missing one) makes SKILL.md from the database", async () => {
  const out = await skillFiles({ name: "db-only", description: "D", body: "B", path: "/nowhere/SKILL.md" });
  assert.deepEqual(out.files.map((f) => f.path), ["SKILL.md"]);
  assert.match(String(out.files[0].content), /name: db-only/);
});
