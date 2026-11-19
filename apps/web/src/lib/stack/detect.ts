// Server-side repo detection: Dockerfile, compose, package manager, scripts,
// env keys and suggested ports. Used by /api/projects/[projectId]/stack/detect.

import { spawn } from "child_process";
import path from "path";
import { LocalFsStorage, expandHome } from "@nexux/storage";

import type { DetectionResult, MakeTarget } from "./types";

const storage = new LocalFsStorage("/");

const DOCKERFILE_CANDIDATES = [
  "Dockerfile",
  "Dockerfile.dev",
  "docker/Dockerfile",
];

const COMPOSE_CANDIDATES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

const ENV_EXAMPLE_CANDIDATES = [".env.example", ".env.sample", ".env.template"];

const MAKEFILE_CANDIDATES = ["Makefile", "makefile", "GNUmakefile"];

const MAX_MAKE_TARGETS = 30;

async function firstExisting(
  root: string,
  candidates: string[]
): Promise<string | undefined> {
  for (const rel of candidates) {
    if (await storage.exists(path.join(root, rel))) return rel;
  }
  return undefined;
}

/**
 * Whether git has this path committed — the only evidence that a clone will
 * see it too. `true` tracked, `false` present but never committed, `null` when
 * git cannot answer (no repo here, no git on the host): with nothing to
 * contradict it, a present file is taken at face value.
 *
 * Being merely un-gitignored is not enough. A stray `pnpm install` writes a
 * pnpm-lock.yaml that no .gitignore mentions, and trusting it hands the whole
 * repo to a package manager it never used.
 */
function isGitTracked(
  root: string,
  relPath: string,
): Promise<boolean | null> {
  return new Promise((resolve) => {
    // `ls-files --error-unmatch` exits 0 when the path IS tracked, 1 when it
    // is not, and 128 when there is no repository to ask.
    const child = spawn("git", ["ls-files", "--error-unmatch", "--", relPath], {
      cwd: root,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 5_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(true);
      if (code === 1) return resolve(false);
      resolve(null);
    });
  });
}

async function readTextSafe(filePath: string): Promise<string | null> {
  try {
    return await storage.readText(filePath);
  } catch {
    return null;
  }
}

function parseEnvKeys(content: string): {
  keys: string[];
  ports: number[];
  values: Record<string, string>;
} {
  const keys: string[] = [];
  const ports: number[] = [];
  // The *values*, not just the names. A seed has to tell `postgres://` from
  // `mysql://` inside the same DATABASE_URL, and the key alone cannot
  // (spec 25 piece 1). An example file is committed placeholder config, so
  // this carries no secret — a real .env is never read here.
  const values: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    keys.push(key);
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    values[key] = value;
    if (/(^|_)PORT$/.test(key)) {
      const val = Number(value);
      if (Number.isInteger(val) && val > 0 && val < 65536) ports.push(val);
    }
  }
  return { keys, ports, values };
}

/**
 * Marks a word that came from a `$(VAR)` expansion. Such a word still proves
 * intent ("this line drives compose") but is never a real path or service
 * name, so file/service extraction drops it. A `$` cannot survive into a
 * normalized recipe (every expansion is rewritten here), which makes it a
 * marker no real token can collide with.
 */
const SENTINEL = "$";
const isExpandedToken = (token: string) => token.startsWith(SENTINEL);

/**
 * `docker compose`, `docker-compose`, the `podman compose` aliases — and a
 * bare `compose <verb>`, which is what `$(DOCKER) compose up` leaves behind
 * once the variable expansion is stripped.
 */
const COMPOSE_RE =
  /\b(?:docker|podman)[\s-]compose\b|(?:^|\s)\$?compose\b[^&|;\n]*\b(?:up|down|start|stop|run|rm|build|ps)\b/;
const DOCKER_RE =
  /\bdocker\b|\bpodman\b|\bdocker-compose\b|(?:^|\s)\$?compose\b[^&|;\n]*\b(?:up|down|start|stop|run|rm|build|ps)\b/;
/** `-f file`, `--file file`, `-f=file` — repeatable in one command. */
const COMPOSE_FILE_RE = /(?:^|\s)(?:-f|--file)[=\s]+("[^"]+"|'[^']+'|\S+)/g;
/** A compose verb, and whatever service names follow it. */
const COMPOSE_VERB_RE =
  /(?:\b(?:docker|podman)[\s-]compose|(?:^|\s)\$?compose)\b([^&|;\n]*?)\b(up|start|run|down|stop|rm)\b([^&|;\n]*)/;
