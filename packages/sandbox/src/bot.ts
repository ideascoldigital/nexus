// Bots: AI teammates that each get their own small computer. A bot session is
// a fresh, ephemeral Docker container with a desktop (Xvfb + fluxbox), a
// visible Chromium and Claude Code. The user watches the screen live through
// noVNC; Claude drives that same Chromium over CDP via the Playwright MCP, so
// everything it does in the browser happens on the screen the user sees.
//
// Nothing persists: the container runs with --rm and no volumes, and is thrown
// away when the session ends. Claude authenticates with the install's Claude
// Code OAuth token (the subscription), injected as an env var at `docker run`
// — the same token sandboxes use, and like them, `claude -p` only ever runs
// inside the container, never on the host.
//
// The image is described entirely in this module (`renderBotDockerfile`) and
// built from stdin, so it needs no build context on disk and works the same
// from the repo and from the packaged native app. Its tag carries a hash of
// the Dockerfile, so changing the recipe rebuilds automatically.

import { spawn } from "child_process";
import { createHash } from "crypto";
import { sandboxMemoryLimitMb } from "./local";
import {
  createStreamParser,
  execRemote,
  finalizeClaudeRun,
  shq,
  type ClaudeRunResult,
} from "./remote";
import type { LogSink } from "./types";

export const BOT_USER = "bot";
export const BOT_HOME = `/home/${BOT_USER}`;
export const BOT_WORKDIR = `${BOT_HOME}/work`;
export const BOT_DOWNLOADS = `${BOT_HOME}/Downloads`;
/** noVNC (websockify) inside the container. Published on host loopback only. */
export const BOT_NOVNC_PORT = 6080;
/** Chromium's DevTools endpoint — container-local, never published. */
export const BOT_CDP_PORT = 9222;
export const BOT_READY_MARKER = "/tmp/nexux-bot-ready";
export const BOT_FAILED_MARKER = "/tmp/nexux-bot-failed";
export const BOT_MCP_CONFIG = "/etc/nexux-bot/mcp.json";
/** The bot's own MCP servers (from its settings), rewritten before every prompt. Owner-only: may hold keys. */
export const BOT_USER_MCP_CONFIG = `${BOT_HOME}/.nexux-mcp.json`;
export const BOT_CONTAINER_LABEL = "nexux-bot=1";
export const BOT_IMAGE_REPO = "nexux-bot";
export const BOT_SCREEN = { width: 1440, height: 900 };
/** Shared, persistent folder: the same host folder is mounted in every bot's computer. */
export const BOT_WORKSPACE = "/workspace";
/** Chromium profile (sign-ins, cookies): mounted from a per-bot host folder so it persists. */
export const BOT_CHROME_PROFILE = `${BOT_HOME}/.chrome`;
/** Where a bot puts files it hands to the user (the app copies them into the chat). */
export const BOT_OUTBOX = `${BOT_HOME}/outbox`;

// ---- Image ------------------------------------------------------------------

/**
 * Started as PID 1's child (docker --init reaps zombies). Brings the desktop
 * up in dependency order, keeps Chromium alive if it is closed, and writes
 * the ready marker once Chromium's DevTools endpoint answers — that is the
 * moment Claude can drive the browser.
 */
