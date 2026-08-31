import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { expandHome } from "@nexux/storage";

import {
  nodePorts,
  portInCommand,
  resolveNodeDir,
  resolveScriptCommand,
} from "./node-runtime";

/** A throwaway repo directory; returned path is absolute. */
async function tmpRepo(pkg?: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "nexux-node-runtime-"));
  if (pkg !== undefined) {
    await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg), "utf8");
  }
  return dir;
}

test("no local path means there is nothing to resolve", () => {
  assert.equal(resolveNodeDir(null, "apps/web"), null);
  assert.equal(resolveNodeDir(undefined, null), null);
  assert.equal(resolveNodeDir("", null), null);
});

test("a workdir is joined onto the local path", () => {
  assert.equal(resolveNodeDir("/srv/app", "apps/web"), "/srv/app/apps/web");
});

test("no workdir leaves the local path as the directory", () => {
  assert.equal(resolveNodeDir("/srv/app", null), "/srv/app");
  assert.equal(resolveNodeDir("/srv/app", ""), "/srv/app");
});

test("a `~` local path is expanded to the configured home", () => {
  assert.equal(
    resolveNodeDir("~/code/app", null),
    path.resolve(expandHome("~/code/app"))
  );
});

test("the resolved directory is normalized", () => {
  assert.equal(resolveNodeDir("/srv/app/", "../other"), "/srv/other");
});

test("finds a port behind --port, -p or PORT=", () => {
  assert.equal(portInCommand("next dev --port 3003"), 3003);
  assert.equal(portInCommand("next dev --port=3000"), 3000);
  assert.equal(portInCommand("vite -p 8080"), 8080);
  assert.equal(portInCommand("PORT=4000 next dev"), 4000);
});

test("a command with no port yields null", () => {
  assert.equal(portInCommand("pnpm dev"), null);
  assert.equal(portInCommand(""), null);
});

test("a port needs at least two digits to count", () => {
  // Guards against reading `-p 8` out of unrelated single-digit flags.
  assert.equal(portInCommand("serve -p 8"), null);
  assert.equal(portInCommand("serve -p 80"), 80);
});

test("`-p` is only a port flag when it stands alone", () => {
  // `--preview 3000` must not be mistaken for `-p 3000`.
  assert.equal(portInCommand("astro --preview 3000"), null);
});

test("--port wins over a later PORT= in the same command", () => {
  // The regexes are tried in order, so the explicit flag is preferred.
  assert.equal(portInCommand("next dev --port 3003 # PORT=9999"), 3003);
});

test("declared ports are reported as the node's ports", () => {
  assert.deepEqual(
    nodePorts([{ host: 5432, container: 5432 }], null),
    [5432]
  );
});

test("a missing or malformed declaration contributes no ports", () => {
  assert.deepEqual(nodePorts(null, null), []);
  assert.deepEqual(nodePorts(undefined, null), []);
  assert.deepEqual(
    nodePorts([{ container: 80 }, { host: "80" }, { host: 0 }, null], null),
    []
  );
});

test("a port named in the local command is added to the declared ones", () => {
  assert.deepEqual(
    nodePorts([{ host: 5432, container: 5432 }], "next dev --port 3003"),
    [5432, 3003]
  );
});

test("the repo script supplies the port when the command hides it", () => {
  // `pnpm dev` is the common case: the port lives in the repo's own script.
  assert.deepEqual(nodePorts(null, "pnpm dev", "next dev --port 3003"), [3003]);
});

test("a port is never listed twice", () => {
  assert.deepEqual(
    nodePorts(
      [{ host: 3003, container: 3003 }],
      "next dev --port 3003",
      "next dev --port 3003"
    ),
    [3003]
  );
});

test("the local command's port takes precedence over the script's", () => {
  assert.deepEqual(
    nodePorts(null, "next dev --port 3003", "next dev --port 4000"),
    [3003, 4000]
  );
});

test("resolves what a package manager script expands to", async () => {
  const dir = await tmpRepo({ scripts: { dev: "next dev --port 3003" } });
  for (const command of [
    "pnpm dev",
    "pnpm run dev",
    "npm run dev",
    "yarn dev",
    "bun run dev",
  ]) {
    assert.equal(
      await resolveScriptCommand(command, dir),
      "next dev --port 3003",
      command
    );
  }
});

test("a scripts key with a colon or dash resolves", async () => {
  const dir = await tmpRepo({
    scripts: { "dev:web": "next dev", "start-all": "turbo dev" },
  });
  assert.equal(await resolveScriptCommand("pnpm dev:web", dir), "next dev");
  assert.equal(await resolveScriptCommand("pnpm start-all", dir), "turbo dev");
});

test("a script the repo does not define resolves to null", async () => {
  const dir = await tmpRepo({ scripts: { dev: "next dev" } });
  assert.equal(await resolveScriptCommand("pnpm missing", dir), null);
});

test("a command that is not a package manager invocation resolves to null", async () => {
  const dir = await tmpRepo({ scripts: { dev: "next dev" } });
  assert.equal(await resolveScriptCommand("next dev", dir), null);
  assert.equal(await resolveScriptCommand("docker compose up", dir), null);
});

test("a bare `run` names no script", async () => {
  const dir = await tmpRepo({ scripts: { run: "echo hi" } });
  assert.equal(await resolveScriptCommand("pnpm run", dir), null);
});

test("a missing command or cwd resolves to null", async () => {
  const dir = await tmpRepo({ scripts: { dev: "next dev" } });
  assert.equal(await resolveScriptCommand(null, dir), null);
  assert.equal(await resolveScriptCommand("pnpm dev", null), null);
});

test("an unreadable or absent package.json resolves to null", async () => {
  const empty = await tmpRepo();
  assert.equal(await resolveScriptCommand("pnpm dev", empty), null);
  assert.equal(
    await resolveScriptCommand("pnpm dev", path.join(empty, "nope")),
    null
  );
});

test("a package.json that is not valid json resolves to null", async () => {
  const dir = await tmpRepo();
  await writeFile(path.join(dir, "package.json"), "{ not json", "utf8");
  assert.equal(await resolveScriptCommand("pnpm dev", dir), null);
});

test("a package.json with no scripts block resolves to null", async () => {
  const dir = await tmpRepo({ name: "app" });
  assert.equal(await resolveScriptCommand("pnpm dev", dir), null);
});
