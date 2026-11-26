import assert from "node:assert/strict";
import { test } from "node:test";
import { matchSkillMd, rankSkillPaths } from "./skill-match";

test("rankSkillPaths: the folder named like the skill first, then a suffix of the name", () => {
  const paths = ["README/SKILL.md", "skills/ads/mcp-setup/SKILL.md", "skills/ads/google-ads-api-mcp-setup/SKILL.md"];
  assert.deepEqual(rankSkillPaths(paths, "google-ads-api-mcp-setup"), [
    "skills/ads/google-ads-api-mcp-setup/SKILL.md",
    "skills/ads/mcp-setup/SKILL.md",
    "README/SKILL.md",
  ]);
  assert.deepEqual(rankSkillPaths(["SKILL.md"], "x"), ["SKILL.md"]);
});

test("matchSkillMd: only the SKILL.md whose frontmatter name is the skill's", () => {
  const md = "---\nname: Google-Ads\ndescription: Run ads\n---\n\nBody here\n";
  assert.deepEqual(matchSkillMd(md, "google-ads"), { name: "Google-Ads", description: "Run ads", body: "Body here" });
  assert.equal(matchSkillMd(md, "other"), null);
  assert.equal(matchSkillMd("no frontmatter", "x"), null);
});
