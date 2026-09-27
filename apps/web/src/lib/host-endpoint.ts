/**
 * A Nexus host on a Docker endpoint — provisioning. Spec: `specs/27-nexus-host-on-docker-endpoint.md`.
 *
 * No Terraform and no cloud-init: the stack from `renderHostCompose({ mode:
 * "endpoint" })` is driven onto the endpoint's daemon with `docker -H …
 * compose`. Compose reads the file and its `.env` *here* and talks to the
 * remote daemon; the named volumes are created there. Nothing is copied to the
 * machine's own filesystem, and the secrets in `.env` never leave this one
 * except as container environment.
 *
 * The flow mirrors a VM host's bootstrap in the order that makes each failure
 * name its cause: pull (registry problems), Tailscale (auth-key problems),
 * then the app (image problems).
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import {
  dockerHostArgs,
  endpointHostProject,
  renderEndpointUpdater,
  renderHostCompose,
} from "@nexux/sandbox";

export { endpointHostProject };

export type RunResult = { code: number; stdout: string; stderr: string };

/** Spawns docker. Injected so the flow can be tested without a daemon. */
export type DockerRunner = (
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; onLog?: (chunk: string) => void },
) => Promise<RunResult>;

export const runDocker: DockerRunner = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          stderr += `\n[nexux] timed out after ${Math.round(opts.timeoutMs! / 1000)}s`;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
      opts.onLog?.(c.toString());
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
      opts.onLog?.(c.toString());
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(opts.input ?? "");
  });

/** `docker -H <host> compose -p <project> -f … --env-file …` — the fixed prefix. */
export function endpointComposeArgs(opts: {
  dockerHost: string;
  project: string;
  workDir: string;
}): string[] {
  return [
    ...dockerHostArgs({ host: opts.dockerHost }),
    "compose",
    "-p",
    opts.project,
    "-f",
    path.join(opts.workDir, "compose.yml"),
    "--env-file",
    path.join(opts.workDir, ".env"),
  ];
}

/**
 * The `.env` compose interpolates from. Single-quoted, which compose reads
 * literally; a value that could break out of the quotes is refused rather than
 * escaped, since none of these legitimately contains one.
 */
