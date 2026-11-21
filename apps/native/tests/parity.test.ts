import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";

// Native ↔ web parity guards. The native app mirrors web config through
// duplicated literals (ports, versions, env-var names, prune lists) — none of
// which the compiler checks across the boundary. Each test pins one such pair
// so "the app and the webapp drifted" shows up here, not at runtime.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readJson = (rel: string) => JSON.parse(read(rel));

// --- versions ----------------------------------------------------------------

test("root, web, native, tauri.conf and Cargo.toml versions agree", () => {
  const versions: Record<string, string> = {
    "package.json": readJson("package.json").version,
    "apps/web/package.json": readJson("apps/web/package.json").version,
    "apps/native/package.json": readJson("apps/native/package.json").version,
    "apps/native/src-tauri/tauri.conf.json": readJson(
      "apps/native/src-tauri/tauri.conf.json",
    ).version,
  };
  const cargo = read("apps/native/src-tauri/Cargo.toml");
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(cargoVersion, "Cargo.toml has no [package] version");
  versions["apps/native/src-tauri/Cargo.toml"] = cargoVersion;

  const distinct = new Set(Object.values(versions));
  assert.equal(
    distinct.size,
    1,
    `version drift: ${JSON.stringify(versions, null, 2)}`,
  );
});

// --- sidecar ports -----------------------------------------------------------

test("neither side hardcodes a sidecar port", () => {
  const libRs = read("apps/native/src-tauri/src/lib.rs");
  const sidecarScript = read("apps/native/scripts/build-sidecar.ts");

  // A fixed port is a single point of failure: anything already holding it —
  // an orphaned sidecar above all — makes the app unlaunchable. The OS assigns
  // one instead, so there is no number to agree on.
  assert.ok(
    !/const SIDECAR_PORT: u16/.test(libRs),
    "lib.rs pins a sidecar port again",
  );
  assert.ok(
    libRs.includes('.env("PORT", "0")'),
    "lib.rs no longer asks the sidecar for an ephemeral port",
  );
  const startJsDefault = sidecarScript.match(
    /process\.env\.PORT \|\| "(\d+)"/,
  )?.[1];
  assert.equal(
    startJsDefault,
    "0",
    "start.js defaults to a fixed port instead of an ephemeral one",
  );
});

test("the port the sidecar reports is the one lib.rs listens for", () => {
  const libRs = read("apps/native/src-tauri/src/lib.rs");
  const sidecarScript = read("apps/native/scripts/build-sidecar.ts");

  // The marker is a wire format between two languages and nothing checks it
  // across the boundary: drift here hangs every launch on "Starting…" until
  // the timeout, with a healthy server running the whole time.
  const MARKER = "[nexux] listening on ";
  assert.ok(
    sidecarScript.includes(MARKER),
    "start.js no longer announces the port it bound",
  );
  assert.ok(
    libRs.includes(MARKER),
    "lib.rs no longer reads the port the sidecar announces",
  );
  // Anything that reports "where this server is" reads PORT — the instance
  // lock's origin above all, which is the next launch's only clue about what
  // it collided with. An ephemeral port has to be written back into it.
  assert.ok(
    sidecarScript.includes("process.env.PORT = String(boundPort)"),
    "start.js no longer publishes the bound port back into the environment",
  );
});

test("the window opens on the bundled placeholder, not on the sidecar", () => {
  const conf = readJson("apps/native/src-tauri/tauri.conf.json");
  const libRs = read("apps/native/src-tauri/src/lib.rs");
  const sidecarScript = read("apps/native/scripts/build-sidecar.ts");

  // Pointing the window straight at the sidecar means a connection error for
  // the first seconds of every launch, and leaves lib.rs no way to report a
  // failure — including the one that matters, a port owned by someone else.
  const windowUrl: string = conf.app.windows[0].url;
  assert.ok(
    !windowUrl.startsWith("http"),
    `window url (${windowUrl}) points at a server; it must open the bundled placeholder`,
  );
  assert.ok(
    libRs.includes("format!(\"http://{SIDECAR_HOST}:{bound_port}\")"),
    "lib.rs no longer navigates to the port the sidecar reported",
  );
  // Both halves of the status channel must exist or failures go unreported.
  assert.ok(
    libRs.includes("window.__nexuxStatus"),
    "lib.rs no longer calls the placeholder's status hook",
  );
  assert.ok(
    sidecarScript.includes("window.__nexuxStatus = function"),
    "the placeholder no longer defines the status hook lib.rs calls",
  );
});

