import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BOT_CONTAINER_LABEL,
  BOT_MCP_CONFIG,
  BOT_NOVNC_PORT,
  botImageTag,
  botRunArgs,
  botVncUrl,
  buildBotClaudeCommand,
  dockerRun,
  ensureBotImage,
  parsePublishedPort,
  runBotPrompt,
  renderBotDockerfile,
  renderBotEntrypoint,
  renderBotMcpConfig,
  renderBotPanelConfig,
  renderBotScreenPage,
  renderBotSystemPrompt,
} from "./bot";

test("the image tag follows the recipe, so a changed Dockerfile rebuilds", () => {
  const a = botImageTag("FROM debian\n");
  assert.match(a, /^nexux-bot:[0-9a-f]{12}$/);
  assert.equal(botImageTag("FROM debian\n"), a);
  assert.notEqual(botImageTag("FROM debian:bookworm\n"), a);
  assert.equal(botImageTag(), botImageTag(renderBotDockerfile()));
});

test("the Dockerfile embeds its files and runs as the non-root bot user", () => {
  const df = renderBotDockerfile();
  // bypassPermissions is refused as root — the image must end on a user.
  assert.match(df, /\nUSER bot\n/);
  // Debian's chromium is a real .deb on arm64; Ubuntu's is a snap.
  assert.match(df, /^FROM debian:bookworm-slim/);
  assert.match(df, /\bchromium\b/);
  assert.match(df, /@anthropic-ai\/claude-code/);
  assert.match(df, /@playwright\/mcp/);
  // Built from stdin: no COPY, everything inline.
  assert.doesNotMatch(df, /^\s*COPY /m);
  const embedded = [...df.matchAll(/echo ([A-Za-z0-9+/=]+) \| base64 -d > (\S+)/g)];
  const byPath = Object.fromEntries(
    embedded.map((m) => [m[2], Buffer.from(m[1], "base64").toString("utf8")]),
  );
  assert.equal(byPath["/usr/local/bin/nexux-bot-entrypoint"], renderBotEntrypoint());
  assert.equal(byPath[BOT_MCP_CONFIG], renderBotMcpConfig());
});

test("the entrypoint is valid bash", () => {
  execFileSync("bash", ["-n"], { input: renderBotEntrypoint() });
});

test("the MCP config attaches Playwright to the visible Chromium over CDP", () => {
  const cfg = JSON.parse(renderBotMcpConfig());
  assert.deepEqual(cfg.mcpServers.browser.args, [
    "--cdp-endpoint",
    "http://127.0.0.1:9222",
  ]);
});

test("docker run is ephemeral, labelled, loopback-only, and keeps secrets out of argv", () => {
  const args = botRunArgs({
    name: "nexux-bot-abc",
    image: "nexux-bot:123",
    envKeys: ["CLAUDE_CODE_OAUTH_TOKEN", "VNC_PASSWORD"],
    memoryMb: 4096,
  });
  assert.ok(args.includes("--rm"));
  assert.ok(args.includes("--init"));
  assert.equal(args[args.indexOf("-p") + 1], `127.0.0.1::${BOT_NOVNC_PORT}`);
  assert.equal(args[args.indexOf("--label") + 1], BOT_CONTAINER_LABEL);
  assert.equal(args[args.indexOf("--memory") + 1], "4096m");
  // `-e KEY` with no value: docker reads it from the client env.
  assert.deepEqual(
    args.filter((_, i) => args[i - 1] === "-e"),
    ["CLAUDE_CODE_OAUTH_TOKEN", "VNC_PASSWORD"],
  );
  assert.ok(!args.some((a) => /^(CLAUDE_CODE_OAUTH_TOKEN|VNC_PASSWORD)=/.test(a)));
  assert.equal(args.at(-1), "nexux-bot:123");
  // No volume: nothing outlives the container.
  assert.ok(!args.includes("-v"));
});

test("no memory flag when Docker will not say how much it has", () => {
  const args = botRunArgs({ name: "n", image: "i", envKeys: [], memoryMb: null });
  assert.ok(!args.includes("--memory"));
});

test("parsePublishedPort reads docker port output", () => {
  assert.equal(parsePublishedPort("127.0.0.1:49153\n"), 49153);
  assert.equal(parsePublishedPort("0.0.0.0:1234\n[::]:1234\n"), 1234);
  assert.equal(parsePublishedPort(""), null);
});

