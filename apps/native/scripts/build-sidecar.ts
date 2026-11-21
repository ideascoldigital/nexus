/* eslint-disable no-console */
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  cpSync,
  copyFileSync,
  statSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import os from "node:os";

const NATIVE_DIR = resolve(__dirname, "..");
const SRC_TAURI = join(NATIVE_DIR, "src-tauri");
const WORKSPACE_ROOT = resolve(NATIVE_DIR, "..", "..");
const WEB_DIR = join(WORKSPACE_ROOT, "apps", "web");
const SIDECAR_OUT = join(SRC_TAURI, "sidecar");
const STATIC_OUT = join(SRC_TAURI, "sidecar-build", "static");
const BIN_OUT = join(SRC_TAURI, "binaries");

function log(msg: string) {
  console.log(`[build-sidecar] ${msg}`);
}

function run(cmd: string, cwd: string) {
  log(`$ ${cmd}  (cwd: ${cwd})`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

function rustTargetTriple(): string {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    return arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu";
  }
  if (platform === "win32") return "x86_64-pc-windows-msvc";
  throw new Error(`Unsupported platform: ${platform}/${arch}`);
}

function clean() {
  log("Cleaning previous sidecar build");
  for (const d of [SIDECAR_OUT, STATIC_OUT]) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  mkdirSync(STATIC_OUT, { recursive: true });
  mkdirSync(BIN_OUT, { recursive: true });
}

function buildWeb() {
  log("Building @nexux/web (production)");
  run("pnpm exec next build --webpack", WEB_DIR);
}

// `.next/dev` (turbopack dev-server cache) and `.next/cache` (webpack build
// cache) are left over from `next dev` / prior builds. They are never needed at
// runtime, and `.next/dev` in particular holds rotating `.sst` files that vanish
// mid-walk — `pnpm deploy` then dies with `ENOENT: lstat …/*.sst`. Purge them at
// the source before deploy (we also filter them out of the bundle copy later).
function purgeNextCaches() {
  const nextDir = join(WEB_DIR, ".next");
  for (const sub of ["dev", "cache"]) {
    const target = join(nextDir, sub);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      log(`purged .next/${sub}`);
    }
  }
}

function deployWeb() {
  log("pnpm deploy @nexux/web → sidecar/ (flat node_modules)");
  // --node-linker=hoisted produces npm-style flat node_modules (no .pnpm + symlinks).
  // Critical for Tauri bundling because Tauri derefs symlinks and skips dotdirs.
  run(
    `pnpm --filter @nexux/web --config.node-linker=hoisted deploy --legacy --prod "${SIDECAR_OUT}"`,
    WORKSPACE_ROOT,
  );
}

// Build/dev-only packages that `next start` never loads at runtime. `pnpm deploy
// --prod` still ships these because they are real (dev)dependencies in the tree;
// webpack has already inlined what the server needs into `.next/server`, and the
// production server runs precompiled — it never invokes the SWC compiler, the TS
// toolchain, or Babel. Removing them is safe and reclaims ~165 MB.
//
// Conservative on purpose: only packages with zero runtime require() path. App
// libraries that webpack bundled (react, date-fns, lucide-react, …) are left in
// place — some are lazily required by Next, and the risk outweighs the savings.
const PRUNE = [
  "@next/swc-darwin-arm64", // 116M — SWC native compiler, build-only
  "@next/swc-darwin-x64",
  "@next/swc-linux-x64-gnu",
  "@next/swc-linux-arm64-gnu",
  "@next/swc-win32-x64-msvc",
  "typescript", // 23M — dev-only
  "@ts-morph", // 11M — TS AST tooling, build-only
  "@babel", // 12M — transpile, build-only
  "@types", // type defs, dev-only
  ".bin", // shell shims, unused at runtime
];

