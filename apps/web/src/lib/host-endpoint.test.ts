import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

import {
  endpointComposeArgs,
  endpointHostProject,
  parseTailscaleDnsName,
  provisionEndpointHost,
  renderEndpointEnv,
  type DockerRunner,
  type EndpointHostSpec,
} from "./host-endpoint";

const AUTH_KEY = "tskey-auth-SECRET123";
const REG_PASSWORD = "ghp_SECRETTOKEN";

let workDir: string;
beforeEach(() => {
  workDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nexux-host-ep-")), "host");
});
afterEach(() => {
  fs.rmSync(path.dirname(workDir), { recursive: true, force: true });
});

const spec = (over: Partial<EndpointHostSpec> = {}): EndpointHostSpec => ({
  name: "home",
  imageRef: "ghcr.io/o/nexus:edge",
  dockerHost: "ssh://omarchy",
  workDir,
  tailscaleAuthKey: AUTH_KEY,
  registry: null,
  pullEmbeddingModel: false,
  ...over,
});

/**
 * A docker that answers the provisioning flow. `tailscaleAfter` / `appAfter`
 * are how many polls fail before each comes up; Infinity never does.
 */
function fakeDocker(opts: { tailscaleAfter?: number; appAfter?: number } = {}) {
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv; input?: string }> = [];
  let tsPolls = 0;
  let appPolls = 0;
  const run: DockerRunner = async (args, o = {}) => {
    calls.push({ args, env: o.env, input: o.input });
    const joined = args.join(" ");
    if (joined.includes("tailscale ip -4")) {
      return tsPolls++ >= (opts.tailscaleAfter ?? 0)
        ? { code: 0, stdout: "100.64.0.7\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "not running" };
    }
    if (joined.includes("node -e")) {
      return appPolls++ >= (opts.appAfter ?? 0)
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    }
    if (joined.includes("tailscale status --json")) {
      return { code: 0, stdout: JSON.stringify({ Self: { DNSName: "home.tail1234.ts.net." } }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const io = (run: DockerRunner) => {
  const updates: Array<Record<string, unknown>> = [];
  let log = "";
  return {
    updates,
    log: () => log,
    io: {
      log: (c: string) => void (log += c),
      update: async (d: Record<string, unknown>) => void updates.push(d),
      run,
      sleep: async () => undefined,
    },
  };
};

test("the stack comes up in order: pull, tailscale, then the app on its tailnet origin", async () => {
  const docker = fakeDocker({ tailscaleAfter: 2, appAfter: 1 });
  const h = io(docker.run);
  await provisionEndpointHost(spec(), h.io);

  const steps = docker.calls
    .map((c) => c.args.slice(c.args.indexOf("--env-file") + 2).join(" "))
    .filter((s) => /^(pull|up)/.test(s));
  assert.deepEqual(steps, ["pull", "up -d tailscale", "up -d"]);

  // Every call went to the endpoint's daemon, under the host's project.
  for (const c of docker.calls) {
    assert.deepEqual(c.args.slice(0, 2), ["-H", "ssh://omarchy"]);
  }
  assert.ok(docker.calls.every((c) => c.args.includes(endpointHostProject("home"))));

  // The app started only once the origin was the tailnet address.
  const env = fs.readFileSync(path.join(workDir, ".env"), "utf8");
  assert.match(env, /NEXUX_WEB_ORIGIN='http:\/\/100\.64\.0\.7:3030'/);
  assert.equal(fs.statSync(path.join(workDir, ".env")).mode & 0o777, 0o600);

  assert.deepEqual(h.updates.at(-1), {
    status: "running",
    tailscaleIp: "100.64.0.7",
    tailscaleName: "home.tail1234.ts.net",
  });
});

test("secrets never reach argv or the compose file", async () => {
  const docker = fakeDocker();
  const h = io(docker.run);
  await provisionEndpointHost(
    spec({ registry: { host: "ghcr.io", username: "octo", password: REG_PASSWORD } }),
    h.io,
  );
  for (const c of docker.calls) {
    const argv = c.args.join(" ");
    assert.ok(!argv.includes(AUTH_KEY) && !argv.includes(REG_PASSWORD), argv);
  }
  // The registry password goes in on stdin, to a login in a throwaway config.
  const login = docker.calls.find((c) => c.args.includes("login"))!;
  assert.equal(login.input, REG_PASSWORD);
  assert.ok(login.env?.DOCKER_CONFIG?.includes("nexux-docker-config-"));
  // …and the pull used that same config; the user's own was never involved.
  const pull = docker.calls.find((c) => c.args.at(-1) === "pull")!;
  assert.equal(pull.env?.DOCKER_CONFIG, login.env?.DOCKER_CONFIG);
  assert.equal(fs.existsSync(login.env!.DOCKER_CONFIG!), false, "temp config removed");

  const compose = fs.readFileSync(path.join(workDir, "compose.yml"), "utf8");
  assert.ok(!compose.includes(AUTH_KEY));
});

test("a tailnet that never answers fails naming the auth key, before the app starts", async () => {
  const docker = fakeDocker({ tailscaleAfter: Infinity });
  const h = io(docker.run);
  await assert.rejects(provisionEndpointHost(spec(), h.io), /auth key is valid/);
  assert.ok(!docker.calls.some((c) => c.args.join(" ").endsWith("up -d")), "app never started");
  assert.ok(docker.calls.some((c) => c.args.includes("logs")), "its log was captured");
});

test("an app that never answers fails with its log", async () => {
  const docker = fakeDocker({ appAfter: Infinity });
  const h = io(docker.run);
  await assert.rejects(provisionEndpointHost(spec(), h.io), /did not answer/);
  assert.ok(docker.calls.some((c) => c.args.includes("logs") && c.args.includes("nexux")));
});

test("a self-hosted control plane goes to tailscale as --login-server", async () => {
  const docker = fakeDocker();
  await provisionEndpointHost(
    spec({ tailscaleLoginServer: "https://vpn.example.com/" }),
    io(docker.run).io,
  );
  const env = fs.readFileSync(path.join(workDir, ".env"), "utf8");
  assert.match(env, /TS_EXTRA_ARGS='--login-server=https:\/\/vpn\.example\.com'/);
});

test("helpers", () => {
  assert.deepEqual(
    endpointComposeArgs({ dockerHost: "ssh://omarchy", project: "p", workDir: "/w" }).slice(0, 5),
    ["-H", "ssh://omarchy", "compose", "-p", "p"],
  );
  assert.throws(() => renderEndpointEnv({ X: "a'b" }), /quote or newline/);
  assert.equal(parseTailscaleDnsName("{}"), null);
  assert.equal(parseTailscaleDnsName("nope"), null);
});
