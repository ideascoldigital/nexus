// node-pty ships `spawn-helper` in its prebuilds without the executable bit
// surviving the npm tarball, and a non-executable helper kills every pty with
// EACCES. Restoring it is a POSIX concern only.
//
// This was a shell one-liner (`chmod … || true`), which is a parse error under
// cmd.exe — neither `chmod` nor `true` exists there — so `pnpm install` failed
// on Windows before it ever reached the packages that matter.
import { chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

if (process.platform === "win32") process.exit(0);

const pnpmDir = new URL("../../../node_modules/.pnpm", import.meta.url).pathname;

let patched = 0;
try {
  for (const entry of readdirSync(pnpmDir)) {
    if (!entry.startsWith("node-pty@")) continue;
    const prebuilds = join(pnpmDir, entry, "node_modules", "node-pty", "prebuilds");
    let targets = [];
    try {
      targets = readdirSync(prebuilds);
    } catch {
      continue;
    }
    for (const target of targets) {
      const helper = join(prebuilds, target, "spawn-helper");
      try {
        chmodSync(helper, statSync(helper).mode | 0o111);
        patched++;
      } catch {
        // no helper for this target, or not ours to chmod — both are fine
      }
    }
  }
} catch {
  // no .pnpm dir (fresh clone, different linker) — nothing to do
}

if (patched > 0) console.log(`[node-pty] made ${patched} spawn-helper(s) executable`);
