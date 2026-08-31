import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

// Env setup must stay above ./sandbox-manager — it reaches prisma at import
// time and the client is built when the module loads.
import { testDbDir } from "./sandbox-manager.test-setup";
import { resolveSandboxName, staleRunningSandboxIds } from "./sandbox-manager";

after(() => {
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const up = async () => true;
const down = async () => false;
const dockerUp = async () => true;

const sandbox = (id: string, over: Partial<{ instanceId: string | null }> = {}) => ({
  id,
  name: `nexux-${id}`,
  instanceId: null,
  ...over,
});

test("a container that is still running is left alone", async () => {
  const stale = await staleRunningSandboxIds([sandbox("a")], {
    dockerAvailable: dockerUp,
    containerRunning: up,
  });
  assert.deepEqual(stale, []);
});

test("a container that has exited is reported stale", async () => {
  const stale = await staleRunningSandboxIds([sandbox("a")], {
    dockerAvailable: dockerUp,
    containerRunning: down,
  });
  assert.deepEqual(stale, ["a"]);
});

test("only the dead containers are reported", async () => {
  const stale = await staleRunningSandboxIds(
    [sandbox("alive"), sandbox("dead"), sandbox("alive2")],
    {
      dockerAvailable: dockerUp,
      containerRunning: async (c) => !c.includes("dead"),
    },
  );
  assert.deepEqual(stale, ["dead"]);
});

test("nothing is stale when Docker itself is unreachable", async () => {
  // Otherwise stopping Docker Desktop would mark every sandbox paused.
  const stale = await staleRunningSandboxIds([sandbox("a"), sandbox("b")], {
    dockerAvailable: async () => false,
    containerRunning: down,
  });
  assert.deepEqual(stale, []);
});

test("the probe is asked about instanceId when present, else the name", async () => {
  const asked: string[] = [];
  await staleRunningSandboxIds(
    [sandbox("a", { instanceId: "container-xyz" }), sandbox("b")],
    {
      dockerAvailable: dockerUp,
      containerRunning: async (c) => {
        asked.push(c);
        return true;
      },
    },
  );
  assert.deepEqual(asked.sort(), ["container-xyz", "nexux-b"]);
});

test("a probe that throws leaves the sandbox alone", async () => {
  // An erroring probe says nothing about the container — only a definite
  // "not running" should downgrade a row.
  const stale = await staleRunningSandboxIds([sandbox("a")], {
    dockerAvailable: dockerUp,
    containerRunning: async () => {
      throw new Error("docker daemon hiccup");
    },
  });
  assert.deepEqual(stale, []);
});

test("an empty candidate list never probes Docker", async () => {
  let probed = false;
  const stale = await staleRunningSandboxIds([], {
    dockerAvailable: async () => {
      probed = true;
      return true;
    },
    containerRunning: down,
  });
  assert.deepEqual(stale, []);
  assert.equal(probed, false);
});


// --- naming a sandbox -------------------------------------------------------

const free = {
  heldBy: async () => null,
  containerExists: async () => false,
};

test("no name given falls back to the generated one", async () => {
  const name = await resolveSandboxName(
    "landing",
    "abc123def",
    undefined,
    "local",
    undefined,
    free,
  );
  assert.match(name, /^nexux-landing-/);
  // Blank is the same intent — a cleared input posts an empty string.
  assert.match(
    await resolveSandboxName("landing", "abc123def", "   ", "local", undefined, free),
    /^nexux-landing-/,
  );
});

test("the generated name carries the workspace's prefix", async () => {
  const name = await resolveSandboxName(
    "landing",
    "abc123def",
    undefined,
    "local",
    "dev-",
    free,
  );
  assert.equal(name, "dev-landing-abc123");
});

test("a chosen name is used verbatim — prefix included, no id suffix", async () => {
  const name = await resolveSandboxName(
    "landing",
    "abc123def",
    "reviews",
    "local",
    "dev-",
    free,
  );
  // The configured prefix names *generated* machines; choosing a name means
  // choosing all of it, which is the whole point of the field.
  assert.equal(name, "reviews");
});

test("a name held by a live sandbox is refused, and says by whom", async () => {
  await assert.rejects(
    () =>
      resolveSandboxName("landing", "id", "reviews", "local", undefined, {
        ...free,
        heldBy: async (n) => (n === "reviews" ? "admin" : null),
      }),
    /already used by a sandbox in admin/,
  );
});

test("a container on the host counts, even with no row of ours", async () => {
  // A destroy that half-failed leaves the container behind; a DB-only check
  // would pass and `docker run` would then fail with a name conflict.
  await assert.rejects(
    () =>
      resolveSandboxName("landing", "id", "reviews", "local", undefined, {
        ...free,
        containerExists: async () => true,
      }),
    /docker container called "reviews" already exists/,
  );
});

test("the host check is skipped for cloud sandboxes", async () => {
  // Docker on this machine says nothing about a name on Civo, and asking
  // would refuse a perfectly free cloud name.
  let asked = false;
  const name = await resolveSandboxName("landing", "id", "reviews", "civo", undefined, {
    ...free,
    containerExists: async () => {
      asked = true;
      return true;
    },
  });
  assert.equal(name, "reviews");
  assert.equal(asked, false);
});

test("an unusable name is refused before anything is looked up", async () => {
  await assert.rejects(
    () => resolveSandboxName("landing", "id", "!!!", "local", undefined, free),
    /no letters or digits/,
  );
  await assert.rejects(
    () =>
      resolveSandboxName("landing", "id", "x".repeat(200), "local", undefined, free),
    /too long/,
  );
});
