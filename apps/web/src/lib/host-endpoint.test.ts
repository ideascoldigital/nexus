import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

import {
  destroyEndpointHost,
  endpointComposeArgs,
  updateEndpointHost,
  endpointHostProject,
  parseTailscaleDnsName,
  provisionEndpointHost,
  renderEndpointEnv,
  syncUpdaterConfig,
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
  const composeCalls = docker.calls.filter((c) => c.args.includes("compose"));
  assert.ok(composeCalls.every((c) => c.args.includes(endpointHostProject("home"))));

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

// --- update and destroy (phase 3) -------------------------------------------

/** A docker for update: `images` answers `before` then `after`. */
function updateDocker(before: string, after: string, fail?: "pull" | "up") {
  const calls: string[][] = [];
  let images = 0;
  const run: DockerRunner = async (args) => {
    calls.push(args);
    const verb = args.slice(args.indexOf("--env-file") + 2)[0];
    if (verb === "images") return { code: 0, stdout: `${images++ === 0 ? before : after}\n`, stderr: "" };
    if (verb === fail) return { code: 1, stdout: "", stderr: `${fail} broke` };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const writeEnv = () => {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, ".env"), "TS_AUTHKEY='x'\n");
};

test("update pulls and recreates, never takes the stack down, and says whether anything changed", async () => {
  writeEnv();
  const docker = updateDocker("sha256:old", "sha256:new");
  const res = await updateEndpointHost(
    { name: "home", imageRef: "ghcr.io/o/nexus:edge", dockerHost: "ssh://omarchy", workDir, registry: null },
    docker.run,
  );
  assert.equal(res.ok, true);
  assert.equal(res.updated, true);
  const verbs = docker.calls
    .filter((c) => c.includes("compose"))
    .map((c) => c.slice(c.indexOf("--env-file") + 2).join(" "));
  assert.deepEqual(verbs, ["images --quiet nexux", "pull", "up -d", "images --quiet nexux"]);
  // …and the updater's copy is refreshed after the restart.
  assert.ok(docker.calls.some((c) => c.includes("exec") && c.includes("nexus-host-home-updater-1")));
  assert.ok(!verbs.some((v) => v.startsWith("down")), "volumes must survive an update");
  // The compose file is re-rendered, so template changes reach old hosts.
  assert.ok(fs.readFileSync(path.join(workDir, "compose.yml"), "utf8").includes("network_mode: service:tailscale"));

  const same = await updateEndpointHost(
    { name: "home", imageRef: "ghcr.io/o/nexus:edge", dockerHost: "ssh://omarchy", workDir, registry: null },
    updateDocker("sha256:a", "sha256:a").run,
  );
  assert.equal(same.updated, false);
  assert.match(same.message, /Already up to date/);
});

test("a failed pull leaves the old image running and says so", async () => {
  writeEnv();
  const docker = updateDocker("a", "a", "pull");
  const res = await updateEndpointHost(
    { name: "home", imageRef: "x/y:z", dockerHost: "ssh://omarchy", workDir, registry: null },
    docker.run,
  );
  assert.equal(res.ok, false);
  assert.match(res.message, /still running the old image/);
  assert.ok(!docker.calls.some((c) => c.includes("up")), "nothing restarted");
});

test("an update without the host's local settings is refused, not guessed", async () => {
  const res = await updateEndpointHost(
    { name: "home", imageRef: "x/y:z", dockerHost: "ssh://omarchy", workDir, registry: null },
    updateDocker("a", "b").run,
  );
  assert.equal(res.ok, false);
  assert.match(res.message, /settings are missing/);
});

test("destroy removes the stack with its volumes, then the files here", async () => {
  writeEnv();
  fs.writeFileSync(path.join(workDir, "compose.yml"), "services: {}\n");
  const calls: string[][] = [];
  await destroyEndpointHost(
    { name: "home", dockerHost: "ssh://omarchy", workDir },
    { log: () => undefined, run: async (a) => (calls.push(a), { code: 0, stdout: "", stderr: "" }) },
  );
  assert.deepEqual(calls[0].slice(0, 2), ["-H", "ssh://omarchy"]);
  assert.deepEqual(calls[0].slice(-3), ["down", "--volumes", "--remove-orphans"]);
  assert.equal(fs.existsSync(workDir), false);
});

test("destroy works from the project name alone when the local files are gone", async () => {
  const calls: string[][] = [];
  await destroyEndpointHost(
    { name: "home", dockerHost: "ssh://omarchy", workDir },
    { log: () => undefined, run: async (a) => (calls.push(a), { code: 0, stdout: "", stderr: "" }) },
  );
  assert.deepEqual(calls[0], [
    "-H", "ssh://omarchy", "compose", "-p", "nexus-host-home", "down", "--volumes", "--remove-orphans",
  ]);
});

test("a destroy the endpoint refuses keeps the local files and says why", async () => {
  writeEnv();
  await assert.rejects(
    destroyEndpointHost(
      { name: "home", dockerHost: "ssh://omarchy", workDir },
      { log: () => undefined, run: async () => ({ code: 1, stdout: "", stderr: "Cannot connect" }) },
    ),
    /Could not remove the stack.*Cannot connect/,
  );
  assert.equal(fs.existsSync(path.join(workDir, ".env")), true);
});

test("the updater gets its config on stdin, secrets never in argv, update.sh last", async () => {
  const docker = fakeDocker();
  await provisionEndpointHost(
    spec({ registry: { host: "ghcr.io", username: "octo", password: REG_PASSWORD } }),
    io(docker.run).io,
  );
  const writes = docker.calls.filter((c) => c.args.includes("exec") && c.args.includes("-i"));
  const files = writes.map((w) => w.args.at(-1)!.split("cat > /config/")[1]);
  assert.deepEqual(files, ["compose.yml", ".env", "docker/config.json", "update.sh"]);
  for (const w of writes) {
    assert.deepEqual(w.args.slice(0, 2), ["-H", "ssh://omarchy"]);
    assert.ok(w.args.includes("nexus-host-home-updater-1"));
    const argv = w.args.join(" ");
    assert.ok(!argv.includes(AUTH_KEY) && !argv.includes(REG_PASSWORD), argv);
  }
  const env = writes.find((w) => w.args.at(-1)!.endsWith("/config/.env"))!;
  assert.match(env.input ?? "", new RegExp(AUTH_KEY));
  const login = JSON.parse(writes.find((w) => w.args.at(-1)!.endsWith("config.json"))!.input!);
  assert.equal(
    Buffer.from(login.auths["ghcr.io"].auth, "base64").toString(),
    `octo:${REG_PASSWORD}`,
  );
});

// The updater parses its script once, at start: a new update.sh on disk does
// nothing until it restarts. Found when a channel switch was ignored by an
// updater still looping on the script it started with ten hours earlier.
test("the updater is restarted when its script changed, and only then", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-"));
  fs.writeFileSync(path.join(dir, "compose.yml"), "services: {}\n");
  fs.writeFileSync(path.join(dir, ".env"), "X=1\n");
  const { renderEndpointUpdater } = await import("@nexux/sandbox");
  const current = renderEndpointUpdater("nexus-host-home");
  const scenario = async (catResult: { code: number; stdout: string }) => {
    const calls: string[][] = [];
    await syncUpdaterConfig(
      { project: "nexus-host-home", dockerHost: "ssh://omarchy", workDir: dir, registry: null },
      async (args) => {
        calls.push(args);
        return args.includes("cat") && args.includes("/config/update.sh")
          ? { ...catResult, stderr: "" }
          : { code: 0, stdout: "", stderr: "" };
      },
    );
    return calls.some((c) => c.includes("restart"));
  };
  assert.equal(await scenario({ code: 0, stdout: "#!/bin/sh\n# an older updater\n" }), true, "old script → restart");
  assert.equal(await scenario({ code: 0, stdout: current }), false, "same script → left running");
  assert.equal(await scenario({ code: 1, stdout: "" }), false, "no script yet → it is waiting, picks it up itself");
});
