import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildNexusManifest,
  manifestFromSpec,
  renderNexusCliSection,
  type NexusManifest,
} from "./nexus-cli";
import type { SandboxSpec } from "./types";

// These execute the generated CLI in a real bash. On Windows `bash` resolves to
// C:\Windows\System32\bash.exe — the WSL launcher, not a shell: it re-parses
// argv on the way into the distro and the here-doc driven sessions never
// return, hanging the run rather than failing it. The CLI they cover only ever
// runs on Linux sandboxes.
const realBash = {
  skip:
    process.platform === "win32" &&
    "`bash` here is the WSL launcher, which re-parses argv",
};
function manifest(overrides: Partial<NexusManifest> = {}): NexusManifest {
  return {
    ...buildNexusManifest({
      project: "Acme",
      sandbox: "nexux-test-abc123",
      generatedAt: "2026-08-02T00:00:00.000Z",
      repos: [{ name: "Web App" }, { name: "api" }],
      processes: [
        {
          key: "node1#0",
          label: "Web App",
          command: "pnpm dev",
          cwd: "/opt/nexus/web-app",
          port: 3000,
          role: "run",
        },
        {
          key: "node2#0",
          label: "api",
          command: "make serve",
          cwd: "/opt/nexus/api",
          port: 8080,
          role: "run",
        },
      ],
    }),
    ...overrides,
  };
}

/**
 * Source the generated CLI in a real bash and run `cmd` against it, with the
 * manifest and every /tmp/nexus-proc-* artefact redirected into a temp dir.
 *
 * Substring assertions over generated shell prove nothing about whether it
 * parses, let alone whether `start` actually records a pid â€” so the tests
 * execute it.
 */