export function renderBotEntrypoint(): string {
  const { width, height } = BOT_SCREEN;
  return `#!/usr/bin/env bash
set -u
export DISPLAY=:99
mkdir -p "$HOME/.vnc" "${BOT_WORKDIR}" "${BOT_DOWNLOADS}"

Xvfb :99 -screen 0 ${width}x${height}x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for _ in $(seq 1 100); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
if [ ! -e /tmp/.X11-unix/X99 ]; then
  echo "Xvfb did not start" > ${BOT_FAILED_MARKER}
  sleep infinity
fi

# A real desktop, like a teammate's computer: xfwm4 windows, a bottom bar
# with Chrome / Terminal / Files, the open windows and a clock. Dark, quiet.
export GTK_THEME=Adwaita:dark
mkdir -p "$HOME/.config/gtk-3.0"
printf '[Settings]\\ngtk-theme-name=Adwaita-dark\\ngtk-application-prefer-dark-theme=1\\n' > "$HOME/.config/gtk-3.0/settings.ini"
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
# A soft graphite gradient, like a fresh desktop.
hsetroot -add "#141416" -add "#2e2e33" -add "#18181a" -gradient 125 2>/dev/null || xsetroot -solid "#232326" 2>/dev/null || true

# One Chromium for the bot and for you: the launcher reuses its profile, so it
# opens a window in the running browser (same tabs, same sign-ins).
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/nexux-chrome" <<CHROME
#!/usr/bin/env bash
exec chromium --no-sandbox --test-type --password-store=basic --user-data-dir="$HOME/.chrome" "\$@"
CHROME
chmod +x "$HOME/.local/bin/nexux-chrome"

PANEL="$HOME/.config/xfce4/panel"
mkdir -p "$PANEL/launcher-2" "$PANEL/launcher-3" "$PANEL/launcher-4" \
  "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml"
cat > "$PANEL/launcher-2/nexux-chrome.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Chrome
Exec=$HOME/.local/bin/nexux-chrome
Icon=chromium
DESKTOP
cat > "$PANEL/launcher-3/nexux-terminal.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Terminal
Exec=xfce4-terminal --working-directory=${BOT_WORKSPACE}
Icon=utilities-terminal
DESKTOP
cat > "$PANEL/launcher-4/nexux-files.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Files
Exec=thunar ${BOT_WORKSPACE}
Icon=system-file-manager
DESKTOP
cat > "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml" <<'PANELXML'
${renderBotPanelConfig()}
PANELXML

xfwm4 --compositor=off >/tmp/xfwm4.log 2>&1 &
sleep 0.5
xfce4-panel >/tmp/panel.log 2>&1 &

# The VNC password comes from the session (VNC_PASSWORD, random per session).
x11vnc -storepasswd "\${VNC_PASSWORD:-nexux}" "$HOME/.vnc/passwd" >/dev/null 2>&1
x11vnc -display :99 -rfbauth "$HOME/.vnc/passwd" -forever -shared \\
  -rfbport 5900 -localhost -quiet >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc ${BOT_NOVNC_PORT} localhost:5900 \\
  >/tmp/websockify.log 2>&1 &

# Chromium on the visible display, reachable by the Playwright MCP over CDP.
# Restarted if the user (or Claude) closes it. --no-sandbox: the container is
# the sandbox, and Chromium's own needs user namespaces Docker does not grant.
# --test-type hides the "unsupported command-line flag" bar that flag brings.
# The profile is persistent (mounted from the host), so a lock left by the
# previous computer — another hostname — would stop Chromium: clear it.
(
  while true; do
    rm -f "$HOME/.chrome/SingletonLock" "$HOME/.chrome/SingletonSocket" "$HOME/.chrome/SingletonCookie"
    chromium --no-sandbox --test-type --password-store=basic --no-first-run --no-default-browser-check \\
      --disable-dev-shm-usage --disable-features=Translate \\
      --remote-debugging-address=127.0.0.1 --remote-debugging-port=${BOT_CDP_PORT} \\
      --user-data-dir="$HOME/.chrome" --window-position=0,0 \\
      --window-size=${width},${height} --start-maximized about:blank \\
      >/tmp/chromium.log 2>&1
    sleep 1
  done
) &

for _ in $(seq 1 240); do
  if curl -sf http://127.0.0.1:${BOT_CDP_PORT}/json/version >/dev/null; then
    touch ${BOT_READY_MARKER}
    break
  fi
  sleep 0.5
done
[ -f ${BOT_READY_MARKER} ] || echo "Chromium did not expose DevTools" > ${BOT_FAILED_MARKER}

wait
`;
}

/** The bottom bar: launchers centred (Chrome, Terminal, Files), open windows, clock on the right. */
export function renderBotPanelConfig(): string {
  const sep = (id: number) =>
    `    <property name="plugin-${id}" type="string" value="separator">
      <property name="expand" type="bool" value="true"/>
      <property name="style" type="uint" value="0"/>
    </property>`;
  const launcher = (id: number, file: string) =>
    `    <property name="plugin-${id}" type="string" value="launcher">
      <property name="items" type="array"><value type="string" value="${file}"/></property>
    </property>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="dark-mode" type="bool" value="true"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=10;x=0;y=0"/>
      <property name="length" type="uint" value="100"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="size" type="uint" value="34"/>
      <property name="icon-size" type="uint" value="20"/>
      <property name="background-style" type="uint" value="1"/>
      <property name="background-rgba" type="array">
        <value type="double" value="0.11"/><value type="double" value="0.11"/><value type="double" value="0.12"/><value type="double" value="1"/>
      </property>
      <property name="plugin-ids" type="array">
        <value type="int" value="1"/><value type="int" value="2"/><value type="int" value="3"/><value type="int" value="4"/>
        <value type="int" value="5"/><value type="int" value="6"/><value type="int" value="7"/>
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
${sep(1)}
${launcher(2, "nexux-chrome.desktop")}
${launcher(3, "nexux-terminal.desktop")}
${launcher(4, "nexux-files.desktop")}
    <property name="plugin-5" type="string" value="tasklist">
      <property name="flat-buttons" type="bool" value="true"/>
      <property name="show-handle" type="bool" value="false"/>
      <property name="show-labels" type="bool" value="true"/>
    </property>
${sep(6)}
    <property name="plugin-7" type="string" value="clock">
      <property name="mode" type="uint" value="2"/>
      <property name="digital-layout" type="uint" value="3"/>
      <property name="digital-time-format" type="string" value="%a %b %d   %I:%M %p"/>
    </property>
  </property>
</channel>`;
}

/**
 * Reads or writes the browser's cookies over DevTools (browser target,
 * Storage domain): \`node cookies.js get\` prints them as JSON; \`set\` reads
 * a JSON array of CookieParam on stdin. Node 22's global WebSocket — no deps.
 * This is how sign-ins are shared across the team's computers.
 */