/**
 * Just the verb, for splitting a compose command into "flags that configure
 * compose" and "arguments to the verb". Wider than COMPOSE_VERB_RE: verbs like
 * `logs` carry no services worth recording but still end the flag section.
 */
const COMPOSE_VERB_ONLY_RE =
  /\b(?:up|start|run|down|stop|rm|logs|ps|build|exec|restart|pull|config)\b/;
/** A compose invocation whose verb returns immediately. */
const COMPOSE_NONBLOCKING_RE =
  /(?:\b(?:docker|podman)[\s-]compose|(?:^|\s)\$?compose)\b[^&|;\n]*\b(?:start|down|stop|rm)\b/;
const TEARDOWN_RE = /(^|[-_])(down|stop|kill|clean|rm|teardown|destroy)$/;

/**
 * Strips make's own line noise: the leading `-`/`@`/`+` prefixes, and `$(VAR)`
 * expansions reduced to the variable's name. Keeping the name matters — the
 * common `$(DOCKER_COMPOSE) up -d` says "docker" nowhere else, so dropping the
 * expansion outright would hide the container work this exists to find.
 */
function normalizeRecipeLine(line: string): string {
  return line
    .replace(/^[\s@+-]+/, "")
    .replace(/\$[({]([^)}]*)[)}]/g, (_, name: string) =>
      // Lowercased so `$(DOCKER_COMPOSE)` reads like a command, underscores
      // become spaces so the verb regexes see `docker compose`, and each word
      // is sentinel-marked so a value that came from a variable is never
      // mistaken for a literal path or service name.
      name
        .trim()
        .toLowerCase()
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map((word) => ` ${SENTINEL}${word} `)
        .join("")
    );
}

function parseComposeFiles(recipe: string): string[] {
  const files: string[] = [];
  for (const line of recipe.split("\n")) {
    if (!COMPOSE_RE.test(line)) continue;
    // Only the flags *before* the verb name compose files. After it, `-f` is
    // the verb's own flag with an unrelated meaning — `logs -f firebase`
    // follows the log of a service, it does not read a file called firebase.
    const verb = COMPOSE_VERB_ONLY_RE.exec(line);
    const head = verb ? line.slice(0, verb.index + verb[0].length) : line;
    COMPOSE_FILE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COMPOSE_FILE_RE.exec(head))) {
      const file = m[1].replace(/^["']|["']$/g, "");
      // `-f $(COMPOSE_FILE)` names a file this parser cannot resolve; claiming
      // the variable's name as a path would be worse than claiming nothing.
      if (!file || isExpandedToken(file)) continue;
      if (!files.includes(file)) files.push(file);
    }
  }
  return files;
}

/**
 * Service names a compose invocation targets. Everything after the verb that
 * is not a flag (or a flag's value) is a service: `up -d --build postgres`
 * yields `["postgres"]`.
 */
function parseComposeServices(recipe: string): string[] {
  const services: string[] = [];
  for (const line of recipe.split("\n")) {
    const m = COMPOSE_VERB_RE.exec(line);
    if (!m) continue;
    const tokens = m[3].trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith("-")) {
        // `--scale n` / `-f file` consume the next token; `--flag=v` does not.
        if (!token.includes("=") && /^(?:-f|--file|--scale|-p|--project-name)$/.test(token)) {
          i++;
        }
        continue;
      }
      // A word left over from a variable expansion is not a service name.
      if (isExpandedToken(token)) continue;
      if (!services.includes(token)) services.push(token);
    }
  }
  return services;
}

function isDetached(recipe: string): boolean {
  for (const line of recipe.split("\n")) {
    if (!DOCKER_RE.test(line)) continue;
    // `-d` / `--detach` on a compose/run invocation, or any compose verb that
    // is inherently non-blocking.
    if (/(?:^|\s)(?:-d|--detach)(?:\s|$)/.test(line)) return true;
    if (COMPOSE_NONBLOCKING_RE.test(line)) return true;
  }
  return false;
}

/**
 * Parse rule targets and their recipes. Skips pattern rules (`%`), variable
 * assignments (`:=`) and make's special targets (`.PHONY`), then reads each
 * recipe for what it hides — see MakeTarget.
 */
