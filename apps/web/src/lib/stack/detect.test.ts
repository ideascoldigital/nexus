import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { detectRepo, parseMakeTargets } from "./detect";

/**
 * A real repo on disk: the lockfile rules are answered by git itself, so a
 * stubbed filesystem would be testing the stub. Returns the repo root.
 */
const makeRepo = (
  files: Record<string, string>,
  commit: string[],
): string => {
  const root = mkdtempSync(path.join(tmpdir(), "nexux-detect-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t.test");
  git("config", "user.name", "t");
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(root, name), body);
  }
  if (commit.length > 0) {
    git("add", "--", ...commit);
    git("commit", "-qm", "init");
  }
  return root;
};

const find = (makefile: string, name: string) => {
  const target = parseMakeTargets(makefile).find((t) => t.name === name);
  assert.ok(target, `expected target ${name}`);
  return target;
};

test("reads a target's recipe, not just its name", () => {
  const dev = find(
    ["dev:", "\tdocker compose up -d", "\tpnpm dev"].join("\n"),
    "dev"
  );
  assert.equal(dev.usesDocker, true);
  assert.equal(dev.detached, true);
});

test("a target with no docker in its recipe stays clean", () => {
  const dev = find(["dev:", "\tpnpm dev --port 3003"].join("\n"), "dev");
  assert.equal(dev.usesDocker, false);
  assert.equal(dev.detached, false);
  assert.deepEqual(dev.composeFiles, []);
});

test("collects compose files passed with -f and --file", () => {
  const up = find(
    [
      "up:",
      "\tdocker compose -f docker-compose.yml -f docker-compose.dev.yml up -d",
      "\tdocker compose --file infra/extra.yml up -d",
    ].join("\n"),
    "up"
  );
  assert.deepEqual(up.composeFiles, [
    "docker-compose.yml",
    "docker-compose.dev.yml",
    "infra/extra.yml",
  ]);
});

test("`-f` after the verb is the verb's own flag, not a compose file", () => {
  // `docker compose logs -f firebase` follows a service's log; there is no
  // file called firebase.
  const logs = find(["logs:", "\tdocker compose logs -f firebase"].join("\n"), "logs");
  assert.deepEqual(logs.composeFiles, []);
  assert.equal(logs.usesDocker, true);
});

test("a file before the verb is kept even when the verb takes -f too", () => {
  const logs = find(
    ["logs:", "\tdocker compose -f infra.yml logs -f api"].join("\n"),
    "logs"
  );
  assert.deepEqual(logs.composeFiles, ["infra.yml"]);
});

test("names the services a compose verb targets, skipping flags", () => {
  const up = find(
    ["up:", "\tdocker compose up -d --build postgres redis"].join("\n"),
    "up"
  );
  assert.deepEqual(up.composeServices, ["postgres", "redis"]);
});

test("a flag that consumes its value does not swallow a service", () => {
  const up = find(
    ["up:", "\tdocker compose up -d -f other.yml postgres"].join("\n"),
    "up"
  );
  assert.deepEqual(up.composeServices, ["postgres"]);
});

test("inherits docker from a prerequisite", () => {
  const makefile = [
    "up:",
    "\tdocker compose up -d postgres",
    "",
    "dev: up",
    "\tpnpm dev",
  ].join("\n");
  const dev = find(makefile, "dev");
  assert.equal(dev.usesDocker, true);
  assert.deepEqual(dev.prerequisites, ["up"]);
  assert.deepEqual(dev.composeServices, ["postgres"]);
  // The recipe itself blocks — a detached prerequisite does not change that.
  assert.equal(dev.detached, false);
});

test("cyclic prerequisites resolve instead of hanging", () => {
  const makefile = ["a: b", "\tdocker compose up -d", "", "b: a", "\techo hi"].join(
    "\n"
  );
  const targets = parseMakeTargets(makefile);
  assert.deepEqual(
    targets.map((t) => t.name),
    ["a", "b"]
  );
  assert.equal(find(makefile, "b").usesDocker, true);
});

test("flags teardown targets by name", () => {
  const makefile = [
    "docker-down:",
    "\tdocker compose down",
    "",
    "up:",
    "\tdocker compose up -d",
  ].join("\n");
  assert.equal(find(makefile, "docker-down").teardown, true);
  assert.equal(find(makefile, "up").teardown, false);
  // `down` returns immediately, so it counts as detached too.
  assert.equal(find(makefile, "docker-down").detached, true);
});