export function renderBotCookieScript(): string {
  return `const fs = require("fs");
(async () => {
  const v = await (await fetch("http://127.0.0.1:${BOT_CDP_PORT}/json/version")).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const call = (method, params = {}) => new Promise((ok) => { const id = ++n; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const mode = process.argv[2];
  if (mode === "get") {
    const r = await call("Storage.getCookies");
    if (r.error) throw new Error(r.error.message);
    process.stdout.write(JSON.stringify(r.result.cookies || []));
  } else if (mode === "set") {
    const cookies = JSON.parse(fs.readFileSync(0, "utf8"));
    if (cookies.length) {
      const r = await call("Storage.setCookies", { cookies });
      if (r.error) throw new Error(r.error.message);
    }
    process.stdout.write(JSON.stringify({ ok: true, count: cookies.length }));
  } else throw new Error("usage: cookies.js get|set");
  ws.close();
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e && e.message || e)); process.exit(1); });
`;
}

export const BOT_COOKIE_SCRIPT = "/usr/local/lib/nexux-bot/cookies.js";

/** Claude Code MCP config: the Playwright MCP attached to the visible Chromium. */
export function renderBotMcpConfig(): string {
  return JSON.stringify(
    {
      mcpServers: {
        browser: {
          command: "playwright-mcp", // @playwright/mcp's bin
          args: ["--cdp-endpoint", `http://127.0.0.1:${BOT_CDP_PORT}`],
        },
      },
    },
    null,
    2,
  );
}

/**
 * The embedded screen: just the remote display, scaled to fit, no noVNC
 * chrome. Starts view-only; the dashboard flips control with a postMessage
 * from the parent window (no reconnect). The full vnc.html (clipboard, extra
 * keys) stays available for "open in a new tab".
 *
 * Clipboard and shortcuts, so the remote desktop feels like this machine:
 * - ⌘ never reaches Linux as Super. ⌘+key is sent as Ctrl+key (⌘L, ⌘T, ⌘A…).
 * - ⌘V: the browser pastes into a hidden box (a real paste gesture, no
 *   permission prompt), the text goes to the remote clipboard, then Ctrl+V.
 * - ⌘C / ⌘X: Ctrl+C on the remote; when x11vnc reports the new remote
 *   clipboard, it is written to this machine's clipboard (ClipboardItem with
 *   a pending promise keeps the user gesture alive, which WebKit requires).
 * - Every remote clipboard change is posted to the parent, and the parent can
 *   post text to paste — the dashboard's manual Copy / Paste fallback.
 */
export function renderBotScreenPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Bot screen</title>
<style>
html,body{margin:0;height:100%;background:#0a0a0c;overflow:hidden}
#screen{position:absolute;inset:0}
#msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#8a8a93;font:12px system-ui,sans-serif}
#pastebox{position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0}
</style></head>
<body><div id="screen"></div><div id="msg">Connecting…</div><textarea id="pastebox" aria-hidden="true"></textarea>
<script type="module">
import RFB from "./core/rfb.js";
const q = new URLSearchParams(location.search);
const msg = document.getElementById("msg");
const pasteBox = document.getElementById("pastebox");
const CTRL = 0xffe3;
let rfb = null;
let viewOnly = q.get("view_only") !== "0";
let pendingCopy = null;

function ctrlCombo(ch) {
  rfb.sendKey(CTRL, "ControlLeft", true);
  rfb.sendKey(ch.charCodeAt(0), "Key" + ch.toUpperCase());
  rfb.sendKey(CTRL, "ControlLeft", false);
}

function pasteText(text) {
  if (!rfb || viewOnly || !text) return;
  rfb.clipboardPasteFrom(text);
  // Let x11vnc own the X clipboard before the app asks for it.
  setTimeout(() => { ctrlCombo("v"); rfb.focus(); }, 80);
}

function copyToHost() {
  const text = new Promise((resolve, reject) => {
    pendingCopy = resolve;
    setTimeout(() => { if (pendingCopy === resolve) { pendingCopy = null; reject(new Error("no clipboard change")); } }, 2000);
  });
  try {
    navigator.clipboard
      .write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })])
      .catch(() => {});
  } catch {
    text.then((t) => navigator.clipboard.writeText(t)).catch(() => {});
  }
}

function connect() {
  rfb = new RFB(document.getElementById("screen"), "ws://" + location.host + "/websockify", {
    credentials: { password: q.get("password") || "" },
  });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.viewOnly = viewOnly;
  rfb.background = "#0a0a0c";
  rfb.addEventListener("connect", () => { msg.style.display = "none"; });
  rfb.addEventListener("disconnect", () => {
    msg.textContent = "Reconnecting…";
    msg.style.display = "flex";
    setTimeout(connect, 1500);
  });
  rfb.addEventListener("clipboard", (e) => {
    const text = e.detail.text;
    if (pendingCopy) { pendingCopy(text); pendingCopy = null; }
    window.parent.postMessage({ type: "nexux-clipboard", text }, "*");
  });
}

