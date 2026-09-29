import { strict as assert } from "node:assert";
import { test } from "node:test";

import { collectSandboxMetrics, parseDockerStats, parseSize } from "./sandbox-metrics";

// --- parseSize ---------------------------------------------------------------
// docker stats prints human sizes, and the two families differ by 2.4% at GiB
// — enough to show a sandbox over its limit when it is not.

test("binary and decimal units are not the same number", () => {
  assert.equal(parseSize("1KiB"), 1024);
  assert.equal(parseSize("1kB"), 1000);
  assert.equal(parseSize("10.44GiB"), Math.round(10.44 * 1024 ** 3));
  assert.equal(parseSize("419.8MiB"), Math.round(419.8 * 1024 ** 2));
});

test("a size with spaces around it still parses", () => {
  // The field arrives from splitting "419.8MiB / 10.44GiB" on "/".
  assert.equal(parseSize(" 10.44GiB "), Math.round(10.44 * 1024 ** 3));
});

test("something that is not a size reports nothing", () => {
  assert.equal(parseSize(""), null);
  assert.equal(parseSize("--"), null);
  assert.equal(parseSize("12 parsecs"), null);
});

// --- parseDockerStats --------------------------------------------------------

test("a stats line becomes one sandbox's numbers", () => {
  const stdout =
    "nexux-browser-demo-43a952|0.42%|419.8MiB / 10.44GiB|3.93%\n";
  const [row] = parseDockerStats(stdout);
  assert.equal(row.name, "nexux-browser-demo-43a952");
  assert.equal(row.cpuPercent, 0.4);
  assert.equal(row.memPercent, 3.9);
  assert.equal(row.memUsedBytes, Math.round(419.8 * 1024 ** 2));
  assert.equal(row.memLimitBytes, Math.round(10.44 * 1024 ** 3));
});

test("the separator is a pipe because MemUsage contains spaces", () => {
  // "419.8MiB / 10.44GiB" splits into three fields on whitespace, which is why
  // the format string cannot use the default table output.
  const stdout = "a|1.00%|1MiB / 2MiB|50.00%\nb|2.00%|2MiB / 4MiB|50.00%\n";
  const rows = parseDockerStats(stdout);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.name),
    ["a", "b"],
  );
});

test("no running sandboxes is an empty list, not a failure", () => {
  assert.deepEqual(parseDockerStats(""), []);
  assert.deepEqual(parseDockerStats("\n\n"), []);
});

test("a row docker could not measure keeps its name", () => {
  // docker prints "--" for a container that is starting or gone. Dropping the
  // row would make the sandbox vanish from the list; keeping it with null
  // metrics says "here, but not measurable".
  const [row] = parseDockerStats("starting-box|--|-- / --|--\n");
  assert.equal(row.name, "starting-box");
  assert.equal(row.cpuPercent, null);
  assert.equal(row.memUsedBytes, null);
});

// --- several daemons (spec 26) ----------------------------------------------

/** A fake docker: answers per -H host, and records every argv it was given. */
function fakeDocker(byHost: Record<string, { ps: string; stats: string } | "down">) {
  const calls: string[][] = [];
  const run = async (_bin: string, args: string[]) => {
    calls.push(args);
    const host = args[0] === "-H" ? args[1] : "local";
    const rest = args[0] === "-H" ? args.slice(2) : args;
    const d = byHost[host];
    if (!d || d === "down") throw new Error("Cannot connect to the Docker daemon");
    if (rest[0] === "ps") return { stdout: d.ps };
    if (rest[0] === "stats") return { stdout: d.stats };
    return { stdout: "" };
  };
  return { run, calls };
}

test("each daemon's sandboxes are measured through that daemon and labelled with it", async () => {
  const docker = fakeDocker({
    local: { ps: "nexux-a\n", stats: "nexux-a|1.00%|100MiB / 1GiB|10.00%\n" },
    "ssh://devbox": { ps: "nexux-b\n", stats: "nexux-b|50.00%|2GiB / 21GiB|9.50%\n" },
  });
  const res = await collectSandboxMetrics({
    endpoints: [{ endpointId: "ep1", name: "devbox", host: "ssh://devbox" }],
    run: docker.run,
  });
  assert.deepEqual(
    res.sandboxes.map((s) => [s.name, s.endpointId, s.cpuPercent]),
    [
      ["nexux-a", null, 1],
      ["nexux-b", "ep1", 50],
    ],
  );
  // The remote's stats were asked of the remote, never of this machine.
  assert.ok(
    docker.calls.some((c) => c[0] === "-H" && c[1] === "ssh://devbox" && c[2] === "stats"),
  );
  assert.deepEqual(res.daemons, [
    { endpointId: null, name: "This machine", reachable: true },
    { endpointId: "ep1", name: "devbox", reachable: true },
  ]);
});

test("a daemon that does not answer is reported unreachable, and the others still show", async () => {
  const docker = fakeDocker({
    local: { ps: "nexux-a\n", stats: "nexux-a|1.00%|100MiB / 1GiB|10.00%\n" },
    "ssh://devbox": "down",
  });
  const res = await collectSandboxMetrics({
    endpoints: [{ endpointId: "ep1", name: "devbox", host: "ssh://devbox" }],
    run: docker.run,
  });
  assert.deepEqual(res.sandboxes.map((s) => s.name), ["nexux-a"]);
  // "devbox has no sandboxes" and "devbox did not answer" are different
  // facts; only the second is true here.
  assert.equal(res.daemons[1].reachable, false);
});

test("a daemon with no sandboxes is reachable and empty", async () => {
  const docker = fakeDocker({ local: { ps: "", stats: "" } });
  const res = await collectSandboxMetrics({ run: docker.run });
  assert.deepEqual(res, {
    sandboxes: [],
    daemons: [{ endpointId: null, name: "This machine", reachable: true }],
  });
});