// Build-only entries inside next/dist/compiled. `next start` loads the
// precompiled production server (next-server) and — verified by boot test — also
// needs `compiled/webpack` during config load, so webpack stays. These are the
// experimental React variants and build-pipeline tools the production server
// never requires. Each was confirmed safe by booting the sidecar and rendering a
// page after removal; do NOT add `webpack` or `next-server` here.
const PRUNE_NEXT_COMPILED = [
  "react-dom-experimental",
  "react-server-dom-webpack-experimental",
  "react-server-dom-turbopack-experimental",
  "react-experimental",
  "terser", // JS minifier — build-only
  "babel-packages", // transpile — build-only
  "postcss-preset-env", // CSS build — build-only
  "cssnano-simple", // CSS minify — build-only
  "next-devtools", // dev overlay
];

function pruneNodeModules() {
  const nm = join(SIDECAR_OUT, "node_modules");
  if (!existsSync(nm)) {
    log(`SKIP prune — no node_modules at ${nm}`);
    return;
  }
  for (const pkg of PRUNE) {
    const target = join(nm, pkg);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      log(`pruned node_modules/${pkg}`);
    }
  }
  const compiled = join(nm, "next", "dist", "compiled");
  for (const pkg of PRUNE_NEXT_COMPILED) {
    const target = join(compiled, pkg);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      log(`pruned next/dist/compiled/${pkg}`);
    }
  }

  pruneMuslVariants(nm);
  prunePrismaCompilers(nm);
}

// No Nexus target runs musl (glibc CI runners, a Debian-based image, macOS,
// Windows), yet several packages ship musl builds as optional deps without a
// `libc` field, so pnpm deploy installs them right next to the gnu ones. Any
// ELF linked against musl kills the AppImage: linuxdeploy walks every ELF in
// the AppDir and cannot resolve `libc.musl-x86_64.so.1` on a glibc runner —
// lancedb took down v0.1.1 (run 31150832841), sharp took down v0.1.2 (run
// 31152873203). Sweep by name instead of playing per-package whack-a-mole;
// the tree is flat (hoisted deploy), so top level plus scope children is all.
function pruneMuslVariants(nm: string) {
  const doomed: string[] = [];
  for (const top of readdirSync(nm)) {
    if (top.startsWith("@")) {
      let subs: string[] = [];
      try {
        subs = readdirSync(join(nm, top));
      } catch {
        continue; // not a directory
      }
      for (const sub of subs) {
        if (sub.includes("musl")) doomed.push(join(top, sub));
      }
    } else if (top.includes("musl")) {
      doomed.push(top);
    }
  }
  for (const rel of doomed) {
    rmSync(join(nm, rel), { recursive: true, force: true });
    log(`pruned musl variant node_modules/${rel}`);
  }
}

// Prisma 7 (provider "prisma-client") ships a WASM query compiler per database
// engine — sqlite, postgresql, mysql, sqlserver, cockroachdb — each ~14 MB
// across its fast/small × js/mjs/wasm-base64 variants. Nexus is sqlite-only
// (datasource db { provider = "sqlite" }), so the other four are dead weight
// (~56 MB). Boot-verified: sqlite still loads and queries after removal. If the
// datasource ever changes, update the keep-list below.
const PRISMA_KEEP_DB = "sqlite";
const PRISMA_DROP_DBS = ["postgresql", "mysql", "sqlserver", "cockroachdb"];

function prunePrismaCompilers(nm: string) {
  const runtime = join(nm, "@prisma", "client", "runtime");
  if (!existsSync(runtime)) {
    log(`SKIP prisma prune — no @prisma/client/runtime at ${runtime}`);
    return;
  }
  let dropped = 0;
  for (const file of readdirSync(runtime)) {
    if (!file.startsWith("query_compiler_")) continue;
    if (file.includes(`.${PRISMA_KEEP_DB}.`)) continue;
    if (PRISMA_DROP_DBS.some((db) => file.includes(`.${db}.`))) {
      rmSync(join(runtime, file), { force: true });
      dropped++;
    }
  }
  if (dropped) log(`pruned ${dropped} non-${PRISMA_KEEP_DB} prisma query compilers`);
}

