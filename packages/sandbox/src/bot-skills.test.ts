import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { renderSkillSyncScript } from "./bot";

const b64 = (s: string) => Buffer.from(s).toString("base64");

/** Run the sync script the way the computer does: node -e, the skills on stdin. */
function sync(dir: string, skills: unknown[]) {
  execFileSync(process.execPath, ["-e", renderSkillSyncScript(dir)], { input: JSON.stringify(skills) });
}

test("skill sync: writes loaded skills, drops unloaded ones it wrote, leaves the bot's own alone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-skills-"));
  const dir = path.join(root, "skills");
  try {
    sync(dir, [
      { name: "pdf", files: [{ path: "SKILL.md", content: b64("v1") }, { path: "scripts/a.py", content: b64("a") }] },
      { name: "notes", files: [{ path: "SKILL.md", content: b64("n") }] },
    ]);
    assert.equal(fs.readFileSync(path.join(dir, "pdf", "scripts", "a.py"), "utf8"), "a");
    // One the bot made itself.
    fs.mkdirSync(path.join(dir, "mine"));
    fs.writeFileSync(path.join(dir, "mine", "SKILL.md"), "mine");

    sync(dir, [{ name: "pdf", files: [{ path: "SKILL.md", content: b64("v2") }] }]);
    assert.equal(fs.readFileSync(path.join(dir, "pdf", "SKILL.md"), "utf8"), "v2");
    assert.equal(fs.existsSync(path.join(dir, "pdf", "scripts")), false, "a file gone from the skill goes");
    assert.equal(fs.existsSync(path.join(dir, "notes")), false, "an unloaded skill goes");
    assert.equal(fs.readFileSync(path.join(dir, "mine", "SKILL.md"), "utf8"), "mine");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skill sync: a bad name or a path out of the skill's folder writes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-skills-"));
  const dir = path.join(root, "skills");
  try {
    sync(dir, [
      { name: "../evil", files: [{ path: "SKILL.md", content: b64("x") }] },
      { name: "ok", files: [{ path: "../../escape.txt", content: b64("x") }, { path: "SKILL.md", content: b64("ok") }] },
    ]);
    assert.deepEqual(fs.readdirSync(dir).sort(), [".nexux-skills.json", "ok"]);
    assert.equal(fs.existsSync(path.join(root, "escape.txt")), false);
    assert.equal(fs.existsSync(path.join(root, "evil")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
