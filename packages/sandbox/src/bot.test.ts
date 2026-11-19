import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
  BOT_CONTAINER_LABEL,
  BOT_MCP_CONFIG,
  BOT_NOVNC_PORT,
  botImageTag,
  botRunArgs,
  botVncUrl,
  buildBotClaudeCommand,
  parsePublishedPort,
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

  const bare = renderBotSystemPrompt({ name: "B", needsInputMarker: "Q:" });
  assert.doesNotMatch(bare, /Standing instructions/);
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