function copyBuiltAssets() {
  const nextSrc = join(WEB_DIR, ".next");
  const nextDest = join(SIDECAR_OUT, ".next");
  if (existsSync(nextDest)) rmSync(nextDest, { recursive: true, force: true });
  log("Copying .next/ → sidecar/.next/ (excluding build & dev caches)");
  // `.next/cache` (webpack/turbopack build cache) and `.next/dev` (dev-server
  // cache) are build/dev-time only — never read by `next start`. They account
  // for ~1.4 GB of the bundle, so skip them. `.next/standalone` is also dropped:
  // node_modules come from the separate `pnpm deploy` step, and shipping it
  // would duplicate the runtime tree.
  const SKIP_NEXT = new Set(["cache", "dev", "standalone"]);
  cpSync(nextSrc, nextDest, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(nextSrc.length + 1);
      if (rel === "") return true;
      const top = rel.split(/[\\/]/)[0];
      return !SKIP_NEXT.has(top);
    },
  });

  const publicSrc = join(WEB_DIR, "public");
  if (existsSync(publicSrc)) {
    const publicDest = join(SIDECAR_OUT, "public");
    if (existsSync(publicDest))
      rmSync(publicDest, { recursive: true, force: true });
    log("Copying public/ → sidecar/public/");
    cpSync(publicSrc, publicDest, { recursive: true });
  }
}

function copyMigrations() {
  const src = join(WORKSPACE_ROOT, "packages", "db", "prisma", "migrations");
  if (!existsSync(src)) {
    log(`SKIP migrations copy — source missing: ${src}`);
    return;
  }
  const dest = join(SIDECAR_OUT, "prisma", "migrations");
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  log(`copied migrations → ${dest}`);
}

function writeEntry() {
  // Tiny launcher: `node start.js` runs `next start` from sidecar root.
  //
  // It mirrors what Next's own standalone `server.js` does: feed the server the
  // config Next already resolved at build time (`required-server-files.json`)
  // instead of letting it read `next.config.ts` off disk. Loading the TS config
  // at runtime makes Next transpile it with SWC, and since we prune every
  // `@next/swc-*` binary (see PRUNE) it falls back to installing
  // `node_modules/next/next-swc-fallback` *inside the install directory* — which
  // dies with `EPERM: mkdir` under `C:\\Program Files` (the MSI install root) and
  // takes the whole app down. Pinning the config sidesteps SWC entirely.
  const entry = `#!/usr/bin/env node
const path = require("path");
const requiredServerFiles = require("./.next/required-server-files.json");

// Build identity for /api/version — same env contract as the Docker image.
// Baked into build-info.json at bundle time; a GUI app has no other channel.
// NEXUX_NATIVE gates the native-only routes (self-install, open-url).
process.env.NEXUX_NATIVE = "1";
try {
  const info = require("./build-info.json");
  if (info.version) process.env.NEXUX_VERSION ||= info.version;
  if (info.gitSha) process.env.NEXUX_GIT_SHA ||= info.gitSha;
  if (info.builtAt) process.env.NEXUX_BUILT_AT ||= info.builtAt;
} catch {}

// Both set before requiring next: NODE_ENV picks the production app-page
// runtime, __NEXT_PRIVATE_STANDALONE_CONFIG short-circuits config loading.
process.env.NODE_ENV = "production";
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(
  requiredServerFiles.config,
);

const next = require("next");
// 0 = any free port. Deployments that pin one (the Docker image sets
// PORT=3030) still get it; only the fallback changed. Binding first and
// reading back what we got is atomic — there is no window between "is it
// free?" and "take it" for another process to win, which is what made a fixed
// port a single point of failure: one orphaned sidecar on it blocked every
// later launch.
const port = parseInt(process.env.PORT || "0", 10);
const hostname = process.env.HOSTNAME || "127.0.0.1";

(async () => {
  const http = require("http");
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
  });
  const boundPort = server.address().port;
  // Publish it before anything reads PORT. instrumentation builds the instance
  // lock's origin from it, and a lock recording ":0" tells the next launch
  // nothing about where the server it collided with actually is.
  process.env.PORT = String(boundPort);

  const app = next({
    dev: false,
    dir: __dirname,
    hostname,
    port: boundPort,
    conf: requiredServerFiles.config,
  });
  const handler = app.getRequestHandler();
  await app.prepare();
  // Attached only once Next can answer. The socket is open before this, but
  // nothing knows where to connect until the line below says so.
  server.on("request", (req, res) => handler(req, res));

  // Machine-readable, for the native shell: it waits for this line and
  // navigates to the port named in it, rather than probing one it assumed.
  console.log(\`[nexux] listening on \${boundPort}\`);
  console.log(\`Nexus sidecar listening on http://\${hostname}:\${boundPort}\`);
})().catch((err) => {
  console.error("[sidecar] fatal:", err);
  process.exit(1);
});
`;
  writeFileSync(join(SIDECAR_OUT, "start.js"), entry, "utf8");
  log("Wrote sidecar entry start.js");
}