test("the sidecar is bound to a kill-on-close job on Windows", () => {
  const libRs = read("apps/native/src-tauri/src/lib.rs");
  const cargo = read("apps/native/src-tauri/Cargo.toml");
  // RunEvent::Exit does not run on TerminateProcess, and a surviving sidecar
  // holds the database's instance lock and a file lock on its own node_modules
  // — which is what makes the next install fail with "Error opening file for
  // writing".
  assert.ok(
    libRs.includes("adopt_into_kill_on_close_job(child.pid())"),
    "lib.rs no longer binds the sidecar to a job object",
  );
  assert.ok(
    libRs.includes("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE"),
    "the job object no longer kills its processes when the app dies",
  );
  assert.ok(
    /\[target\.'cfg\(windows\)'\.dependencies\]/.test(cargo) &&
      cargo.includes("Win32_System_JobObjects"),
    "Cargo.toml no longer pulls the job-object API",
  );
});

test("one-instance is enforced by the database lock, not by a port", () => {
  const libRs = read("apps/native/src-tauri/src/lib.rs");
  // Port occupancy cannot tell a second Nexus from anything else that happens
  // to be listening, and leaves the user no move. The lock knows whose process
  // holds the database, takes over after a crash, and says so — lib.rs only
  // has to relay it.
  assert.ok(
    !/port_in_use/.test(libRs),
    "lib.rs guards startup on a port again instead of on the database lock",
  );
  assert.ok(
    libRs.includes('"[instance-lock] "'),
    "lib.rs no longer surfaces the instance lock's refusal",
  );
});

