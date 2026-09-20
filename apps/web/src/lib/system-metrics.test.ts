import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  loadPercent,
  parseDf,
  parseMemoryPressure,
  parseNvidiaSmi,
} from "./system-metrics";

// --- memory_pressure ---------------------------------------------------------
// macOS only. os.freemem() reports ~1% free on a perfectly healthy Mac because
// it counts cached and compressed pages as used, which would paint the bar red
// and keep it there. This is the number Activity Monitor agrees with.

test("the free percentage becomes a used percentage", () => {
  const stdout = `Pageouts: 44977

System-wide memory free percentage: 67%
`;
  assert.equal(parseMemoryPressure(stdout), 33);
});

test("memory pressure that cannot be read reports nothing, not zero", () => {
  // A metric missing and a metric at 0% are different facts, and a bar that
  // renders "0%" for "I could not tell" is worse than one that renders "—".
  assert.equal(parseMemoryPressure(""), null);
  assert.equal(parseMemoryPressure("command not found"), null);
  assert.equal(parseMemoryPressure("free percentage: notanumber%"), null);
  // Out of range means the format changed under us; refuse rather than show it.
  assert.equal(parseMemoryPressure("free percentage: 140%"), null);
});

// --- df ----------------------------------------------------------------------

test("the used percentage comes off the capacity field, not a column index", () => {
  // macOS: nine columns, including two inode fields Linux does not print.
  const darwin =
    "Filesystem   1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on\n" +
    "/dev/disk3s1   971350180 907074780  38455640      96% 10765927  384556400    3%   /System/Volumes/Data";
  const mac = parseDf(darwin);
  assert.equal(mac?.usedPercent, 96);
  assert.equal(mac?.mount, "/System/Volumes/Data");
  assert.equal(mac?.totalBytes, 971350180 * 1024);

  // Linux: six columns. The same parser has to read both.
  const linux =
    "Filesystem     1K-blocks     Used Available Use% Mounted on\n" +
    "/dev/root       40470732 38350412    145320 100% /";
  const host = parseDf(linux);
  assert.equal(host?.usedPercent, 100);
  assert.equal(host?.mount, "/");
});

test("a df that printed nothing usable reports nothing", () => {
  assert.equal(parseDf(""), null);
  assert.equal(parseDf("Filesystem 1K-blocks Used Available Use% Mounted on"), null);
  assert.equal(parseDf("df: .: No such file or directory"), null);
});

// --- nvidia-smi --------------------------------------------------------------
// Absent on macOS and on most Linux hosts. Absence is the normal case and must
// not read as a failure.

test("the first card's utilisation is what the bar shows", () => {
  const stdout = "NVIDIA GeForce RTX 4090, 42, 3096, 24564\n";
  const gpu = parseNvidiaSmi(stdout);
  assert.equal(gpu?.usedPercent, 42);
  assert.equal(gpu?.detail, "NVIDIA GeForce RTX 4090");
  assert.equal(gpu?.totalBytes, 24564 * 1024 * 1024);
});

test("a second card does not confuse the first", () => {
  const stdout = "NVIDIA A100, 91, 40000, 40960\nNVIDIA A100, 3, 100, 40960\n";
  assert.equal(parseNvidiaSmi(stdout)?.usedPercent, 91);
});

test("no GPU is not an error", () => {
  assert.equal(parseNvidiaSmi(""), null);
  assert.equal(parseNvidiaSmi("command not found"), null);
  // A truncated line is not half a reading.
  assert.equal(parseNvidiaSmi("NVIDIA A100, 91"), null);
});

// --- load --------------------------------------------------------------------

test("load is scaled by core count, because 4.0 means nothing on its own", () => {
  // The same load average is idle on a 16-core box and saturated on a 2-core.
  assert.equal(loadPercent(8, 16), 50);
  assert.equal(loadPercent(8, 8), 100);
  assert.equal(loadPercent(1, 4), 25);
});

test("load above capacity is clamped, since it is a queue and not a percentage", () => {
  // A load of 32 on 8 cores is real and means "badly oversubscribed"; a bar
  // that renders 400% is a broken bar.
  assert.equal(loadPercent(32, 8), 100);
});

test("a machine that cannot report cores reports no CPU figure", () => {
  assert.equal(loadPercent(1, 0), null);
  assert.equal(loadPercent(Number.NaN, 8), null);
});