test("strips make's @ prefix and variable expansions", () => {
  const up = find(
    ["up:", "\t@$(DOCKER) compose -f $(COMPOSE_FILE) up -d"].join("\n"),
    "up"
  );
  assert.equal(up.usesDocker, true);
  assert.equal(up.detached, true);
  // `$(COMPOSE_FILE)` is unresolvable, so no file is claimed.
  assert.deepEqual(up.composeFiles, []);
});

test("a fully variable-driven compose call is still recognised", () => {
  // `$(DOCKER_COMPOSE) up -d postgres` expands to nothing but the verb.
  const up = find(["up:", "\t$(DOCKER_COMPOSE) up -d postgres"].join("\n"), "up");
  assert.equal(up.usesDocker, true);
  assert.equal(up.detached, true);
  assert.deepEqual(up.composeServices, ["postgres"]);
});

test("legacy docker-compose spelling counts as docker", () => {
  const up = find(["up:", "\tdocker-compose up -d db"].join("\n"), "up");
  assert.equal(up.usesDocker, true);
  assert.equal(up.detached, true);
  assert.deepEqual(up.composeServices, ["db"]);
});

test("skips pattern rules and variable assignments", () => {
  const makefile = [
    "CC := gcc",
    "COMPOSE = docker compose",
    "%.o: %.c",
    "\t$(CC) -c $<",
    "build:",
    "\tpnpm build",
  ].join("\n");
  assert.deepEqual(
    parseMakeTargets(makefile).map((t) => t.name),
    ["build"]
  );
});

test("a blank line inside a rule does not end its recipe", () => {
  const dev = find(
    ["dev:", "\techo start", "", "\tdocker compose up -d"].join("\n"),
    "dev"
  );
  assert.equal(dev.usesDocker, true);
});

test("an un-indented line ends the recipe", () => {
  const makefile = [
    "dev:",
    "\tpnpm dev",
    "OTHER = docker compose up",
    "build:",
    "\tpnpm build",
  ].join("\n");
  assert.equal(find(makefile, "dev").usesDocker, false);
  assert.equal(find(makefile, "build").usesDocker, false);
});

test("keeps prerequisites but ignores trailing comments", () => {
  const dev = find(["dev: up build # start everything", "\tpnpm dev"].join("\n"), "dev");
  assert.deepEqual(dev.prerequisites, ["up", "build"]);
});

test("a repeated target merges its prerequisites", () => {
  const makefile = ["dev: up", "\tpnpm dev", "", "dev: build"].join("\n");
  const targets = parseMakeTargets(makefile);
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].prerequisites, ["up", "build"]);
});

test("`docker run` counts as docker without being compose", () => {
  const psql = find(
    ["psql:", "\tdocker run --rm -it postgres:16 psql"].join("\n"),
    "psql"
  );
  assert.equal(psql.usesDocker, true);
  assert.deepEqual(psql.composeFiles, []);
  assert.deepEqual(psql.composeServices, []);
});

// --- package manager: only a committed lockfile speaks for the repo ---------

test("an uncommitted lockfile does not choose the package manager", async () => {
  // The exact shape a failed `pnpm dev` leaves in a bind-mounted sandbox: a
  // pnpm-lock.yaml no .gitignore mentions, sitting next to the real lockfile.
  const root = makeRepo(
    {
      "package.json": JSON.stringify({ scripts: { dev: "next dev" } }),
      "package-lock.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
    },
    ["package.json", "package-lock.json"],
  );
  try {
    const res = await detectRepo(root);
    assert.equal(res.packageManager, "npm");
    assert.equal(res.suggestedCommands.dev, "npm run dev");
    assert.ok(
      (res.notes ?? []).some((n) => n.includes("pnpm-lock.yaml")),
      "the stray lockfile should be called out, not silently dropped",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a committed lockfile still chooses the package manager", async () => {
  const root = makeRepo(
    {
      "package.json": JSON.stringify({ scripts: { dev: "next dev" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
    },
    ["package.json", "pnpm-lock.yaml"],
  );
  try {
    const res = await detectRepo(root);
    assert.equal(res.packageManager, "pnpm");
    assert.equal(res.suggestedCommands.dev, "pnpm dev");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outside a git repo a present lockfile is taken at face value", async () => {
  // Nothing can contradict the file here, so refusing it would leave every
  // non-git folder on npm.
  const root = mkdtempSync(path.join(tmpdir(), "nexux-detect-nogit-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    const res = await detectRepo(root);
    assert.equal(res.packageManager, "pnpm");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