export function renderEndpointEnv(vars: Record<string, string>): string {
  return (
    Object.entries(vars)
      .map(([k, v]) => {
        if (/['\n\r]/.test(v)) throw new Error(`Refusing to write ${k}: it contains a quote or newline`);
        return `${k}='${v}'`;
      })
      .join("\n") + "\n"
  );
}

/**
 * What the updater service needs to recreate the stack without this machine
 * (spec 27 phase 5): the compose file, its `.env`, the updater script, and
 * the registry login a private image pulls with. Written into its config
 * volume through `docker exec -i` — on stdin, so neither the auth key nor the
 * registry token ever appears in argv.
 *
 * This is where the host's secrets come to rest on the endpoint: inside a
 * Docker volume only the updater mounts. The app container never sees it.
 */
export async function syncUpdaterConfig(
  spec: {
    project: string;
    dockerHost: string;
    workDir: string;
    registry: { host: string; username: string; password: string } | null;
  },
  run: DockerRunner,
): Promise<void> {
  const container = `${spec.project}-updater-1`;
  const auths = spec.registry
    ? {
        [spec.registry.host]: {
          auth: Buffer.from(`${spec.registry.username}:${spec.registry.password}`).toString("base64"),
        },
      }
    : {};
  const files: Array<[string, string]> = [
    ["compose.yml", fs.readFileSync(path.join(spec.workDir, "compose.yml"), "utf8")],
    [".env", fs.readFileSync(path.join(spec.workDir, ".env"), "utf8")],
    // Written even when empty: a registry login removed since must not linger.
    ["docker/config.json", JSON.stringify({ auths }) + "\n"],
    // Last: the updater waits for this file, so it only starts once the rest
    // is in place.
    ["update.sh", renderEndpointUpdater(spec.project)],
  ];
  for (const [file, content] of files) {
    const res = await run(
      [
        ...dockerHostArgs({ host: spec.dockerHost }),
        "exec",
        "-i",
        container,
        "sh",
        "-c",
        // Fixed paths only; the content arrives on stdin.
        `umask 077 && mkdir -p /config/docker && cat > /config/${file}`,
      ],
      { input: content, timeoutMs: 60_000 },
    );
    if (res.code !== 0) {
      throw new Error(`Could not hand the updater its ${file}: ${res.stderr.trim().slice(-300)}`);
    }
  }
}

/** Read `Self.DNSName` out of `tailscale status --json`, without the trailing dot. */
export function parseTailscaleDnsName(stdout: string): string | null {
  try {
    const name = (JSON.parse(stdout) as { Self?: { DNSName?: unknown } }).Self?.DNSName;
    return typeof name === "string" && name ? name.replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

export type EndpointHostSpec = {
  name: string;
  imageRef: string;
  dockerHost: string;
  workDir: string;
  tailscaleAuthKey: string;
  tailscaleLoginServer?: string | null;
  /** Registry login for a private image; null for a public one. */
  registry: { host: string; username: string; password: string } | null;
  pullEmbeddingModel: boolean;
};

export type EndpointHostIO = {
  log: (chunk: string) => void;
  update: (data: {
    status?: string;
    instanceId?: string;
    tailscaleIp?: string;
    tailscaleName?: string | null;
  }) => Promise<void>;
  run?: DockerRunner;
  /** Poll pacing; tests shrink it. */
  sleep?: (ms: number) => Promise<void>;
};

const TAILSCALE_WAIT_MS = 120_000;
const APP_WAIT_MS = 300_000;

/** Provision the stack and wait until it answers over the tailnet. Throws with the cause. */
export async function provisionEndpointHost(
  spec: EndpointHostSpec,
  io: EndpointHostIO,
): Promise<void> {
  const run = io.run ?? runDocker;
  const sleep = io.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const project = endpointHostProject(spec.name);
  const compose = endpointComposeArgs({
    dockerHost: spec.dockerHost,
    project,
    workDir: spec.workDir,
  });
  const loginServer = spec.tailscaleLoginServer?.trim().replace(/\/+$/, "");
  const envVars = (origin: string) => ({
    TS_AUTHKEY: spec.tailscaleAuthKey,
    TS_EXTRA_ARGS: loginServer ? `--login-server=${loginServer}` : "",
    NEXUX_WEB_ORIGIN: origin,
  });
  const writeEnv = (origin: string) =>
    fs.writeFileSync(path.join(spec.workDir, ".env"), renderEndpointEnv(envVars(origin)), {
      mode: 0o600,
    });
  const must = async (label: string, args: string[], opts: Parameters<DockerRunner>[1] = {}) => {
    const res = await run(args, { onLog: io.log, ...opts });
    if (res.code !== 0) {
      throw new Error(`${label} failed: ${res.stderr.trim().split("\n").slice(-3).join(" ").slice(-400)}`);
    }
    return res;
  };

  // Secrets live in .env beside the compose file, on this machine, 0600.
  fs.mkdirSync(spec.workDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(spec.workDir, "compose.yml"),
    renderHostCompose({ imageRef: spec.imageRef, mode: "endpoint", name: spec.name }),
  );
  // The origin is only known once Tailscale has an address; the app is not
  // started until then, so this placeholder never reaches it.
  writeEnv("http://localhost:3030");
  await io.update({ status: "provisioning", instanceId: project });

  // 1. Pull — every image, so a registry problem fails here with the registry
  // named, not halfway through starting the stack.
  io.log(`[nexus-host] pulling images on ${spec.dockerHost}\n`);
  if (spec.registry) {
    await withTempDockerConfig(async (env) => {
      await must(
        `docker login ${spec.registry!.host}`,
        [
          ...dockerHostArgs({ host: spec.dockerHost }),
          "login",
          spec.registry!.host,
          "-u",
          spec.registry!.username,
          "--password-stdin",
        ],
        // The password goes in on stdin, never in argv.
        { env, input: spec.registry!.password, onLog: undefined },
      );
      await must("image pull", [...compose, "pull"], { env, timeoutMs: 20 * 60_000 });
    });
  } else {
    await must("image pull", [...compose, "pull"], { timeoutMs: 20 * 60_000 });
  }

  // 2. Tailscale first: the app's origin is its tailnet address.
  await io.update({ status: "bootstrapping" });
  io.log(`[nexus-host] starting tailscale\n`);
  await must("starting tailscale", [...compose, "up", "-d", "tailscale"], { timeoutMs: 120_000 });

  let ip: string | null = null;
  for (let waited = 0; waited < TAILSCALE_WAIT_MS; waited += 3000) {
    const res = await run([...compose, "exec", "-T", "tailscale", "tailscale", "ip", "-4"], {
      timeoutMs: 30_000,
    });
    const candidate = res.stdout.trim().split("\n")[0]?.trim();
    if (res.code === 0 && candidate && /^\d+\.\d+\.\d+\.\d+$/.test(candidate)) {
      ip = candidate;
      break;
    }
    await sleep(3000);
  }
  if (!ip) {
    const logs = await run([...compose, "logs", "--tail", "20", "tailscale"], { timeoutMs: 30_000 });
    io.log(logs.stdout + logs.stderr);
    throw new Error(
      "Tailscale did not join the tailnet within 2 minutes — check that the auth key is valid, pre-authorized and reusable (its log is above).",
    );
  }
  io.log(`[nexus-host] tailnet address ${ip}\n`);

  // 3. The app, now that its origin is known.
  writeEnv(`http://${ip}:3030`);
  await must("starting the stack", [...compose, "up", "-d"], { timeoutMs: 300_000 });
  // So the host can update itself from its own Settings (phase 5).
  await syncUpdaterConfig(
    { project, dockerHost: spec.dockerHost, workDir: spec.workDir, registry: spec.registry },
    run,
  );

  let healthy = false;
  // `node`, because it is the one binary the image is certain to have.
  const probe =
    "fetch('http://127.0.0.1:3030/api/version').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))";
  for (let waited = 0; waited < APP_WAIT_MS; waited += 5000) {
    const res = await run([...compose, "exec", "-T", "nexux", "node", "-e", probe], {
      timeoutMs: 30_000,
    });
    if (res.code === 0) {
      healthy = true;
      break;
    }
    await sleep(5000);
  }
  if (!healthy) {
    const logs = await run([...compose, "logs", "--tail", "40", "nexux"], { timeoutMs: 30_000 });
    io.log(logs.stdout + logs.stderr);
    throw new Error("Nexux did not answer within 5 minutes of starting (its log is above).");
  }

  const status = await run([...compose, "exec", "-T", "tailscale", "tailscale", "status", "--json"], {
    timeoutMs: 30_000,
  });
  const dnsName = status.code === 0 ? parseTailscaleDnsName(status.stdout) : null;

  // 4. Embeddings model — slow, and not worth failing the host over.
  if (spec.pullEmbeddingModel) {
    io.log(`[nexus-host] pulling nomic-embed-text (slow; search is empty until it lands)\n`);
    const pulled = await run([...compose, "exec", "-T", "ollama", "ollama", "pull", "nomic-embed-text"], {
      onLog: io.log,
      timeoutMs: 20 * 60_000,
    });
    if (pulled.code !== 0) {
      io.log("[nexus-host] WARN: could not pull nomic-embed-text — search will be empty until it is\n");
    }
  }

  await io.update({ status: "running", tailscaleIp: ip, tailscaleName: dnsName });
  io.log(`[nexus-host] ready at http://${dnsName ?? ip}:3030\n`);
}

/** The app container compose names for a host's project. */
export function endpointHostAppContainer(project: string): string {
  return `${project}-nexux-1`;
}

export type EndpointUpdateResult = {
  ok: boolean;
  message: string;
  log: string;
  /** Whether the running image changed; undefined when it cannot be told. */
  updated?: boolean;
};

/**
 * Pull the host's images and recreate what changed — spec 19's update, on an
 * endpoint. Never `down`: the volumes hold the database, credentials and
 * search indexes, and `up -d` recreates only containers whose image changed.
 *
 * The compose file is re-rendered first, so a template change shipped since
 * the host was created reaches it on update (the file says as much). The
 * `.env` is not: it holds the auth key, which only exists there.
 */
export async function updateEndpointHost(
  spec: {
    name: string;
    imageRef: string;
    dockerHost: string;
    workDir: string;
    registry: { host: string; username: string; password: string } | null;
  },
  run: DockerRunner = runDocker,
): Promise<EndpointUpdateResult> {
  if (!fs.existsSync(path.join(spec.workDir, ".env"))) {
    return {
      ok: false,
      message: `This host's settings are missing from ${spec.workDir} on this machine, so it can't be updated from here. Update it on the endpoint (docker compose pull && up -d), or destroy and recreate it.`,
      log: "",
    };
  }
  const project = endpointHostProject(spec.name);
  const compose = endpointComposeArgs({ dockerHost: spec.dockerHost, project, workDir: spec.workDir });
  fs.writeFileSync(
    path.join(spec.workDir, "compose.yml"),
    renderHostCompose({ imageRef: spec.imageRef, mode: "endpoint", name: spec.name }),
  );

  let log = "";
  const onLog = (c: string) => void (log += c);
  const imageId = async () =>
    (await run([...compose, "images", "--quiet", "nexux"], { timeoutMs: 60_000 })).stdout
      .trim()
      .split("\n")[0]
      ?.trim() || null;

  const before = await imageId();
  const pull = spec.registry
    ? await withTempDockerConfig(async (env) => {
        const login = await run(
          [...dockerHostArgs({ host: spec.dockerHost }), "login", spec.registry!.host, "-u", spec.registry!.username, "--password-stdin"],
          { env, input: spec.registry!.password },
        );
        if (login.code !== 0) return login;
        return run([...compose, "pull"], { env, onLog, timeoutMs: 20 * 60_000 });
      })
    : await run([...compose, "pull"], { onLog, timeoutMs: 20 * 60_000 });
  if (pull.code !== 0) {
    return {
      ok: false,
      message: "The pull failed. The host is still running the old image.",
      log: (log + pull.stderr).trim().slice(-8000),
    };
  }
  const up = await run([...compose, "up", "-d"], { onLog, timeoutMs: 5 * 60_000 });
  if (up.code !== 0) {
    return {
      ok: false,
      message: "The images were pulled but the stack did not restart cleanly.",
      log: log.trim().slice(-8000),
    };
  }
  // Keeps the updater's copy current — and gives a host created before
  // phase 5 its updater the first time it is updated from here.
  try {
    await syncUpdaterConfig(
      { project, dockerHost: spec.dockerHost, workDir: spec.workDir, registry: spec.registry },
      run,
    );
  } catch (err) {
    log += `\n[nexus-host] WARN: the host was updated, but its self-updater could not be refreshed: ${err instanceof Error ? err.message : String(err)}\n`;
  }
  const after = await imageId();
  // Only claim "nothing changed" when both ids were actually read.
  const updated = before && after ? before !== after : undefined;
  return {
    ok: true,
    message:
      updated === false
        ? "Already up to date — the pull found no newer image."
        : updated
          ? "Updated — the host is now running the new image."
          : "Updated and restarted.",
    log: log.trim().slice(-8000),
    updated,
  };
}

/**
 * Remove the host's stack *and its volumes* from the endpoint, then its files
 * here. Volumes go because that is what destroying a VM host does: a
 * "destroyed" host whose database quietly survives on someone's workstation
 * is worse than an explicit loss. The UI says so before this runs.
 *
 * Works without the compose file too (`down` needs only the project name), so
 * a host whose local files were lost can still be cleaned up.
 */
export async function destroyEndpointHost(
  spec: { name: string; dockerHost: string; workDir: string },
  io: { log: (chunk: string) => void; run?: DockerRunner },
): Promise<void> {
  const run = io.run ?? runDocker;
  const project = endpointHostProject(spec.name);
  const haveFiles = fs.existsSync(path.join(spec.workDir, "compose.yml"));
  const args = haveFiles
    ? [...endpointComposeArgs({ dockerHost: spec.dockerHost, project, workDir: spec.workDir }), "down", "--volumes", "--remove-orphans"]
    : [...dockerHostArgs({ host: spec.dockerHost }), "compose", "-p", project, "down", "--volumes", "--remove-orphans"];
  io.log(`[nexus-host] removing ${project} and its volumes from ${spec.dockerHost}\n`);
  const res = await run(args, { onLog: io.log, timeoutMs: 5 * 60_000 });
  if (res.code !== 0) {
    throw new Error(
      `Could not remove the stack from the endpoint: ${res.stderr.trim().split("\n").slice(-3).join(" ").slice(-400)}`,
    );
  }
  fs.rmSync(spec.workDir, { recursive: true, force: true });
}

/**
 * Run `fn` with a DOCKER_CONFIG that holds only a throwaway login.
 *
 * `docker login` stores credentials client-side, in the user's
 * ~/.docker/config.json — this machine's, not the endpoint's. Logging in there
 * to pull a host's image would leave a registry token in the user's own docker
 * config. The temp dir keeps a link to the user's CLI plugins, because that is
 * where Docker Desktop installs `compose`.
 */
async function withTempDockerConfig<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-docker-config-"));
  try {
    const plugins = path.join(os.homedir(), ".docker", "cli-plugins");
    if (fs.existsSync(plugins)) fs.symlinkSync(plugins, path.join(dir, "cli-plugins"));
    fs.writeFileSync(path.join(dir, "config.json"), "{}\n", { mode: 0o600 });
    return await fn({ ...process.env, DOCKER_CONFIG: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