test("the sidecar is given a PATH that reaches developer tooling", () => {
  const libRs = read("apps/native/src-tauri/src/lib.rs");
  const local = read("packages/sandbox/src/local.ts");

  // A GUI app on macOS starts with launchd's PATH — /usr/bin:/bin:/usr/sbin:
  // /sbin — and the sandbox layer spawns `docker` by bare name. Without a PATH
  // from here that call fails with ENOENT, which the UI then reports as
  // "Docker is not running": the wrong cause, about a daemon that is up.
  assert.ok(
    /run\("docker"/.test(local),
    "the sandbox layer no longer resolves docker through PATH",
  );
  assert.ok(
    libRs.includes('.env("PATH", &sidecar_path_value)'),
    "lib.rs no longer hands the sidecar a PATH",
  );
  assert.ok(
    libRs.includes("fn login_shell_path"),
    "lib.rs no longer asks the login shell where the user's tools are",
  );
});

test("the terminal port is ephemeral and discovered at request time", () => {
  const libRs = read("apps/native/src-tauri/src/lib.rs");
  const termServer = read("packages/terminal/src/terminal-server.ts");
  const infoRoute = read("apps/web/src/app/api/terminal/info/route.ts");

  assert.ok(
    libRs.includes('.env("NEXUX_TERMINAL_PORT", "0")'),
    "lib.rs pins a terminal port instead of letting the OS pick",
  );
  // The bound port has to travel back into the environment, because that is
  // where /api/terminal/info — the browser client's only source — reads it.
  assert.ok(
    termServer.includes("process.env.NEXUX_TERMINAL_PORT = String(bound)"),
    "the terminal server no longer publishes the port it actually bound",
  );
  assert.ok(
    infoRoute.includes("process.env.NEXUX_TERMINAL_PORT"),
    "/api/terminal/info no longer reads the live terminal port",
  );
});

test("native dev port agrees between the web script it runs and devUrl", () => {
  // Checked against the script, not the command line: this used to assert a
  // PORT=3100 prefix on beforeDevCommand while the script it ran hardcoded
  // `-p 3333`, which wins over PORT — so Next served :3333, the webview waited
  // on :3100, and the test passed.
  const conf = readJson("apps/native/src-tauri/tauri.conf.json");
  const scriptName = (conf.build.beforeDevCommand as string).match(
    /--filter @nexux\/web (\S+)/,
  )?.[1];
  assert.ok(scriptName, "beforeDevCommand no longer runs a @nexux/web script");
  const script = readJson("apps/web/package.json").scripts[scriptName!] as string;
  assert.ok(script, `@nexux/web has no "${scriptName}" script`);
  const port = script.match(/-p (\d+)/)?.[1];
  assert.ok(port, `${scriptName} does not pin its port with -p`);
  assert.ok(
    (conf.build.devUrl as string).endsWith(`:${port}`),
    `devUrl (${conf.build.devUrl}) does not match ${scriptName}'s -p ${port}`,
  );
  // The terminal server takes this as its CORS origin; a mismatch refuses the
  // webview's WebSocket.
  assert.ok(
    script.includes(`NEXUX_WEB_ORIGIN=http://localhost:${port}`),
    `${scriptName}'s NEXUX_WEB_ORIGIN does not name port ${port}`,
  );
});

// --- build-target flag -------------------------------------------------------

test("NEXUX_BUILD_TARGET flag matches between build-sidecar and next.config", () => {
  const sidecarScript = read("apps/native/scripts/build-sidecar.ts");
  const nextConfig = read("apps/web/next.config.ts");

  const set = sidecarScript.match(
    /process\.env\.NEXUX_BUILD_TARGET = "([^"]+)"/,
  )?.[1];
  const checked = nextConfig.match(
    /process\.env\.NEXUX_BUILD_TARGET === "([^"]+)"/,
  )?.[1];
  assert.ok(set, "build-sidecar.ts no longer sets NEXUX_BUILD_TARGET");
  assert.ok(checked, "next.config.ts no longer checks NEXUX_BUILD_TARGET");
  assert.equal(
    set,
    checked,
    "standalone output silently disables when these drift",
  );
});

// --- capabilities ------------------------------------------------------------

test("generated capabilities schema carries every declared permission", () => {
  const declared = readJson("apps/native/src-tauri/capabilities/default.json");
  const genPath = path.join(
    ROOT,
    "apps/native/src-tauri/gen/schemas/capabilities.json",
  );
  if (!fs.existsSync(genPath)) return; // build artifact — absent on fresh clone
  const gen = fs.readFileSync(genPath, "utf8");
  for (const perm of declared.permissions as string[]) {
    assert.ok(
      gen.includes(`"${perm}"`),
      `generated capabilities missing "${perm}" — rebuild src-tauri (stale gen/)`,
    );
  }
});

// --- prisma + runtime dependency tracing ------------------------------------

test("sidecar prisma keep-list matches the db datasource provider", () => {
  const sidecarScript = read("apps/native/scripts/build-sidecar.ts");
  const schema = read("packages/db/prisma/schema.prisma");

  const keep = sidecarScript.match(/const PRISMA_KEEP_DB = "([^"]+)"/)?.[1];
  const provider = schema.match(
    /datasource db \{[^}]*provider\s*=\s*"([^"]+)"/,
  )?.[1];
  assert.ok(keep && provider, "keep-list or datasource provider not found");
  assert.equal(
    keep,
    provider,
    "build-sidecar would prune the query compiler the app actually uses",
  );
});

