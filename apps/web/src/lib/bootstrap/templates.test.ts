import assert from "node:assert/strict";
import test from "node:test";

import { BOOTSTRAP_TEMPLATES } from "./templates";

test("templates suggest npm, the one manager Node ships with", () => {
  // A template runs before the repo exists, so there is no lockfile to read.
  // Naming pnpm/yarn/bun here is a guess that outlives itself: detection fills
  // empty fields rather than correcting stored ones, so a wrong guess keeps
  // running long after the real answer is knowable — and it did, calling
  // `pnpm dev` on repos that ship a package-lock.json and no pnpm anywhere.
  const withCommand = BOOTSTRAP_TEMPLATES.filter((t) => t.localCommand);
  // Without this the loop below passes on an empty set, and the rule would be
  // silently unguarded the day someone drops the field.
  assert.ok(withCommand.length > 0, "no template suggests a command at all");
  for (const t of withCommand) {
    assert.match(
      t.localCommand!,
      /^npm\b/,
      `template "${t.key}" suggests ${t.localCommand}`,
    );
  }
});

test("every template key is unique and self-describing", () => {
  const keys = BOOTSTRAP_TEMPLATES.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate template key");
  for (const t of BOOTSTRAP_TEMPLATES) {
    assert.ok(t.name.length > 0, `template "${t.key}" needs a name`);
    assert.ok(t.tagline.length > 0, `template "${t.key}" needs a tagline`);
  }
});
