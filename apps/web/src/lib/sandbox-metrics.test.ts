import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseDockerStats, parseSize } from "./sandbox-metrics";

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