// Capture phase on window: runs before noVNC's own listeners on its canvas.
window.addEventListener("keydown", (e) => {
  if (!rfb || viewOnly) return;
  if (e.key === "Meta") { e.stopImmediatePropagation(); return; }
  if (!e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
  e.stopImmediatePropagation();
  const k = e.key.toLowerCase();
  if (k === "v") {
    // No preventDefault: the browser's own paste lands in the hidden box.
    pasteBox.value = "";
    pasteBox.focus();
    return;
  }
  e.preventDefault();
  if (k === "c" || k === "x") copyToHost();
  if (k >= "a" && k <= "z") ctrlCombo(k);
}, true);
window.addEventListener("keyup", (e) => {
  if (e.key === "Meta" || e.metaKey) e.stopImmediatePropagation();
}, true);
pasteBox.addEventListener("paste", (e) => {
  e.preventDefault();
  pasteText(e.clipboardData ? e.clipboardData.getData("text/plain") : "");
});

window.addEventListener("message", (e) => {
  if (e.source !== window.parent || !e.data) return;
  if (typeof e.data.viewOnly === "boolean") {
    viewOnly = e.data.viewOnly;
    if (rfb) {
      rfb.viewOnly = viewOnly;
      if (!viewOnly) rfb.focus();
    }
  }
  if (e.data.type === "nexux-paste" && typeof e.data.text === "string") pasteText(e.data.text);
});
connect();
</script></body></html>
`;
}

export const BOT_SCREEN_PAGE = "nexux-screen.html";

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * The whole image recipe. Debian rather than Ubuntu because Ubuntu ships
 * Chromium only as a snap (no snapd in a container); Debian's `chromium`
 * package is a real .deb on both amd64 and arm64 — Google Chrome has no
 * linux/arm64 build, and Apple Silicon hosts run arm64 containers.
 *
 * Files are embedded base64 so the Dockerfile needs no build context.
 */
export function renderBotDockerfile(): string {
  const claudeJson = JSON.stringify({ hasCompletedOnboarding: true });
  return `FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC
RUN apt-get update && apt-get install -y --no-install-recommends \\
      ca-certificates curl gnupg git jq unzip python3 procps \\
      xvfb x11vnc fluxbox novnc websockify xdotool scrot dbus-x11 \\
      chromium fonts-liberation fonts-dejavu fonts-noto-color-emoji \\
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \\
    && apt-get install -y --no-install-recommends nodejs \\
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @playwright/mcp \\
    && npm cache clean --force
RUN useradd -m -s /bin/bash ${BOT_USER} \\
    && mkdir -p /tmp/.X11-unix /etc/nexux-bot ${BOT_WORKSPACE} ${BOT_CHROME_PROFILE} \\
    && chown ${BOT_USER}:${BOT_USER} ${BOT_WORKSPACE} ${BOT_CHROME_PROFILE} \\
    && chmod 1777 /tmp/.X11-unix
# The desktop (its own layer, so the big ones above stay cached).
RUN apt-get update && apt-get install -y --no-install-recommends \\
      xfwm4 xfce4-panel xfce4-terminal thunar xfconf x11-xserver-utils hsetroot adwaita-icon-theme \\
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /usr/local/lib/nexux-bot \\
    && echo ${b64(renderBotCookieScript())} | base64 -d > ${BOT_COOKIE_SCRIPT} \\
    && chmod 644 ${BOT_COOKIE_SCRIPT}
RUN echo ${b64(renderBotEntrypoint())} | base64 -d > /usr/local/bin/nexux-bot-entrypoint \\
    && chmod 755 /usr/local/bin/nexux-bot-entrypoint \\
    && echo ${b64(renderBotMcpConfig())} | base64 -d > ${BOT_MCP_CONFIG} \\
    && chmod 644 ${BOT_MCP_CONFIG} \\
    && echo ${b64(renderBotScreenPage())} | base64 -d > /usr/share/novnc/${BOT_SCREEN_PAGE} \\
    && chmod 644 /usr/share/novnc/${BOT_SCREEN_PAGE} \\
    && echo ${b64(claudeJson)} | base64 -d > ${BOT_HOME}/.claude.json \\
    && chown ${BOT_USER}:${BOT_USER} ${BOT_HOME}/.claude.json
USER ${BOT_USER}
WORKDIR ${BOT_HOME}
EXPOSE ${BOT_NOVNC_PORT}
CMD ["/usr/local/bin/nexux-bot-entrypoint"]
`;
}

/** `nexux-bot:<hash>` — a new recipe is a new tag, so it rebuilds by itself. */
export function botImageTag(dockerfile = renderBotDockerfile()): string {
  const hash = createHash("sha256").update(dockerfile).digest("hex").slice(0, 12);
  return `${BOT_IMAGE_REPO}:${hash}`;
}

// ---- Docker plumbing ----------------------------------------------------------

function docker(
  args: string[],
  opts: {
    onLog?: LogSink;
    timeoutMs?: number;
    stdin?: string;
    env?: Record<string, string>;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      // Secrets ride in the child's environment and are referenced by name
      // (`-e KEY`), so they never appear in argv / `ps`.
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : undefined;
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
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

function tail(text: string, n = 400): string {
  return text.trim().slice(-n);
}

/** Build the bot image unless this exact recipe is already built. */
export async function ensureBotImage(opts: { onLog?: LogSink } = {}): Promise<string> {
  const dockerfile = renderBotDockerfile();
  const tag = botImageTag(dockerfile);
  const exists = await docker(["image", "inspect", tag], { timeoutMs: 15_000 });
  if (exists.code === 0) return tag;

  opts.onLog?.(`[bot] building image ${tag} (first run takes a few minutes)\n`);
  const built = await docker(["build", "-t", tag, "-"], {
    stdin: dockerfile,
    onLog: opts.onLog,
    timeoutMs: 30 * 60_000,
  });
  if (built.code !== 0) {
    throw new Error(`bot image build failed: ${tail(built.stderr || built.stdout)}`);
  }
  return tag;
}

/** `docker run` argv for a bot session. Pure — env values are not in it. */
export function botRunArgs(opts: {
  name: string;
  image: string;
  envKeys: string[];
  memoryMb?: number | null;
  /** Host folders bind-mounted into the computer (the shared workspace, the browser profile). */
  mounts?: { host: string; container: string }[];
}): string[] {
  return [
    "run",
    "-d",
    "--rm", // ephemeral: stopping the session deletes the machine
    "--init",
    "--shm-size=1g", // Chromium crashes tabs on Docker's 64 MB default
    ...(opts.memoryMb ? ["--memory", `${opts.memoryMb}m`] : []),
    // noVNC on host loopback, random port: reachable from this machine only.
    "-p",
    `127.0.0.1::${BOT_NOVNC_PORT}`,
    ...opts.envKeys.flatMap((k) => ["-e", k]),
    // The computer is throwaway; these folders are not.
    ...(opts.mounts ?? []).flatMap((m) => ["-v", `${m.host}:${m.container}`]),
    "--name",
    opts.name,
    "--hostname",
    opts.name,
    // The user's machine (where Nexus runs) as host.docker.internal — Docker
    // Desktop provides it; on Linux this maps it to the host gateway.
    "--add-host=host.docker.internal:host-gateway",
    "--label",
    BOT_CONTAINER_LABEL,
    opts.image,
  ];
}

/** `127.0.0.1:49153` (one line per binding) → 49153. */
export function parsePublishedPort(output: string): number | null {
  for (const line of output.split("\n")) {
    const m = line.trim().match(/:(\d+)$/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Start a bot's computer. Resolves once the container runs; poll
 * `botReadiness` to know when the desktop and Chromium are up.
 */
export async function launchBotContainer(opts: {
  name: string;
  env: Record<string, string>;
  mounts?: { host: string; container: string }[];
  onLog?: LogSink;
}): Promise<{ containerName: string; vncPort: number }> {
  const image = await ensureBotImage({ onLog: opts.onLog });
  const memoryMb = await sandboxMemoryLimitMb();
  const created = await docker(
    botRunArgs({
      name: opts.name,
      image,
      envKeys: Object.keys(opts.env),
      memoryMb,
      mounts: opts.mounts,
    }),
    { env: opts.env, timeoutMs: 120_000 },
  );
  if (created.code !== 0) {
    throw new Error(`docker run failed: ${tail(created.stderr || created.stdout)}`);
  }
  const port = await docker(["port", opts.name, `${BOT_NOVNC_PORT}/tcp`], {
    timeoutMs: 15_000,
  });
  const vncPort = parsePublishedPort(port.stdout);
  if (!vncPort) {
    await stopBotContainer(opts.name);
    throw new Error("could not read the bot's published noVNC port");
  }
  return { containerName: opts.name, vncPort };
}

export type BotReadiness = "ready" | "starting" | { failed: string };

export async function botReadiness(name: string): Promise<BotReadiness> {
  const res = await docker(
    [
      "exec",
      name,
      "bash",
      "-c",
      `if [ -f ${BOT_READY_MARKER} ]; then echo READY; elif [ -f ${BOT_FAILED_MARKER} ]; then echo "FAILED:$(cat ${BOT_FAILED_MARKER})"; else echo STARTING; fi`,
    ],
    { timeoutMs: 15_000 },
  ).catch(() => null);
  if (!res || res.code !== 0) {
    return { failed: tail(res?.stderr ?? "container is not running", 200) || "container is not running" };
  }
  const out = res.stdout.trim();
  if (out === "READY") return "ready";
  if (out.startsWith("FAILED:")) return { failed: out.slice(7) || "desktop failed to start" };
  return "starting";
}

/** Remove the container (and, being --rm, everything in it). Idempotent. */
export async function stopBotContainer(name: string): Promise<void> {
  await docker(["rm", "-f", name], { timeoutMs: 60_000 }).catch(() => undefined);
}

/** Every bot container on this engine, running or not. */
export async function listBotContainers(): Promise<string[]> {
  const res = await docker(
    ["ps", "-a", "--filter", `label=${BOT_CONTAINER_LABEL}`, "--format", "{{.Names}}"],
    { timeoutMs: 15_000 },
  ).catch(() => null);
  if (!res || res.code !== 0) return [];
  return res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Size in bytes of a file inside a bot's computer, or null if it is not a regular file. */
export async function botFileSize(name: string, path: string): Promise<number | null> {
  const res = await docker(["exec", name, "stat", "-L", "-c", "%F %s", path], { timeoutMs: 15_000 }).catch(() => null);
  if (!res || res.code !== 0) return null;
  const m = res.stdout.trim().match(/^regular(?: empty)? file (\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Copy one file out of a bot's computer onto this machine. */
export async function copyFromBot(name: string, path: string, dest: string): Promise<boolean> {
  const res = await docker(["cp", "-L", `${name}:${path}`, dest], { timeoutMs: 60_000 }).catch(() => null);
  return Boolean(res && res.code === 0);
}

/** A cookie as DevTools reports it (Storage.getCookies). */
export type BotCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  session?: boolean;
  sameSite?: string;
  priority?: string;
  sourceScheme?: string;
  sourcePort?: number;
  partitionKey?: unknown;
  [k: string]: unknown;
};

/** Every cookie in a computer's browser (sign-ins included). Secret material: never log it. */
export async function getBotCookies(name: string): Promise<BotCookie[]> {
  const res = await docker(["exec", "-u", BOT_USER, name, "node", BOT_COOKIE_SCRIPT, "get"], { timeoutMs: 20_000 });
  if (res.code !== 0) throw new Error(`could not read cookies: ${tail(res.stderr, 200)}`);
  return JSON.parse(res.stdout) as BotCookie[];
}

/**
 * Write the bot's own MCP servers into its computer (or remove them when it
 * has none). Their env/headers may hold API keys: they travel on stdin and the
 * file is readable by the bot user only.
 */
export async function writeBotMcpConfig(name: string, servers: Record<string, unknown> | null): Promise<void> {
  const script = servers
    ? `umask 077 && cat > ${BOT_USER_MCP_CONFIG}`
    : `rm -f ${BOT_USER_MCP_CONFIG}`;
  const res = await docker(["exec", "-i", "-u", BOT_USER, name, "sh", "-c", script], {
    stdin: servers ? JSON.stringify({ mcpServers: servers }) : "",
    timeoutMs: 15_000,
  });
  if (res.code !== 0) throw new Error(`could not write the MCP config: ${tail(res.stderr, 200)}`);
}

/** Set cookies in a computer's browser. Values travel on stdin, never in argv. */
export async function setBotCookies(name: string, cookies: Record<string, unknown>[]): Promise<void> {
  if (cookies.length === 0) return;
  const res = await docker(["exec", "-i", "-u", BOT_USER, name, "node", BOT_COOKIE_SCRIPT, "set"], {
    stdin: JSON.stringify(cookies),
    timeoutMs: 20_000,
  });
  if (res.code !== 0) throw new Error(`could not set cookies: ${tail(res.stderr, 200)}`);
}

/**
 * Kill any Claude run still going inside a computer. Used when Nexux restarts
 * and adopts a live container: the old process's runs have no supervisor.
 */
export async function stopBotClaudeRuns(name: string): Promise<void> {
  // Only the CLI (`claude …` or node running @anthropic-ai/claude-code), not
  // anything else whose arguments merely mention "claude".
  await docker(["exec", name, "pkill", "-f", "^claude |@anthropic-ai/claude-code"], { timeoutMs: 15_000 }).catch(
    () => null,
  );
}

// ---- Claude ------------------------------------------------------------------

/** Fence of the multiple-choice block bots end a reply with (the dashboard renders it). */
export const BOT_CHOICES_FENCE = "choices";
/** Fence of the block a bot creates, changes or removes a routine with. */
export const BOT_ROUTINE_FENCE = "routine";
/** Fence of the block a bot messages a teammate (another bot) with. */
export const BOT_HANDOFF_FENCE = "handoff";
/** Fence of the block a bot drafts an email for the user to review with. */
export const BOT_MAIL_FENCE = "mail";

/** What the bot knows about itself and its computer, every run. */
export function renderBotSystemPrompt(bot: {
  name: string;
  role?: string | null;
  instructions?: string | null;
  needsInputMarker: string;
  /** Its current routines, so it can change them by name. */
  routines?: { name: string; cron: string; label: string; prompt: string; enabled: boolean }[];
  /** The user's timezone — routine crons are written in it. */
  timezone?: string;
  /** Nexus as seen from inside the container, e.g. http://host.docker.internal:3100. */
  hostAppUrl?: string;
  /** The other bots on the user's team, so it can hand work to them. */
  teammates?: { name: string; role?: string | null }[];
  /** Its own folder under the shared workspace, e.g. "creative-designer". */
  workspaceFolder?: string;
  /** Names of its own MCP servers (besides the browser), from its settings. */
  mcpServers?: string[];
}): string {
  const parts = [
    `You are "${bot.name}", an AI teammate${bot.role?.trim() ? ` whose job is: ${bot.role.trim()}` : ""}.`,
    "",
    "You run inside your own small Linux computer (Debian, user `bot`). The user is watching its screen live, so work visibly:",
    `- A Chromium browser is already open on the desktop. For anything on the web, use the \`browser\` MCP tools (Playwright, attached to that same Chromium) so the user sees each step. Never start a separate or headless browser.`,
    `- You also have a shell. Work in ${BOT_WORKDIR}; downloads land in ${BOT_DOWNLOADS}. \`xdotool\` and \`scrot\` are available for the rest of the desktop.`,
    "- Sign-ins are shared with your teammates: when any bot (or the user, on any bot's screen) signs into a site, every bot's browser gets that session — except Google (Gmail, Drive, Ads, YouTube…), which refuses shared sessions, so each bot signs into Google on its own and keeps it. Always check whether you are already signed in first. If you are not and you need it, ask the user to sign in on your screen: end your reply with the input marker line saying which site and account.",
    `- Your computer is reset whenever it goes to sleep, but two things persist: ${BOT_WORKSPACE} and your browser sign-ins. ${BOT_WORKSPACE} is shared with your teammates' computers, and the user sees it on their Mac. Keep your work in your own folder${bot.workspaceFolder ? ` (${BOT_WORKSPACE}/${bot.workspaceFolder}/, where you start)` : ""}, one subfolder per task with a clear name. Read teammates' folders freely; don't change or delete their files unless they or the user ask. Anything outside ${BOT_WORKSPACE} is lost when the computer sleeps.`,
    `- If you need a login, a password, a decision, or anything only the user has, stop and ask: end your reply with a final line starting exactly with "${bot.needsInputMarker}" followed by the question. The user can also take over the screen to type credentials themselves.`,
    "- Your computer is not the user's computer. Inside it, `localhost` and `127.0.0.1` are your own machine, where nothing of theirs runs. The user's machine is reachable as `host.docker.internal`" +
      (bot.hostAppUrl ? `, and Nexus, the app you belong to, runs there at ${bot.hostAppUrl}` : "") +
      ". So whenever a URL points at localhost or 127.0.0.1 — in this message or anywhere earlier in the conversation — open it with host.docker.internal instead, same port and path (http://localhost:3100/icon.svg → http://host.docker.internal:3100/icon.svg). Try that before saying something is unreachable. You cannot see files on their disk: for those, ask for a link or the content.",
    "- Reply in the user's language. Keep the final reply short: what you did, what you found, what is left.",
    "",
    "# Showing the user images and files",
    "",
    "The user only sees what is in your reply. Looking at an image yourself (the Read tool, a screenshot you inspect, a page open in your browser) does NOT show it to them, and links to localhost or to paths on your computer do not open for them.",
    `To show an image or hand over a file: copy it into ${BOT_OUTBOX}/ (\`mkdir -p ${BOT_OUTBOX}\`) and reference it in your reply as \`![short caption](outbox://name.png)\` for images (png, jpg, gif, webp, svg) or \`[name.pdf](outbox://name.pdf)\` for any other file. The app copies these into the chat, where the user sees the images inline and downloads the files.`,
    `Do this whenever the user asks to see something, and whenever you made something visual (designs, charts, screenshots) — show it, do not just describe it. For what is on your screen: \`scrot ${BOT_OUTBOX}/screen.png\`. Keep names simple (letters, digits, - _ .), one file per reference, up to 25 MB each.`,
    "",
    "# How you talk",
    "",
    "You are a teammate in a chat, not a report generator. Write short, warm, plain messages; no headings or long lists unless the user asks for a document.",
    "When the user has to decide something (what to do first, which option, how to proceed), ask ONE question and offer 2 to 5 concrete options, as a block at the very end of your reply:",
    "",
    "```" + BOT_CHOICES_FENCE,
    '{"question": "What should I test first?", "options": ["The signup flow", "The billing page"]}',
    "```",
    "",
    "The app shows the options as buttons (A, B, C…) and adds a \"Something else\" choice by itself, so never add an \"other\" option. Keep options short (a few words) and specific to what you know about the user and their work. Put the question only in the block, not also in your text. When the user picks one, its text comes back as their message.",
    `Use the choices block for decisions; use "${bot.needsInputMarker}" when you need something typed (a password, a URL, an account).`,
  ];
  parts.push(
    "",
    "# Routines",
    "",
    "You can take on recurring work: a routine wakes you on a schedule and gives you its prompt. When the user asks for something recurring, or agrees to your suggestion that a task should repeat, create it by ending your reply with:",
    "",
    "```" + BOT_ROUTINE_FENCE,
    '{"name": "Update the expense log", "cron": "0 8 * * 1", "prompt": "Check the inbox for new invoices and add each one as a row in the expense sheet.", "enabled": true}',
    "```",
    "",
    `- \`cron\` is 5-field cron in the user's timezone (${bot.timezone ?? "the host's"}). \`prompt\` is what future you does each time, self-contained: by then your computer may be fresh and you may need to sign in again.`,
    "- To change one, send the block again with its exact name and only the fields that change. To remove one: {\"name\": \"…\", \"delete\": true}. Pause with \"enabled\": false.",
    "- The app shows the change in the chat and in your panel; also say it in plain words. If a task you just did looks like it will repeat, suggest a routine (a choices question is a good way).",
  );
  parts.push(
    "",
    "# Emails",
    "",
    "Never send an email on your own. When you write one for the user (a reply, a follow-up, a welcome…), put each email in a block at the end of your reply:",
    "",
    "```" + BOT_MAIL_FENCE,
    '{"from": "me@example.com", "to": "ana@example.com", "cc": "", "subject": "Welcome to Acme", "body": "Hi Ana,\\n\\nThanks for signing up…\\n\\nBest,\\nAlex"}',
    "```",
    "",
    "- The app shows each block as an email card the user can edit, with Send and Discard. When they press Send, you get a message asking you to send it from Gmail in your browser, exactly as they left it — that is the only time you send.",
    "- One block per email (several are fine). `body` is plain text with \\n line breaks, complete with greeting and signature. `from` is the Google account you are signed in with, if you know it. `cc`/`bcc` are optional, comma-separated.",
    "- In your text, say briefly what the emails are; don't paste them again outside the blocks.",
  );
  parts.push(
    "",
    "# Your teammates",
    "",
    "You are one of several bots on the user's team, each with its own job and computer. Work like a team: on every task, first check the list below — any part that belongs to a teammate's job goes to them, and you do your own part. Also hand off when the user asks you to pass something on. Message a teammate by ending your reply with:",
    "",
    "```" + BOT_HANDOFF_FENCE,
    '{"to": "Creative Designer", "message": "Please make a 1080x1080 banner for the launch. Copy: … Logo: ![logo](outbox://logo.svg)", "reply": true}',
    "```",
    "",
    "- Use the teammate's exact name in \"to\". Write the message like a short chat message to a colleague (the chat shows it as \"@Name …\", so don't repeat their name at the start). Make it self-contained: what you need, why, by when, and the material (files go in your outbox and are referenced like in your replies — the teammate can download them).",
    "- One block per teammate; you can message several. Tell the user in plain words that you did.",
    "- Add \"reply\": true when you need their answer to finish your task (e.g. you'll pick the best option, combine it, publish it): when they are done, their answer comes back to you automatically and you continue. Leave it out when you are just passing work on.",
    "- Once you hand something off, its answer shows up in a thread under your message, where the user reads it. So in that same reply, don't ask the user about the handed-off part — at most one question, and only for a decision you need now.",
    "- Messages from teammates arrive marked as such: they are colleagues, not the user. Never message a teammate just to acknowledge, confirm or say \"done\" — only when they must act on something. If something is unclear, ask the user.",
  );
  if (bot.teammates?.length) {
    parts.push("", "Your teammates:");
    for (const t of bot.teammates) parts.push(`- ${t.name}${t.role?.trim() ? ` — ${t.role.trim()}` : ""}`);
  } else {
    parts.push("", "You have no teammates yet.");
  }
  if (bot.routines?.length) {
    parts.push("", "Your routines now:");
    for (const r of bot.routines) {
      parts.push(`- "${r.name}" — ${r.label} (\`${r.cron}\`)${r.enabled ? "" : ", paused"}: ${r.prompt}`);
    }
  }
  if (bot.mcpServers?.length) {
    parts.push(
      "",
      "# Your tools",
      "",
      `Besides the browser, the user connected these MCP servers for you: ${bot.mcpServers.map((n) => `\`${n}\``).join(", ")} (their tools are named \`mcp__<server>__<tool>\`). When one covers the task, use it instead of clicking through the website — it is faster and more reliable — and tell the user briefly which one you used. If one fails (not authorized, unreachable), say so plainly and fall back to the browser if you can.`,
    );
  }
  if (bot.instructions?.trim()) {
    parts.push("", "# Standing instructions", "", bot.instructions.trim());
  }
  return parts.join("\n");
}