function cli(m: NexusManifest, cmd: string): { out: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nexus-cli-"));
  const manifestPath = join(dir, "nexus.json");
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));

  const section = renderNexusCliSection(m);
  const body = section.split("<<'NEXUS_CLI_EOF'\n")[1]!.split("\nNEXUS_CLI_EOF")[0]!;
  const cliPath = join(dir, "cli.sh");
  writeFileSync(
    cliPath,
    body
      .replace('NEXUS_MANIFEST="/opt/nexus/nexus.json"', `NEXUS_MANIFEST="${manifestPath}"`)
      .replace(/\/tmp\/nexus-proc-/g, `${dir}/proc-`),
  );

  const out = execFileSync(
    "bash",
    ["-c", `NEXUS_NO_BANNER=1; . ${cliPath}; ${cmd}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { out, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("aliases are typeable and unique", () => {
  const m = manifest();
  assert.deepEqual(
    m.processes.map((p) => p.alias),
    ["web-app", "api"],
  );
  assert.deepEqual(m.repos.map((r) => r.dir), [
    "/opt/nexus/web-app",
    "/opt/nexus/api",
  ]);
});

test("duplicate labels get distinct aliases", () => {
  const m = buildNexusManifest({
    project: "p",
    sandbox: "s",
    generatedAt: "2026-08-02T00:00:00.000Z",
    repos: [],
    processes: [
      { key: "a#0", label: "api", command: "x", cwd: "/opt/nexus/a", port: null, role: "run" },
      { key: "b#0", label: "api", command: "y", cwd: "/opt/nexus/b", port: null, role: "run" },
    ],
  });
  assert.deepEqual(m.processes.map((p) => p.alias), ["api", "api-2"]);
});

test("generated CLI is valid bash", realBash, () => {
  const section = renderNexusCliSection(manifest());
  const body = section.split("<<'NEXUS_CLI_EOF'\n")[1]!.split("\nNEXUS_CLI_EOF")[0]!;
  const dir = mkdtempSync(join(tmpdir(), "nexus-syntax-"));
  try {
    const p = join(dir, "cli.sh");
    writeFileSync(p, body);
    // -n parses without executing: catches an unbalanced quote or heredoc.
    execFileSync("bash", ["-n", p]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status lists every process as stopped when nothing runs", realBash, () => {
  const { out, cleanup } = cli(manifest(), "nexus status");
  try {
    assert.match(out, /web-app/);
    assert.match(out, /api/);
    assert.match(out, /stopped/);
    assert.doesNotMatch(out, /running/);
  } finally {
    cleanup();
  }
});

test("start records a pid, status sees it, stop clears it", realBash, () => {
  const m = manifest({
    processes: [
      {
        key: "node1#0",
        alias: "web-app",
        label: "Web App",
        // A command that outlives the start call, so the liveness check is real.
        command: "sleep 30",
        cwd: "/tmp",
        port: 3000,
        checkPorts: [],
        role: "run",
      },
    ],
  });
  const { out, cleanup } = cli(
    m,
    "nexus start web-app; nexus status; nexus stop web-app; sleep 0.3; nexus status",
  );
  try {
    assert.match(out, /started web-app \(pid \d+\)/);
    assert.match(out, /http:\/\/localhost:3000/);
    // First status sees it up, the one after stop does not.
    const [before, after] = out.split("stopped web-app");
    assert.match(before!, /running :3000/);
    assert.match(after!, /stopped/);
    assert.doesNotMatch(after!, /running/);
  } finally {
    cleanup();
  }
});

test("start is idempotent while the process is alive", realBash, () => {
  const m = manifest({
    processes: [
      {
        key: "k#0",
        alias: "svc",
        label: "svc",
        command: "sleep 30",
        cwd: "/tmp",
        port: null,
        checkPorts: [],
        role: "run",
      },
    ],
  });
  const { out, cleanup } = cli(m, "nexus start svc; nexus start svc; nexus stop svc");
  try {
    assert.match(out, /already running \(pid \d+\)/);
  } finally {
    cleanup();
  }
});

test("unknown alias fails rather than starting something else", realBash, () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-unknown-"));
  try {
    const manifestPath = join(dir, "nexus.json");
    writeFileSync(manifestPath, JSON.stringify(manifest(), null, 2));
    const section = renderNexusCliSection(manifest());
    const body = section.split("<<'NEXUS_CLI_EOF'\n")[1]!.split("\nNEXUS_CLI_EOF")[0]!;
    const cliPath = join(dir, "cli.sh");
    writeFileSync(
      cliPath,
      body
        .replace('NEXUS_MANIFEST="/opt/nexus/nexus.json"', `NEXUS_MANIFEST="${manifestPath}"`)
        .replace(/\/tmp\/nexus-proc-/g, `${dir}/proc-`),
    );
    const res = execFileSync(
      "bash",
      ["-c", `NEXUS_NO_BANNER=1; . ${cliPath}; nexus start nope 2>&1; echo "code=$?"`],
      { encoding: "utf8" },
    );
    assert.match(res, /unknown process 'nope'/);
    assert.match(res, /code=1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("banner stays out of non-interactive shells", realBash, () => {
  // execRemote runs every host->sandbox command through `bash -lc`, and the
  // host regexes that stdout for PID:/PREVIEW: markers â€” a banner would break
  // every one of those reads.
  const { out, cleanup } = cli(manifest(), "echo MARKER");
  try {
    assert.equal(out.trim(), "MARKER");
    assert.doesNotMatch(out, /â–ˆâ–ˆâ–ˆ/);
  } finally {
    cleanup();
  }
});

test("nexus cd resolves a repo alias to its checkout", realBash, () => {
  // The checkout does not exist on the test host, so cd itself fails; what
  // matters is that the alias resolved to the right absolute path. Assert on
  // the resolution rather than on the cd.
  const { out, cleanup } = cli(
    manifest(),
    `_nexus_q "next((r['dir'] for r in m['repos'] if r['alias']=='web-app'), None)"`,
  );
  try {
    assert.equal(out.trim(), "/opt/nexus/web-app");
  } finally {
    cleanup();
  }
});

test("manifestFromSpec keeps repos without a run command out of processes", () => {
  const spec: SandboxSpec = {
    provider: "local",
    name: "nexux-x",
    region: "",
    size: "",
    diskImage: "",
    installDocker: false,
    installNode: true,
    installClaudeCode: false,
    installAgentBrowser: false,
    installCloudflared: false,
    envVars: {},
    repos: [
      { name: "web", repoUrl: null, mountPath: "/host/web", runCommand: "pnpm dev" },
      { name: "docs", repoUrl: null, mountPath: "/host/docs", runCommand: null },
    ],
  };
  const m = manifestFromSpec(spec, { generatedAt: "2026-08-02T00:00:00.000Z" });
  assert.deepEqual(m.repos.map((r) => r.alias), ["web", "docs"]);
  assert.deepEqual(m.processes.map((p) => p.alias), ["web"]);
  assert.equal(m.processes[0]!.command, "pnpm dev");
});

test("a repo with neither url nor mount is left out of the manifest", () => {
  // renderCloudInit skips those repos entirely â€” no checkout is ever created,
  // so listing one would point `nexus cd` at a directory that does not exist.
  const spec: SandboxSpec = {
    provider: "local",
    name: "nexux-x",
    region: "",
    size: "",
    diskImage: "",
    installDocker: false,
    installNode: true,
    installClaudeCode: false,
    installAgentBrowser: false,
    installCloudflared: false,
    envVars: {},
    repos: [
      { name: "real", repoUrl: "https://github.com/acme/real.git" },
      { name: "ghost", repoUrl: null, runCommand: "pnpm dev" },
    ],
  };
  const m = manifestFromSpec(spec, { generatedAt: "2026-08-02T00:00:00.000Z" });
  assert.deepEqual(m.repos.map((r) => r.name), ["real"]);
  assert.deepEqual(m.processes.map((p) => p.label), []);
  assert.ok(!renderNexusCliSection(m).includes("ghost"));
});

/** A real listener on loopback, so the CLI's /dev/tcp probe has a target. */
function listen(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as { port: number }).port, server });
    });
  });
}

/** A loopback port that was just freed, so nothing answers on it. */
async function closedPort(): Promise<number> {
  const { port, server } = await listen();
  await new Promise((r) => server.close(r));
  return port;
}

test("a detached launcher with an answering port reports up", realBash, async () => {
  // The bug this exists for: `docker compose up -d` exits once its containers
  // are up, its recorded PID dies, and status called that "stopped" while the
  // services kept serving.
  const { port, server } = await listen();
  const m = manifest({
    processes: [
      {
        key: "stack#1",
        alias: "db",
        label: "db",
        command: "docker compose up -d",
        cwd: "/tmp",
        port: null,
        checkPorts: [port],
        role: "services",
      },
    ],
  });
  const { out, cleanup } = cli(m, "nexus status");
  try {
    assert.match(out, /db/);
    assert.match(out, /up \(detached\)/);
    assert.doesNotMatch(out, /stopped/);
  } finally {
    cleanup();
    server.close();
  }
});

test("a launcher whose ports are closed stays stopped", realBash, async () => {
  const m = manifest({
    processes: [
      {
        key: "stack#1",
        alias: "db",
        label: "db",
        // The compose fallback cannot false-positive either: /tmp holds no
        // compose project, so `docker compose ps` answers nothing.
        command: "docker compose up -d",
        cwd: "/tmp",
        port: null,
        checkPorts: [await closedPort()],
        role: "services",
      },
    ],
  });
  const { out, cleanup } = cli(m, "nexus status");
  try {
    assert.match(out, /stopped/);
    assert.doesNotMatch(out, /up \(detached\)/);
  } finally {
    cleanup();
  }
});

test("a run process started by hand shows up as external", realBash, async () => {
  // No pidfile exists (nexus never started it), but its port answers â€” the
  // truthful state is "up", not "stopped".
  const { port, server } = await listen();
  const m = manifest({
    processes: [
      {
        key: "node1#0",
        alias: "web",
        label: "web",
        command: "pnpm dev",
        cwd: "/tmp",
        port,
        checkPorts: [port],
        role: "run",
      },
    ],
  });
  const { out, cleanup } = cli(m, "nexus status");
  try {
    assert.match(out, new RegExp(`up \\(external :${port}\\)`));
  } finally {
    cleanup();
    server.close();
  }
});

test("a manifest without checkPorts (pre-upgrade) still renders status", realBash, async () => {
  const m = manifest();
  for (const p of m.processes) {
    delete (p as Partial<typeof p>).checkPorts;
  }
  const { out, cleanup } = cli(m, "nexus status");
  try {
    assert.match(out, /web-app/);
    assert.match(out, /stopped/);
  } finally {
    cleanup();
  }
});

test("heredoc sentinel in a command is rejected, not silently emitted", () => {
  const m = manifest({
    processes: [
      {
        key: "k#0",
        alias: "evil",
        label: "evil",
        command: "echo NEXUS_MANIFEST_EOF",
        cwd: "/tmp",
        port: null,
        checkPorts: [],
        role: "run",
      },
    ],
  });
  assert.throws(() => renderNexusCliSection(m), /sentinel/);
});