test("the Claude command resumes, picks the model, and wires the browser MCP", () => {
  const cmd = buildBotClaudeCommand("busca 'vuelos'", {
    systemPrompt: "You are X",
    resumeSessionId: "s-1",
    model: "sonnet",
  });
  assert.match(cmd, /^claude --resume 's-1' --model 'sonnet' -p /);
  assert.ok(cmd.includes(`'busca '\\''vuelos'\\'''`));
  assert.ok(cmd.includes(`--mcp-config ${BOT_MCP_CONFIG}`));
  assert.ok(cmd.includes("--append-system-prompt 'You are X'"));
  assert.ok(cmd.endsWith("--permission-mode bypassPermissions --output-format stream-json --verbose"));

  const fresh = buildBotClaudeCommand("hi", { systemPrompt: "s" });
  assert.match(fresh, /^claude -p 'hi'/);
  assert.match(fresh, /--mcp-config \/etc\/nexux-bot\/mcp\.json --permission-mode/);
  // The bot's own servers ride in a second config file.
  const withOwn = buildBotClaudeCommand("hi", { systemPrompt: "s", userMcp: true });
  // Room for a cold `npx -y` download, but only when the bot has servers of its own.
  assert.match(withOwn, /^MCP_TIMEOUT=180000 claude -p/);
  assert.doesNotMatch(fresh, /MCP_TIMEOUT/);
  assert.match(withOwn, /--mcp-config \/etc\/nexux-bot\/mcp\.json \/home\/bot\/\.nexux-mcp\.json --permission-mode/);
});