export function buildBotClaudeCommand(
  prompt: string,
  opts: {
    systemPrompt: string;
    resumeSessionId?: string | null;
    model?: string | null;
    /** Also load BOT_USER_MCP_CONFIG (the bot's own servers, written by writeBotMcpConfig). */
    userMcp?: boolean;
  },
): string {
  const resume = opts.resumeSessionId ? `--resume ${shq(opts.resumeSessionId)} ` : "";
  const model = opts.model?.trim() ? `--model ${shq(opts.model.trim())} ` : "";
  return (
    `claude ${resume}${model}-p ${shq(prompt)}` +
    ` --append-system-prompt ${shq(opts.systemPrompt)}` +
    ` --mcp-config ${BOT_MCP_CONFIG}${opts.userMcp ? ` ${BOT_USER_MCP_CONFIG}` : ""}` +
    ` --permission-mode bypassPermissions --output-format stream-json --verbose`
  );
}

/** One prompt on a running bot, streamed through the same parser as sandboxes. */
export async function runBotPrompt(
  prompt: string,
  opts: {
    container: string;
    systemPrompt: string;
    resumeSessionId?: string | null;
    model?: string | null;
    userMcp?: boolean;
    onLog?: LogSink;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Working directory for Claude; defaults to the scratch BOT_WORKDIR. */
    cwd?: string;
  },
): Promise<ClaudeRunResult> {
  const parser = createStreamParser(opts.onLog);
  const res = await execRemote(buildBotClaudeCommand(prompt, opts), {
    container: opts.container,
    user: BOT_USER,
    cwd: opts.cwd ?? BOT_WORKDIR,
    onLog: parser.handleChunk,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  parser.flush();
  return finalizeClaudeRun(parser.getFinal(), res, { timeoutMs: opts.timeoutMs });
}

/**
 * A session's screen on this machine's loopback: the bare embedded screen
 * (view-only until the dashboard hands over control), or `full` noVNC with
 * its control bar, clipboard and extra keys.
 */
export function botVncUrl(
  vncPort: number,
  password: string,
  opts: { viewOnly?: boolean; full?: boolean } = {},
): string {
  const base = `http://127.0.0.1:${vncPort}`;
  if (opts.full) {
    const q = new URLSearchParams({
      autoconnect: "1",
      resize: "scale",
      reconnect: "1",
      password,
      view_only: opts.viewOnly ? "1" : "0",
    });
    return `${base}/vnc.html?${q.toString()}`;
  }
  const q = new URLSearchParams({ password, view_only: opts.viewOnly === false ? "0" : "1" });
  return `${base}/${BOT_SCREEN_PAGE}?${q.toString()}`;
}