test("packages traced into the native build are never pruned from it", () => {
  const sidecarScript = read("apps/native/scripts/build-sidecar.ts");
  const nextConfig = read("apps/web/next.config.ts");

  // Package names from outputFileTracingIncludes pnpm paths, e.g.
  // "../../node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/**"
  const traced = [
    ...nextConfig.matchAll(/node_modules\/([^*"]+?)\/\*\*/g),
  ].map((m) => m[1]);
  assert.ok(traced.length > 0, "no traced includes found in next.config.ts");

  const pruneBlocks = [
    ...sidecarScript.matchAll(/const PRUNE[A-Z_]* = \[([^\]]*)\]/g),
  ]
    .map((m) => m[1])
    .join(",");
  const pruned = [...pruneBlocks.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  for (const pkg of traced) {
    assert.ok(
      !pruned.some((p) => pkg === p || pkg.startsWith(`${p}/`)),
      `"${pkg}" is traced by next.config.ts but pruned by build-sidecar.ts`,
    );
  }
});

test("migrations source dir copied into the sidecar exists", () => {
  const sidecarScript = read("apps/native/scripts/build-sidecar.ts");
  assert.ok(
    /"db",\s*"prisma",\s*"migrations"/.test(sidecarScript),
    "build-sidecar no longer copies prisma migrations from packages/db",
  );
  assert.ok(
    fs.existsSync(path.join(ROOT, "packages/db/prisma/migrations")),
    "packages/db/prisma/migrations missing",
  );
});

// --- sidecar runtime ↔ build coupling ---------------------------------------

test("next is pinned to an exact version in apps/web/package.json", () => {
  const spec = readJson("apps/web/package.json").dependencies.next;
  // `.next/` is produced by the lockfile's Next, but sidecar/node_modules comes
  // from `pnpm deploy --legacy`, which re-resolves ranges and ignores the
  // lockfile. A `^` here ships a newer runtime than the one that built `.next`,
  // and every render then fails with e.g. "renderToPipeableStream is not
  // implemented" — a blank window, no visible cause.
  assert.ok(
    /^\d+\.\d+\.\d+$/.test(spec),
    `next must be an exact version, got "${spec}"`,
  );
});

test("sidecar start.js pins the build-time next config", () => {
  const sidecarScript = read("apps/native/scripts/build-sidecar.ts");
  // Without this, Next transpiles next.config.ts at boot with SWC. Every
  // @next/swc-* binary is pruned, so it installs next-swc-fallback into its own
  // install dir — EPERM under C:\Program Files, i.e. the MSI build never starts.
  assert.ok(
    sidecarScript.includes("__NEXT_PRIVATE_STANDALONE_CONFIG"),
    "start.js no longer pins required-server-files config",
  );
  assert.ok(
    /rmSync\(f, \{ force: true \}\)/.test(sidecarScript) &&
      sidecarScript.includes("next.config."),
    "build-sidecar no longer drops next.config.* from the sidecar",
  );
});

test("sidecar bundle carries no .env file", () => {
  const sidecarScript = read("apps/native/scripts/build-sidecar.ts");
  // `pnpm deploy` copies apps/web/.env into the bundle, so a locally built
  // installer would ship the developer's secrets — and load them, since
  // @next/env only skips keys the Rust side already set.
  assert.ok(
    /function dropEnvFiles\(/.test(sidecarScript) &&
      /^\s*dropEnvFiles\(\);$/m.test(sidecarScript),
    "build-sidecar no longer strips .env* from the sidecar",
  );

  const bundled = path.join(ROOT, "apps/native/src-tauri/sidecar");
  if (!fs.existsSync(bundled)) return; // build artifact — absent on fresh clone
  const leaked = fs.readdirSync(bundled).filter((f) => /^\.env($|\.)/.test(f));
  assert.deepEqual(
    leaked,
    [],
    `built sidecar still contains ${leaked.join(", ")} — rebuild it (stale bundle)`,
  );
});

// --- data dir ---------------------------------------------------------------

test("lib.rs data dir mirrors the @nexux/config default", () => {
  const libRs = read("apps/native/src-tauri/src/lib.rs");
  const env = read("packages/config/src/env.ts");
  const rustDir = libRs.match(/\.join\("(\.[a-z]+)"\)/)?.[1];
  assert.ok(rustDir, "lib.rs data dir join not found");
  assert.ok(
    env.includes(`"${rustDir}"`),
    `lib.rs uses ${rustDir} but @nexux/config default drifted`,
  );
});