export function parseMakeTargets(makefile: string): MakeTarget[] {
  const rules: Array<{ name: string; prerequisites: string[]; recipe: string[] }> =
    [];
  const byName = new Map<string, (typeof rules)[number]>();
  let current: (typeof rules)[number] | null = null;

  for (const rawLine of makefile.split("\n")) {
    // A recipe line is tab-indented; anything else ends the current recipe.
    if (current && /^\t/.test(rawLine)) {
      current.recipe.push(normalizeRecipeLine(rawLine));
      continue;
    }
    const m = rawLine.match(/^([A-Za-z0-9_][A-Za-z0-9_.\/-]*)\s*:(?!=)([^=].*)?$/);
    if (!m) {
      // Blank lines and comments sit inside a rule block without ending it.
      if (current && /^\s*(#.*)?$/.test(rawLine)) continue;
      current = null;
      continue;
    }
    const name = m[1];
    if (name.includes("%")) {
      current = null;
      continue;
    }
    // A repeated target adds prerequisites/recipe to the rule already seen.
    const existing = byName.get(name);
    const prerequisites = (m[2] ?? "")
      .split("#")[0]
      .trim()
      .split(/\s+/)
      .filter((p) => p && !p.includes("%"));
    if (existing) {
      for (const p of prerequisites) {
        if (!existing.prerequisites.includes(p)) existing.prerequisites.push(p);
      }
      current = existing;
      continue;
    }
    if (rules.length >= MAX_MAKE_TARGETS) {
      current = null;
      continue;
    }
    const rule = { name, prerequisites, recipe: [] as string[] };
    rules.push(rule);
    byName.set(name, rule);
    current = rule;
  }

  // A target inherits what its prerequisites do: `dev: up` needs Docker when
  // `up` does. Resolved depth-first, with a guard for cyclic prerequisites.
  const resolving = new Set<string>();
  const resolved = new Map<string, MakeTarget>();

  const resolve = (rule: (typeof rules)[number]): MakeTarget => {
    const cached = resolved.get(rule.name);
    if (cached) return cached;
    const recipe = rule.recipe.join("\n");
    const self: MakeTarget = {
      name: rule.name,
      prerequisites: rule.prerequisites,
      usesDocker: DOCKER_RE.test(recipe),
      composeFiles: parseComposeFiles(recipe),
      composeServices: parseComposeServices(recipe),
      detached: isDetached(recipe),
      teardown: TEARDOWN_RE.test(rule.name),
    };
    // Seed the cache before recursing so a cycle resolves to the self-only
    // answer instead of looping.
    resolved.set(rule.name, self);
    if (resolving.has(rule.name)) return self;
    resolving.add(rule.name);

    for (const prereqName of rule.prerequisites) {
      const prereqRule = byName.get(prereqName);
      if (!prereqRule || prereqRule === rule) continue;
      const prereq = resolve(prereqRule);
      self.usesDocker ||= prereq.usesDocker;
      // Detachment is not inherited: a blocking recipe stays blocking however
      // its prerequisites behave.
      for (const f of prereq.composeFiles) {
        if (!self.composeFiles.includes(f)) self.composeFiles.push(f);
      }
      for (const s of prereq.composeServices) {
        if (!self.composeServices.includes(s)) self.composeServices.push(s);
      }
    }
    resolving.delete(rule.name);
    return self;
  };

  return rules.map(resolve);
}

function parseExposedPorts(dockerfile: string): number[] {
  const ports: number[] = [];
  for (const line of dockerfile.split("\n")) {
    const m = line.trim().match(/^EXPOSE\s+(.+)$/i);
    if (!m) continue;
    for (const token of m[1].split(/\s+/)) {
      const port = Number(token.split("/")[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536) ports.push(port);
    }
  }
  return ports;
}

export async function detectRepo(localPath: string): Promise<DetectionResult> {
  const root = expandHome(localPath);

  const [dockerfilePath, composePath, envExampleRel, makefilePath] =
    await Promise.all([
      firstExisting(root, DOCKERFILE_CANDIDATES),
      firstExisting(root, COMPOSE_CANDIDATES),
      firstExisting(root, ENV_EXAMPLE_CANDIDATES),
      firstExisting(root, MAKEFILE_CANDIDATES),
    ]);

  let makeTargetDetails: MakeTarget[] = [];
  if (makefilePath) {
    const makeRaw = await readTextSafe(path.join(root, makefilePath));
    if (makeRaw) makeTargetDetails = parseMakeTargets(makeRaw);
  }
  const makeTargets = makeTargetDetails.map((t) => t.name);

  // A lockfile only speaks for the repo if the repo actually ships it. Local
  // tooling (fnpm, a stray `pnpm install`) leaves lockfiles behind that were
  // never committed — a sandbox clones from git and will never see them, so
  // trusting one here picks a package manager the sandbox cannot honour.
  // A bind-mounted sandbox makes this worse than a wrong guess: the failed
  // install writes its lockfile into the real folder, and the next detection
  // reads it back as evidence.
  const lockfiles: Array<[string, NonNullable<DetectionResult["packageManager"]>]> =
    [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
    ];
  let packageManager: DetectionResult["packageManager"] = null;
  let ignoredLockfile: string | null = null;
  for (const [file, pm] of lockfiles) {
    if (!(await storage.exists(path.join(root, file)))) continue;
    if ((await isGitTracked(root, file)) === false) {
      ignoredLockfile ??= file;
      continue;
    }
    packageManager = pm;
    break;
  }

  let scripts: Record<string, string> = {};
  const pkgRaw = await readTextSafe(path.join(root, "package.json"));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        scripts?: Record<string, string>;
        packageManager?: string;
      };
      scripts = pkg.scripts ?? {};
      // corepack's `packageManager: "pnpm@9.1.0"` is the repo declaring its
      // manager outright — it outranks any lockfile lying around.
      const declared = /^(pnpm|yarn|npm|bun)@/.exec(pkg.packageManager ?? "");
      if (declared && declared[1] !== "bun") {
        packageManager = declared[1] as DetectionResult["packageManager"];
      }
      if (!packageManager) packageManager = "npm";
    } catch {
      // malformed package.json — ignore
    }
  }

  const pm = packageManager ?? "npm";
  const runPrefix = pm === "npm" ? "npm run" : pm;
  const suggestedCommands: DetectionResult["suggestedCommands"] = {};
  if (pkgRaw) suggestedCommands.install = `${pm} install`;
  if (scripts.dev) suggestedCommands.dev = `${runPrefix} dev`;
  if (scripts.build) suggestedCommands.build = `${runPrefix} build`;
  if (scripts.start) {
    suggestedCommands.start = pm === "npm" ? "npm start" : `${pm} start`;
  }

  // Makefile fallbacks when package.json doesn't cover a slot
  const makeHas = (t: string) => makeTargets.includes(t);
  if (!suggestedCommands.dev) {
    const devTarget = ["dev", "run", "serve", "watch"].find(makeHas);
    if (devTarget) suggestedCommands.dev = `make ${devTarget}`;
  }
  if (!suggestedCommands.build && makeHas("build")) {
    suggestedCommands.build = "make build";
  }
  if (!suggestedCommands.start && makeHas("start")) {
    suggestedCommands.start = "make start";
  }
  if (!suggestedCommands.install) {
    const installTarget = ["install", "deps", "setup"].find(makeHas);
    if (installTarget) suggestedCommands.install = `make ${installTarget}`;
  }

  // A suggested `make X` can hide docker entirely — the name says "dev", the
  // recipe says `docker compose up`. Saying so is what lets the user tick
  // "manages services" instead of the stack discovering it at run time.
  const notes: string[] = [];
  if (ignoredLockfile) {
    notes.push(
      `${ignoredLockfile} exists but is not committed — ignored, since a clone will not have it.`
    );
  }
  for (const [slot, command] of Object.entries(suggestedCommands)) {
    const targetName = /^make\s+(\S+)$/.exec(command ?? "")?.[1];
    if (!targetName) continue;
    const target = makeTargetDetails.find((t) => t.name === targetName);
    if (!target?.usesDocker) continue;
    const services = target.composeServices.length
      ? ` (${target.composeServices.join(", ")})`
      : "";
    notes.push(
      target.detached
        ? `\`make ${targetName}\` (${slot}) starts containers${services} and exits — mark the node as managing services.`
        : `\`make ${targetName}\` (${slot}) drives docker${services} — this node needs Docker.`
    );
  }

  let envExampleKeys: string[] = [];
  let envExampleValues: Record<string, string> = {};
  const suggestedPorts: number[] = [];
  if (envExampleRel) {
    const envRaw = await readTextSafe(path.join(root, envExampleRel));
    if (envRaw) {
      const { keys, ports, values } = parseEnvKeys(envRaw);
      envExampleKeys = keys;
      envExampleValues = values;
      suggestedPorts.push(...ports);
    }
  }
  if (dockerfilePath) {
    const dockerRaw = await readTextSafe(path.join(root, dockerfilePath));
    if (dockerRaw) suggestedPorts.push(...parseExposedPorts(dockerRaw));
  }

  return {
    scannedAt: new Date().toISOString(),
    hasDockerfile: !!dockerfilePath,
    dockerfilePath,
    hasCompose: !!composePath,
    composePath,
    hasMakefile: !!makefilePath,
    makefilePath,
    makeTargets,
    makeTargetDetails,
    packageManager,
    notes: notes.length ? notes : undefined,
    scripts,
    suggestedCommands,
    envExampleKeys,
    envExampleValues,
    suggestedPorts: Array.from(new Set(suggestedPorts)),
  };
}