// Build identity the statusbar shows (/api/version). CI passes the commit as
// NEXUX_GIT_SHA (github.sha); a local build asks git. Version comes from the
// web package.json — release-native.yml syncs it from the tag before building
// (scripts/set-version.sh), so tag, bundle and statusbar always agree.
function writeBuildInfo() {
  let gitSha = process.env.NEXUX_GIT_SHA || null;
  if (!gitSha) {
    try {
      gitSha = execSync("git rev-parse HEAD", { cwd: WORKSPACE_ROOT })
        .toString()
        .trim();
    } catch {
      gitSha = null;
    }
  }
  const version =
    process.env.NEXUX_VERSION?.replace(/^v/, "") ||
    (JSON.parse(readFileSync(join(WEB_DIR, "package.json"), "utf8")) as {
      version: string;
    }).version;
  const info = {
    version,
    gitSha,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(
    join(SIDECAR_OUT, "build-info.json"),
    JSON.stringify(info, null, 2) + "\n",
    "utf8",
  );
  log(`Wrote build-info.json (v${version} @ ${gitSha ?? "unknown"})`);
}

// `pnpm deploy` copies the package's source files, next.config.ts among them.
// start.js pins the build-time config, so the file is dead weight — and leaving
// it there is a trap: anything that boots Next without our entry point would
// transpile it and re-trigger the SWC fallback install described in writeEntry.
function dropNextConfigSource() {
  for (const ext of ["ts", "mts", "js", "mjs"]) {
    const f = join(SIDECAR_OUT, `next.config.${ext}`);
    if (existsSync(f)) {
      rmSync(f, { force: true });
      log(`removed sidecar/next.config.${ext} (config is pinned in start.js)`);
    }
  }
}

// `pnpm deploy` also copies apps/web/.env — gitignored, but a real file on the
// machine that runs the build, so a locally produced installer carries the
// developer's own secrets. Not merely embedded: @next/env only skips keys
// already present in process.env, and the Rust side passes just PORT, HOSTNAME,
// NEXUX_* and DATABASE_URL — so anything else in that file (an API key) is
// actively loaded into every install. The sidecar takes all of its configuration
// from the environment lib.rs hands it, so no .env belongs in the bundle.
function dropEnvFiles() {
  for (const entry of readdirSync(SIDECAR_OUT)) {
    if (!/^\.env($|\.)/.test(entry)) continue;
    rmSync(join(SIDECAR_OUT, entry), { force: true });
    log(`removed sidecar/${entry} (runtime config comes from lib.rs)`);
  }
}

// `.next/` is produced by the workspace's Next (installed from the lockfile),
// but `sidecar/node_modules` comes from `pnpm deploy --legacy`, which re-resolves
// dependency ranges from scratch and ignores the lockfile. A `^` range on `next`
// therefore ships a *newer* runtime than the one that built `.next`, and the
// server then blows up per-request with errors like "renderToPipeableStream is
// not implemented" — a blank window with no clue why. `next` is pinned exactly in
// apps/web/package.json to prevent it; this asserts the invariant still holds.
function assertNextVersionParity() {
  // Next stamps the build with diagnostics/framework.json; fall back to the
  // workspace install (the Next that ran `next build`) if a future version stops
  // emitting it, so the guard degrades instead of failing the build outright.
  const diagnostics = join(
    SIDECAR_OUT,
    ".next",
    "diagnostics",
    "framework.json",
  );
  const workspaceNext = join(WEB_DIR, "node_modules", "next", "package.json");
  const source = existsSync(diagnostics) ? diagnostics : workspaceNext;
  const shipped = join(SIDECAR_OUT, "node_modules", "next", "package.json");
  if (!existsSync(source) || !existsSync(shipped)) {
    throw new Error(
      `Cannot verify Next version parity — missing ${!existsSync(source) ? source : shipped}`,
    );
  }
  const builtVersion = JSON.parse(readFileSync(source, "utf8")).version;
  const shippedVersion = JSON.parse(readFileSync(shipped, "utf8")).version;
  if (builtVersion !== shippedVersion) {
    throw new Error(
      `Next version mismatch: .next was built with ${builtVersion} but the sidecar ships ${shippedVersion}. ` +
        `Pin "next" to an exact version in apps/web/package.json and re-run pnpm install.`,
    );
  }
  log(`Next version parity OK (${builtVersion})`);
}

// The window opens on this page, not on the sidecar — the server needs a few
// seconds, and its port is not known until it reports one, so there is no URL
// to open on. It also gives lib.rs somewhere to *say* something: `__nexuxStatus`
// is how a refused instance lock or a sidecar that died during startup reaches
// the screen instead of only the log.
function makeStaticPlaceholder() {
  const placeholder = join(STATIC_OUT, "index.html");
  const html = `<!doctype html><meta charset="utf-8"><title>Nexus</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; height: 100vh; display: flex; align-items: center;
    justify-content: center; text-align: center; padding: 2rem;
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #fff; color: #111;
  }
  @media (prefers-color-scheme: dark) { body { background: #0b0b0c; color: #e9e9ea; } }
  #msg { max-width: 34rem; }
</style>
<body><div id="msg">Starting Nexus…</div>
<script>
  window.__nexuxStatus = function (text) {
    document.getElementById("msg").textContent = text;
  };
</script>
</body>`;
  log("Writing static placeholder");
  writeFileSync(placeholder, html, "utf8");
}

function copyNodeBinary() {
  const triple = rustTargetTriple();
  // `which` doesn't exist on Windows; use `where`. Either can return several
  // lines — take the first. process.execPath is the node running this script,
  // which is the right binary anyway, so prefer it and fall back to lookup.
  const isWin = os.platform() === "win32";
  let nodePath = process.execPath;
  if (!nodePath || !existsSync(nodePath)) {
    const lookup = isWin ? "where node" : "which node";
    nodePath = execSync(lookup).toString().trim().split(/\r?\n/)[0].trim();
  }
  if (!nodePath || !existsSync(nodePath)) {
    throw new Error(`Node binary not found on PATH (resolved=${nodePath})`);
  }
  // Tauri appends the host's exe suffix to sidecar binaries, so the file must
  // be named node-<triple>.exe on Windows and node-<triple> elsewhere.
  const suffix = isWin ? ".exe" : "";
  const dest = join(BIN_OUT, `node-${triple}${suffix}`);
  log(`Copying ${nodePath} → ${dest}`);
  copyFileSync(nodePath, dest);
  const mode = statSync(dest).mode;
  chmodSync(dest, mode | 0o111);
}

async function main() {
  clean();
  process.env.NEXUX_BUILD_TARGET = "native";
  buildWeb();
  purgeNextCaches();
  deployWeb();
  pruneNodeModules();
  copyBuiltAssets();
  copyMigrations();
  writeEntry();
  writeBuildInfo();
  dropNextConfigSource();
  dropEnvFiles();
  assertNextVersionParity();
  makeStaticPlaceholder();
  copyNodeBinary();
  log("Sidecar bundle complete");
}

main().catch((err) => {
  console.error("[build-sidecar] FAILED:", err);
  process.exit(1);
});
