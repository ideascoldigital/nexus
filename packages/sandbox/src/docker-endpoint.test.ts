import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  dockerHostArgs,
  explainProbeFailure,
  parseDockerHost,
  parseDockerInfo,
  probeDockerEndpoint,
  sshUrlParts,
} from "./docker-endpoint";

test("accepts ssh endpoints and normalises them", () => {
  assert.deepEqual(parseDockerHost("ssh://dev@workstation"), {
    ok: true,
    host: "ssh://dev@workstation",
  });
  assert.deepEqual(parseDockerHost("  ssh://dev@Box.tail1234.ts.net:2222/ "), {
    ok: true,
    host: "ssh://dev@box.tail1234.ts.net:2222",
  });
  // The user can come from ~/.ssh/config.
  assert.deepEqual(parseDockerHost("ssh://10.0.0.5"), { ok: true, host: "ssh://10.0.0.5" });
  assert.deepEqual(parseDockerHost("ssh://root@[fd7a:115c::1]:22"), {
    ok: true,
    host: "ssh://root@[fd7a:115c::1]:22",
  });
});

test("refuses tcp, and anything that could pose as a flag or break argv", () => {
  assert.deepEqual(parseDockerHost("tcp://box:2375"), { ok: false, error: "not-ssh" });
  assert.deepEqual(parseDockerHost("box"), { ok: false, error: "not-ssh" });
  assert.deepEqual(parseDockerHost(""), { ok: false, error: "empty" });
  for (const bad of [
    "ssh://-oProxyCommand=x@box",
    "ssh://user@-box",
    "ssh://us er@box",
    "ssh://user@box;rm",
    "ssh://user@box/path",
    "ssh://'user'@box",
    "ssh://user@",
  ]) {
    assert.deepEqual(parseDockerHost(bad), { ok: false, error: "malformed" }, bad);
  }
  assert.deepEqual(parseDockerHost("ssh://u@box:0"), { ok: false, error: "bad-port" });
  assert.deepEqual(parseDockerHost("ssh://u@box:70000"), { ok: false, error: "bad-port" });
});

test("dockerHostArgs is empty for the default daemon and -H otherwise", () => {
  assert.deepEqual(dockerHostArgs(null), []);
  assert.deepEqual(dockerHostArgs({ host: null }), []);
  assert.deepEqual(dockerHostArgs({ host: "ssh://u@box" }), ["-H", "ssh://u@box"]);
  // A bad row must never reach argv, even though the API validates on write.
  assert.throws(() => dockerHostArgs({ host: "tcp://box:2375" }), /Refusing docker host/);
});

const INFO = {
  ServerVersion: "27.3.1",
  Architecture: "x86_64",
  MemTotal: 16 * 1024 * 1024 * 1024,
  SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"],
};

test("reads version, arch, memory and rootless out of docker info", () => {
  assert.deepEqual(parseDockerInfo(JSON.stringify(INFO)), {
    serverVersion: "27.3.1",
    arch: "x86_64",
    memTotalMb: 16384,
    rootless: false,
  });
  const rootless = { ...INFO, SecurityOptions: ["name=seccomp", "name=rootless"] };
  assert.equal(parseDockerInfo(JSON.stringify(rootless))?.rootless, true);
  assert.equal(parseDockerInfo("not json"), null);
  assert.deepEqual(parseDockerInfo("{}"), {
    serverVersion: null,
    arch: null,
    memTotalMb: null,
    rootless: false,
  });
});

test("probe failures carry a hint and the raw stderr", () => {
  const msg = explainProbeFailure(
    "error during connect: permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
  );
  assert.match(msg, /docker group/);
  assert.match(msg, /permission denied while trying/);
  assert.match(explainProbeFailure("dev@box: Permission denied (publickey)."), /authorized_keys/);
  const changed = explainProbeFailure(
    "Offending ECDSA key in /Users/me/.ssh/known_hosts:7\r\nHost key for 192.168.1.35 has changed and you have requested strict checking.\r\nHost key verification failed.",
  );
  assert.match(changed, /host key changed/);
  assert.doesNotMatch(changed, /isn't trusted yet/);
  assert.match(
    explainProbeFailure("Host key verification failed."),
    /isn't trusted yet/,
  );
  // Unknown failures still say what happened.
  assert.equal(explainProbeFailure("something odd"), "something odd");
  assert.match(explainProbeFailure(""), /without saying why/);
});

const runnerReturning =
  (res: { code: number; stdout?: string; stderr?: string }, seen?: string[][]) =>
  async (_bin: string, args: string[]) => {
    seen?.push(args);
    return { stdout: "", stderr: "", ...res };
  };

test("a healthy endpoint probes ok with one docker info over -H", async () => {
  const seen: string[][] = [];
  const res = await probeDockerEndpoint("ssh://u@box", {
    runner: runnerReturning({ code: 0, stdout: JSON.stringify(INFO) }, seen),
  });
  assert.deepEqual(res, {
    ok: true,
    serverVersion: "27.3.1",
    arch: "x86_64",
    memTotalMb: 16384,
    rootless: false,
  });
  assert.deepEqual(seen, [["-H", "ssh://u@box", "info", "--format", "{{json .}}"]]);
});

test("the probe refuses rootless daemons, bad hosts and missing daemons", async () => {
  const rootless = await probeDockerEndpoint("ssh://u@box", {
    runner: runnerReturning({
      code: 0,
      stdout: JSON.stringify({ ...INFO, SecurityOptions: ["name=rootless"] }),
    }),
  });
  assert.equal(rootless.ok, false);
  assert.match(!rootless.ok ? rootless.error : "", /rootless/);

  let ran = false;
  const bad = await probeDockerEndpoint("tcp://box:2375", {
    runner: async () => {
      ran = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(bad.ok, false);
  assert.equal(ran, false, "an invalid host never reaches docker");

  const noDaemon = await probeDockerEndpoint("ssh://u@box", {
    runner: runnerReturning({
      code: 0,
      stdout: JSON.stringify({ ServerVersion: "" }),
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    }),
  });
  assert.equal(noDaemon.ok, false);
  assert.match(!noDaemon.ok ? noDaemon.error : "", /daemon isn't running/);

  const failed = await probeDockerEndpoint("ssh://u@box", {
    runner: runnerReturning({ code: 1, stderr: "ssh: Could not resolve hostname box" }),
  });
  assert.match(!failed.ok ? failed.error : "", /doesn't resolve/);
});

test("a missing docker CLI on this machine is named as such", async () => {
  const res = await probeDockerEndpoint("ssh://u@box", {
    runner: async () => {
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    },
  });
  assert.match(!res.ok ? res.error : "", /docker CLI isn't installed on this machine/);
});

test("sshUrlParts takes an endpoint host apart for ssh itself", () => {
  assert.deepEqual(sshUrlParts("ssh://devbox"), { user: null, hostname: "devbox", port: null });
  assert.deepEqual(sshUrlParts("ssh://dev@box:2222"), { user: "dev", hostname: "box", port: 2222 });
  assert.deepEqual(sshUrlParts("ssh://root@[fd7a::1]"), { user: "root", hostname: "fd7a::1", port: null });
  assert.equal(sshUrlParts("tcp://box:2375"), null);
});
