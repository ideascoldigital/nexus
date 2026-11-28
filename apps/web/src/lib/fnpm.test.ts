import assert from "node:assert/strict";
import { test } from "node:test";

import { fnpmRunCommand } from "./fnpm";

test("fnpm is set up once with the repo's own manager, then installs and runs", () => {
  assert.equal(fnpmRunCommand("pnpm", "dev"), "[ -d .fnpm ] || fnpm setup pnpm; fnpm install && fnpm run dev");
  assert.equal(fnpmRunCommand("npm", "start:dev", false), "[ -d .fnpm ] || fnpm setup npm; fnpm run start:dev");
});

test("an unknown manager falls back to npm, never into the command line", () => {
  assert.equal(fnpmRunCommand("rm -rf /", "dev"), "[ -d .fnpm ] || fnpm setup npm; fnpm install && fnpm run dev");
});
