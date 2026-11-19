import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { DockerRunner } from "@/lib/host-endpoint";

import { checkEndpointForSandboxes, dnsAnswered, freeGbFromDf } from "./docker-endpoint";

const OK_PROBE = async () => ({ ok: true as const, serverVersion: "29", arch: "x86_64", memTotalMb: 32000, rootless: false });
const NS_OK = "Server:\t127.0.0.11\nName:\tgithub.com\nAddress: 140.82.112.3\n";
const NS_FAIL = ";; connection timed out; no servers could be reached\n";

/** A daemon where DNS works on the default bridge and, optionally, on user networks. */
function daemon(opts: { networkDns: boolean; freeKb?: number }) {
  const calls: string[][] = [];
  const run: DockerRunner = async (args) => {
    calls.push(args);
    const a = args.slice(2).join(" ");
    if (a.startsWith("network create") || a.startsWith("network rm")) return { code: 0, stdout: "", stderr: "" };
    if (a.includes("nslookup")) {
      const onNetwork = a.includes("--network");
      return { code: 0, stdout: onNetwork && !opts.networkDns ? NS_FAIL : NS_OK, stderr: "" };
    }
    if (a.startsWith("info")) return { code: 0, stdout: "/var/lib/docker\n", stderr: "" };
    if (a.includes(" df ")) {
      return { code: 0, stdout: `Filesystem 1K-blocks Used Available Use% Mounted\n/dev/sda 100 1 ${opts.freeKb ?? 200 * 1024 * 1024} 1% /r\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const line = (r: Awaited<ReturnType<typeof checkEndpointForSandboxes>>, label: string) =>
  r.checks.find((c) => c.label === label);

test("a healthy endpoint is ok, and everything it creates is removed", async () => {
  const d = daemon({ networkDns: true });
  const r = await checkEndpointForSandboxes("ssh://devbox", { run: d.run, probe: OK_PROBE });
  assert.equal(r.status, "ok");
  assert.equal(r.identity, "x86_64 · Docker 29");
  // Every container is --rm; the one network made is the one removed.
  for (const c of d.calls.filter((c) => c[2] === "run")) assert.ok(c.includes("--rm"), c.join(" "));
  const made = d.calls.find((c) => c[2] === "network" && c[3] === "create")![4];
  assert.ok(d.calls.some((c) => c[2] === "network" && c[3] === "rm" && c[4] === made));
  // The disk is looked at, never written.
  assert.ok(d.calls.some((c) => c.includes("/var/lib/docker:/r:ro")));
});

test("DNS that only the default bridge has — devbox's case — is named, with the fix", async () => {
  const r = await checkEndpointForSandboxes("ssh://devbox", { run: daemon({ networkDns: false }).run, probe: OK_PROBE });
  assert.equal(r.status, "warn");
  const dns = line(r, "DNS on a compose-style network");
  assert.equal(dns?.ok, false);
  assert.match(dns?.detail ?? "", /daemon\.json.*172\.17\.0\.1/);
});

test("low disk warns", async () => {
  const r = await checkEndpointForSandboxes("ssh://devbox", {
    run: daemon({ networkDns: true, freeKb: 3 * 1024 * 1024 }).run,
    probe: OK_PROBE,
  });
  assert.equal(r.status, "warn");
  assert.match(line(r, "disk space for Docker")?.detail ?? "", /3 GB free/);
});

test("an unreachable daemon fails before any container is started", async () => {
  const d = daemon({ networkDns: true });
  const r = await checkEndpointForSandboxes("ssh://devbox", {
    run: d.run,
    probe: async () => ({ ok: false as const, error: "The host didn't answer" }),
  });
  assert.equal(r.status, "fail");
  assert.equal(d.calls.length, 0);
});

test("parsers", () => {
  assert.equal(dnsAnswered(NS_OK), true);
  assert.equal(dnsAnswered(NS_FAIL), false);
  assert.equal(freeGbFromDf("Filesystem 1K-blocks Used Available Use% Mounted\n/dev/x 1 1 10485760 1% /r"), 10);
  // What busybox prints for an LVM root — the name on its own line (devbox).
  assert.equal(
    freeGbFromDf(
      "Filesystem           1K-blocks      Used Available Use% Mounted on\n/dev/mapper/devbox_root\n                     1608497152  88780196 1519146156   6% /r\n",
    ),
    1448.8,
  );
});