test("the system prompt carries the job, the computer rules and the input marker", () => {
  const p = renderBotSystemPrompt({
    name: "QA Bot",
    role: "test the signup flow",
    instructions: "Always use staging.",
    needsInputMarker: "NEEDS_INPUT:",
  });
  assert.match(p, /"QA Bot", an AI teammate whose job is: test the signup flow/);
  assert.match(p, /`browser` MCP tools/);
  assert.match(p, /reset whenever it goes to sleep/);
  assert.match(p, /"NEEDS_INPUT:"/);
  assert.match(p, /# Standing instructions\n\nAlways use staging\./);
  // Emails are drafted as blocks the user sends from a card — never sent unasked.
  assert.match(p, /Never send an email on your own/);
  const example = p.match(/```mail\n(.*)\n```/)![1]!;
  assert.equal(JSON.parse(example).body.split("\n").length, 6); // real line breaks once parsed

  const bare = renderBotSystemPrompt({ name: "B", needsInputMarker: "Q:" });
  assert.doesNotMatch(bare, /Standing instructions/);
  assert.doesNotMatch(bare, /# Your tools/);
  const tooled = renderBotSystemPrompt({ name: "B", needsInputMarker: "Q:", mcpServers: ["context7", "crm"] });
  assert.match(tooled, /# Your tools\n\nBesides the browser, the user connected these MCP servers for you: `context7`, `crm`/);
  assert.doesNotMatch(bare, /whose job is/);
});

test("the screen URL is loopback and starts view-only", () => {
  const url = new URL(botVncUrl(49153, "p&w"));
  assert.equal(url.host, "127.0.0.1:49153");
  assert.equal(url.pathname, "/nexux-screen.html");
  assert.equal(url.searchParams.get("password"), "p&w");
  assert.equal(url.searchParams.get("view_only"), "1");
  assert.equal(new URL(botVncUrl(1, "x", { viewOnly: false })).searchParams.get("view_only"), "0");
});

test("the full noVNC URL autoconnects, scales and is interactive", () => {
  const url = new URL(botVncUrl(49153, "p&w", { full: true }));
  assert.equal(url.pathname, "/vnc.html");
  assert.equal(url.searchParams.get("autoconnect"), "1");
  assert.equal(url.searchParams.get("resize"), "scale");
  assert.equal(url.searchParams.get("view_only"), "0");
});

test("the image ships the screen page, a real desktop and the Playwright MCP bin", () => {
  const dockerfile = renderBotDockerfile();
  assert.match(dockerfile, /\/usr\/share\/novnc\/nexux-screen\.html/);
  assert.match(dockerfile, /xfwm4 xfce4-panel xfce4-terminal thunar/);
  assert.match(dockerfile, /\/usr\/local\/lib\/nexux-bot\/cookies\.js/);
  const entry = renderBotEntrypoint();
  assert.match(entry, /xfce4-panel >/);
  assert.match(entry, /nexux-chrome\.desktop[\s\S]*nexux-terminal\.desktop[\s\S]*nexux-files\.desktop/);
  assert.match(entry, /--test-type --password-store=basic/);
  // The panel XML is well formed enough to carry its plugins in order.
  const panel = renderBotPanelConfig();
  assert.match(panel, /plugin-2" type="string" value="launcher"[\s\S]*plugin-5" type="string" value="tasklist"[\s\S]*plugin-7" type="string" value="clock"/);
  assert.equal(JSON.parse(renderBotMcpConfig()).mcpServers.browser.command, "playwright-mcp");
});

test("the screen page bridges the clipboard and maps ⌘ to Ctrl", () => {
  const page = renderBotScreenPage();
  assert.match(page, /clipboardPasteFrom/); // ⌘V / dashboard paste → remote clipboard
  assert.match(page, /ClipboardItem/); // remote copy → this machine's clipboard
  assert.match(page, /type: "nexux-clipboard"/); // reported to the dashboard
  assert.match(page, /e\.data\.type === "nexux-paste"/);
  assert.match(page, /e\.key === "Meta"/); // ⌘ never reaches Linux as Super
  assert.doesNotMatch(page, /\$\{/); // no unrendered template holes
});

test("the bot's computer can reach the user's machine as host.docker.internal", () => {
  const argv = botRunArgs({ name: "n", image: "i", envKeys: [] });
  assert.ok(argv.includes("--add-host=host.docker.internal:host-gateway"));
  const sys = renderBotSystemPrompt({ name: "B", needsInputMarker: "Q:", hostAppUrl: "http://host.docker.internal:3100" });
  assert.match(sys, /Nexus, the app you belong to, runs there at http:\/\/host\.docker\.internal:3100/);
  assert.match(sys, /anywhere earlier in the conversation/);
  assert.match(sys, /cannot see files on their disk/);
});

test("the bot is told how to show images: outbox references, not reading them itself", () => {
  const sys = renderBotSystemPrompt({ name: "B", needsInputMarker: "Q:" });
  assert.match(sys, /# Showing the user images and files/);
  assert.match(sys, /does NOT show it to them/);
  assert.match(sys, /!\[short caption\]\(outbox:\/\/name\.png\)/);
});

test("the computer mounts the shared workspace and a persistent profile", () => {
  const argv = botRunArgs({
    name: "n",
    image: "i",
    envKeys: [],
    mounts: [
      { host: "/Users/x/.nexux/workspace", container: "/workspace" },
      { host: "/Users/x/.nexux/bot-profiles/b1", container: "/home/bot/.chrome" },
    ],
  });
  const vs = argv.flatMap((a, i) => (a === "-v" ? [argv[i + 1]] : []));
  assert.deepEqual(vs, ["/Users/x/.nexux/workspace:/workspace", "/Users/x/.nexux/bot-profiles/b1:/home/bot/.chrome"]);
  assert.match(renderBotEntrypoint(), /rm -f "\$HOME\/\.chrome\/SingletonLock"/);
  assert.match(renderBotDockerfile(), /chown bot:bot \/workspace \/home\/bot\/\.chrome/);
  const sys = renderBotSystemPrompt({ name: "B", needsInputMarker: "Q:", workspaceFolder: "gastos" });
  assert.match(sys, /\/workspace\/gastos\/, where you start/);
  assert.match(sys, /shared with your teammates' computers/);
});

test("a prompt makes its working directory before cd'ing into it", async () => {
  // The bot's folder under /workspace is created host-side before the mount on
  // this machine, but a named volume on another daemon has no host side — and
  // `execRemote` starts with `cd`, so the run died on "No such file or
  // directory" before Claude saw the prompt.
  const dir = mkdtempSync(path.join(tmpdir(), "nexux-fake-docker-"));
  const log = path.join(dir, "calls.log");
  writeFileSync(path.join(dir, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`, {
    mode: 0o755,
  });
  const realPath = process.env.PATH;
  process.env.PATH = `${dir}:${realPath}`;
  try {
    // The fake docker streams nothing back, so the run itself cannot succeed;
    // the calls it made are the point.
    await runBotPrompt("hi", {
      container: "nexux-bot-x",
      systemPrompt: "s",
      cwd: "/workspace/gmail-ayudante",
    }).catch(() => undefined);
  } finally {
    process.env.PATH = realPath;
  }
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(calls[0], "exec -u bot nexux-bot-x mkdir -p /workspace/gmail-ayudante");
  assert.ok(
    calls.slice(1).some((c) => c.includes("cd '/workspace/gmail-ayudante'")),
    `no run cd'd into the folder: ${calls.join(" | ")}`,
  );
});

test("with Gmail connected, the bot is told to use the gmail tools and when it may send", () => {
  const base = { name: "Isa", needsInputMarker: "NEEDS_INPUT:" };
  const without = renderBotSystemPrompt(base);
  assert.doesNotMatch(without, /# Gmail/);
  assert.match(without, /Never send an email on your own/);
  const withGmail = renderBotSystemPrompt({ ...base, gmail: ["me@example.com"] });
  assert.match(withGmail, /# Gmail/);
  assert.match(withGmail, /`me@example\.com`/);
  assert.match(withGmail, /gmail_send` sends at once/);
  assert.match(withGmail, /Nexus sends it from their Gmail itself/);
  assert.doesNotMatch(withGmail, /send it from Gmail in your browser/);
});

test("with Calendar connected, the bot is told to use the calendar tools, check the slot, and never invite on its own", () => {
  const base = { name: "Isa", needsInputMarker: "NEEDS_INPUT:", timezone: "America/Bogota" };
  assert.doesNotMatch(renderBotSystemPrompt(base), /# Google Calendar/);
  const withCal = renderBotSystemPrompt({ ...base, calendar: ["me@example.com"] });
  assert.match(withCal, /# Google Calendar/);
  assert.match(withCal, /`me@example\.com`/);
  assert.match(withCal, /America\/Bogota/);
  assert.match(withCal, /calendar_freebusy/);
  assert.match(withCal, /`notify: true`.*only when the user asked for invitations/);
  assert.match(withCal, /Never add guests the user did not name/);
});

/** A `docker` on PATH that records its argv and answers from a script. */
function fakeDocker(behaviour: string): { dir: string; calls: () => string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "nexux-fake-docker-"));
  const log = path.join(dir, "calls.log");
  writeFileSync(
    path.join(dir, "docker"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n${behaviour}\n`,
    { mode: 0o755 },
  );
  return {
    dir,
    calls: () => {
      try {
        return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

async function withFakeDocker<T>(behaviour: string, fn: (calls: () => string[]) => Promise<T>): Promise<T> {
  const fake = fakeDocker(behaviour);
  const realPath = process.env.PATH;
  process.env.PATH = `${fake.dir}:${realPath}`;
  try {
    return await fn(fake.calls);
  } finally {
    process.env.PATH = realPath;
  }
}

test("docker exiting before it reads stdin is an exit code, not a crash", async () => {
  // ensureBotImage pipes the Dockerfile in on stdin, so a docker that fails
  // fast — or our own SIGKILL on timeout — leaves nobody reading it. A payload
  // past the pipe buffer makes the EPIPE certain instead of a race, which is
  // how it reached CI: an uncaughtException in these very tests, not a
  // rejected promise.
  const r = await withFakeDocker("exit 125", () =>
    dockerRun(null, ["build", "-f", "-", "."], { stdin: "x".repeat(1_000_000) }),
  );
  assert.equal(r.code, 125);
});

test("the image is built with --load, and a build that never lands is caught", async () => {
  // A docker-container buildx builder keeps the result in the build cache and
  // still exits 0. Without --load the bot would then start, find no image and
  // have docker fall back to Docker Hub — a 401 on a name never published.
  const calls = await withFakeDocker(
    'case "$*" in *"image inspect"*) exit 1 ;; *build*) exit 0 ;; esac\nexit 0',
    async (getCalls) => {
      await assert.rejects(
        () => ensureBotImage(),
        /not in this daemon's image store/,
        "a build whose image is missing afterwards must not be reported as success",
      );
      return getCalls();
    },
  );
  const build = calls.find((c) => c.startsWith("build "));
  assert.ok(build, `no build was attempted: ${calls.join(" | ")}`);
  assert.match(build, /(^| )--load( |$)/);
  // It asks twice: once before building, once to confirm the image landed.
  assert.equal(calls.filter((c) => c.includes("image inspect")).length, 2);
});

test("an older docker that does not know --load still builds", async () => {
  const calls = await withFakeDocker(
    'case "$*" in\n  *"image inspect"*) if [ -f "$0.built" ]; then exit 0; else exit 1; fi ;;\n'
      + '  *--load*) echo "unknown flag: --load" >&2; exit 125 ;;\n'
      + '  *build*) touch "$0.built"; exit 0 ;;\nesac\nexit 0',
    async (getCalls) => {
      // The retry drops the flag rather than refusing to build.
      await ensureBotImage();
      return getCalls();
    },
  );
  const builds = calls.filter((c) => c.startsWith("build "));
  assert.equal(builds.length, 2, `expected a retry, got: ${builds.join(" | ")}`);
  assert.match(builds[0], /--load/);
  assert.doesNotMatch(builds[1], /--load/);
});
