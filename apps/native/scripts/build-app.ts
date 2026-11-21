/* eslint-disable no-console */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const NATIVE_DIR = resolve(__dirname, "..");
const BUNDLE_DIR = join(NATIVE_DIR, "src-tauri", "target", "release", "bundle");
const DMG_OUT_DIR = join(BUNDLE_DIR, "dmg");

function log(msg: string) {
  console.log(`[build-app] ${msg}`);
}

function sleep(ms: number) {
  // Blocking on purpose: the hdiutil calls around it must not interleave.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

type Attached = { devEntry: string; mountPoints: string[] };

/** Ask hdiutil which device and mountpoints a given disk image is attached to. */
function attachedFor(imagePath: string): Attached | null {
  const plist = execFileSync("hdiutil", ["info", "-plist"], {
    encoding: "utf8",
  });
  const json = execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {
    input: plist,
    encoding: "utf8",
  });
  const info = JSON.parse(json) as {
    images?: {
      "image-path"?: string;
      "system-entities"?: { "dev-entry"?: string; "mount-point"?: string }[];
    }[];
  };
  for (const image of info.images ?? []) {
    if (image["image-path"] !== imagePath) continue;
    const entities = image["system-entities"] ?? [];
    // The whole-disk entry is the one to detach; the slices carry the mounts.
    const devEntry = entities
      .map((e) => e["dev-entry"] ?? "")
      .filter(Boolean)
      .sort((a, b) => a.length - b.length)[0];
    if (!devEntry) continue;
    return {
      devEntry,
      mountPoints: entities
        .map((e) => e["mount-point"] ?? "")
        .filter(Boolean),
    };
  }
  return null;
}

/**
 * bundle_dmg.sh gives up after 3 detach attempts (~6s of waiting). Spotlight
 * indexing a 1.2 GB app holds the volume busy well past that, so the script
 * exits 16 with the read-write image still mounted and the final DMG never
 * written. Detaching with real patience has always worked — the longest
 * observed case took four tries.
 */
function detachWithPatience(attached: Attached): boolean {
  for (const mount of attached.mountPoints) {
    try {
      // Tells Spotlight to leave this volume alone, which is what holds it busy.
      writeFileSync(join(mount, ".metadata_never_index"), "");
    } catch {
      // Already unmounted, or read-only: nothing lost by trying.
    }
  }
  for (let attempt = 1; attempt <= 8; attempt++) {
    const r = spawnSync("hdiutil", ["detach", attached.devEntry], {
      encoding: "utf8",
    });
    if (r.status === 0) {
      log(`detached ${attached.devEntry} on attempt ${attempt}`);
      return true;
    }
    log(`detach attempt ${attempt} failed (${r.status}), waiting`);
    sleep(2000 * attempt);
  }
  const forced = spawnSync("hdiutil", ["detach", "-force", attached.devEntry], {
    encoding: "utf8",
  });
  if (forced.status === 0) {
    log(`detached ${attached.devEntry} by force`);
    return true;
  }
  log(`WARN: could not detach ${attached.devEntry}`);
  return false;
}

/**
 * Finish the job bundle_dmg.sh abandoned: compress the leftover read-write
 * image into the DMG it was going to produce. UDZO at zlib-level 9 matches
 * what the script itself would have run.
 */
/**
 * The temp image is "rw.<pid>.<final name>" next to whatever bundle_dmg.sh
 * resolved as its output directory — which is `bundle/macos`, its working
 * directory, not the `bundle/dmg` that Tauri moves the finished file into. So
 * look through the whole bundle tree rather than guessing one directory.
 */
function leftoverTemps(): string[] {
  if (!existsSync(BUNDLE_DIR)) return [];
  const dirs = [
    BUNDLE_DIR,
    ...readdirSync(BUNDLE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(BUNDLE_DIR, e.name)),
  ];
  const found: string[] = [];
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      if (f.startsWith("rw.") && f.endsWith(".dmg")) found.push(join(dir, f));
    }
  }
  return found;
}

function finishDmg(): boolean {
  const temps = leftoverTemps();
  if (temps.length === 0) return false;

  let finished = false;
  for (const tempPath of temps) {
    const finalName = basename(tempPath).replace(/^rw\.\d+\./, "");
    const finalPath = join(DMG_OUT_DIR, finalName);
    log(`recovering abandoned bundle: ${basename(tempPath)} -> ${finalName}`);

    const attached = attachedFor(tempPath);
    if (attached && !detachWithPatience(attached)) continue;

    mkdirSync(DMG_OUT_DIR, { recursive: true });
    if (existsSync(finalPath)) rmSync(finalPath);
    const convert = spawnSync(
      "hdiutil",
      [
        "convert",
        tempPath,
        "-format",
        "UDZO",
        "-imagekey",
        "zlib-level=9",
        "-o",
        finalPath,
      ],
      { stdio: "inherit" },
    );
    if (convert.status !== 0) {
      log(`WARN: convert failed for ${basename(tempPath)}`);
      continue;
    }
    rmSync(tempPath, { force: true });
    log(`wrote ${finalPath}`);
    finished = true;
  }
  return finished;
}

function main() {
  const passthrough = process.argv.slice(2);
  // Recover a bundle an earlier run abandoned, without paying for a rebuild.
  if (passthrough.includes("--finish-dmg")) {
    process.exit(finishDmg() ? 0 : 1);
  }
  const build = spawnSync("pnpm", ["exec", "tauri", "build", ...passthrough], {
    cwd: NATIVE_DIR,
    stdio: "inherit",
  });
  if (build.status === 0) return;

  if (process.platform === "darwin" && finishDmg()) {
    log("tauri build failed while unmounting the DMG; recovered the bundle");
    return;
  }
  process.exit(build.status ?? 1);
}

main();
