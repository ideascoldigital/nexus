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
import {
  dockerHostArgs,
  IMAGE_NOT_IN_STORE,
  LOAD_FLAG,
  rejectedBuildFlag,
  type DockerTarget,
} from "./docker-endpoint";
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
/** How long Claude waits for a bot's MCP servers to start (MCP_TIMEOUT): room for a cold `npx -y`. */
export const BOT_MCP_STARTUP_MS = 180_000;
export const BOT_CONTAINER_LABEL = "nexux-bot=1";
export const BOT_IMAGE_REPO = "nexux-bot";
export const BOT_SCREEN = { width: 1440, height: 900 };
/** Shared, persistent folder: the same host folder is mounted in every bot's computer. */
export const BOT_WORKSPACE = "/workspace";
/** Chromium profile (sign-ins, cookies): mounted from a per-bot host folder so it persists. */
export const BOT_CHROME_PROFILE = `${BOT_HOME}/.chrome`;
/** Where a bot puts files it hands to the user (the app copies them into the chat). */
export const BOT_OUTBOX = `${BOT_HOME}/outbox`;
/**
 * Claude Code's own folder in the computer, mounted from a per-bot host folder
 * so it persists (spec 37). What has to survive is `.credentials.json`: the
 * OAuth tokens `claude mcp login` stores for a bot's remote MCP servers, keyed
 * by the server's name and the hash of its type, url and headers — so a run
 * that loads the same server through `--mcp-config` finds the sign-in again,
 * on this computer and on every computer after it.
 */
export const BOT_CLAUDE_DIR = `${BOT_HOME}/.claude`;

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
/** Puts one MCP server into Claude's own user config, so `claude mcp` can act on it by name. */
export const BOT_MCP_REGISTER_SCRIPT = "/usr/local/lib/nexux-bot/mcp-register.js";
/** The sign-in a user watches: `claude mcp login <name>` in a terminal on the bot's desktop. */
export const BOT_MCP_LOGIN_SCRIPT = "/usr/local/lib/nexux-bot/mcp-login.sh";

/**
 * Puts one MCP server into Claude Code's own user config inside the computer
 * (spec 37). `claude mcp login`, `logout` and `get` act on servers Claude has
 * configured — they ignore `--mcp-config`, which is how a bot's servers reach
 * its runs — so a server has to be registered by name before it can be signed
 * into or asked about. The definition arrives on stdin: its headers may carry
 * a key, and argv is readable from the rest of the computer.
 *
 * The registration itself is throwaway (the file dies with the container, and
 * runs pass --strict-mcp-config so it never changes what a prompt loads).
 * What is worth keeping is what the sign-in leaves behind in BOT_CLAUDE_DIR.
 */
export function renderBotMcpRegisterScript(): string {
  return `const fs = require("fs");
const path = require("path");
const file = path.join(process.env.HOME || "${BOT_HOME}", ".claude.json");
const { name, server } = JSON.parse(fs.readFileSync(0, "utf8"));
if (!name || typeof name !== "string") throw new Error("a server name is required");
let config = {};
try { config = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
config.mcpServers = config.mcpServers || {};
if (server) config.mcpServers[name] = server;
else delete config.mcpServers[name];
fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
process.stdout.write(JSON.stringify({ ok: true }));
`;
}

/**
 * The sign-in the user watches (spec 37): a terminal window on the bot's own
 * desktop running `claude mcp login <name>`, which opens the consent page in
 * the bot's Chromium — the same browser whose profile outlives the computer.
 * The user takes control of the screen, approves, and the token lands in
 * BOT_CLAUDE_DIR.
 *
 * It runs on the desktop rather than through `docker exec` on purpose: the CLI
 * wants a terminal, the OAuth callback is a local redirect that only a browser
 * inside this computer can reach, and the user can see what went wrong.
 */
export function renderBotMcpLoginScript(): string {
  return `#!/usr/bin/env bash
set -u
name="\${1:-}"
log="\${2:-/dev/null}"
exec > >(tee -a "$log") 2>&1
if [ -z "$name" ]; then echo "usage: mcp-login.sh <server name>"; sleep 5; exit 2; fi
echo "Signing in to the MCP server '$name'."
echo "A page will open in your browser: approve the access there."
echo
claude mcp login "$name"
code=$?
echo
if [ $code -eq 0 ]; then
  echo "Signed in. This sign-in is kept for this bot, so its next computer will have it too."
else
  echo "The sign-in did not finish (exit $code). You can close this window and try again from Nexus."
fi
echo
echo "Closing in 30 seconds. Press Enter to close now."
read -r -t 30 _ || true
`;
}

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
      xvfb x11vnc fluxbox novnc websockify xdotool scrot dbus-x11 xdg-utils \\
      chromium fonts-liberation fonts-dejavu fonts-noto-color-emoji \\
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \\
    && apt-get install -y --no-install-recommends nodejs \\
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @playwright/mcp \\
    && npm cache clean --force
RUN useradd -m -s /bin/bash ${BOT_USER} \\
    && mkdir -p /tmp/.X11-unix /etc/nexux-bot ${BOT_WORKSPACE} ${BOT_CHROME_PROFILE} ${BOT_CLAUDE_DIR} \\
    && chown ${BOT_USER}:${BOT_USER} ${BOT_WORKSPACE} ${BOT_CHROME_PROFILE} ${BOT_CLAUDE_DIR} \\
    && chmod 1777 /tmp/.X11-unix
# The desktop (its own layer, so the big ones above stay cached).
RUN apt-get update && apt-get install -y --no-install-recommends \\
      xfwm4 xfce4-panel xfce4-terminal thunar xfconf x11-xserver-utils hsetroot adwaita-icon-theme \\
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /usr/local/lib/nexux-bot \\
    && echo ${b64(renderBotCookieScript())} | base64 -d > ${BOT_COOKIE_SCRIPT} \\
    && chmod 644 ${BOT_COOKIE_SCRIPT} \\
    && echo ${b64(renderBotMcpRegisterScript())} | base64 -d > ${BOT_MCP_REGISTER_SCRIPT} \\
    && chmod 644 ${BOT_MCP_REGISTER_SCRIPT} \\
    && echo ${b64(renderBotMcpLoginScript())} | base64 -d > ${BOT_MCP_LOGIN_SCRIPT} \\
    && chmod 755 ${BOT_MCP_LOGIN_SCRIPT}
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

/** `docker …` with optional stdin; shared with bot-vault.ts. */
export function dockerRun(...a: Parameters<typeof docker>): ReturnType<typeof docker> {
  return docker(...a);
}

/**
 * Every docker command a bot causes goes through here, and `target` is its
 * first argument rather than an option so that no call site can forget it —
 * the same discipline `local.ts` keeps, for the same reason: a bot half-living
 * on two daemons would be a container on one and a lookup on the other.
 *
 * `target` null (or `{ host: null }`) is the daemon this machine's docker
 * context points at, which is where every bot ran before endpoints reached
 * them.
 */
function docker(
  target: DockerTarget | null | undefined,
  args: string[],
  opts: {
    onLog?: LogSink;
    timeoutMs?: number;
    stdin?: string;
    env?: Record<string, string>;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...dockerHostArgs(target), ...args], {
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
    // docker can exit before it reads its stdin: a fast failure, a flag it
    // rejects outright, or our own SIGKILL on timeout. The write then lands on
    // a closed pipe, and EPIPE on a stream with no error listener is an
    // uncaught exception rather than this promise settling. The exit code is
    // the real answer there, so let `close` speak and surface only other
    // write failures.
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") reject(err);
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

function tail(text: string, n = 400): string {
  return text.trim().slice(-n);
}

/** Build the bot image unless this exact recipe is already built. */
async function buildWithLoad(
  target: DockerTarget | null | undefined,
  args: string[],
  opts: { stdin?: string; onLog?: LogSink; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const first = await docker(target, args, opts);
  if (first.code === 0 || !rejectedBuildFlag(first.stderr)) return first;
  return docker(target, args.filter((a) => a !== LOAD_FLAG), opts);
}

export async function ensureBotImage(
  opts: { onLog?: LogSink; target?: DockerTarget | null } = {},
): Promise<string> {
  const dockerfile = renderBotDockerfile();
  const tag = botImageTag(dockerfile);
  // Per daemon: the tag existing here says nothing about it existing there.
  const exists = await docker(opts.target, ["image", "inspect", tag], { timeoutMs: 15_000 });
  if (exists.code === 0) return tag;

  opts.onLog?.(`[bot] building image ${tag} (first run takes a few minutes)\n`);
  const built = await buildWithLoad(opts.target, ["build", LOAD_FLAG, "-t", tag, "-"], {
    stdin: dockerfile,
    onLog: opts.onLog,
    timeoutMs: 30 * 60_000,
  });
  if (built.code !== 0) {
    throw new Error(`bot image build failed: ${tail(built.stderr || built.stdout)}`);
  }
  // A build that succeeded is not the same as an image this daemon can run.
  const landed = await docker(opts.target, ["image", "inspect", tag], { timeoutMs: 15_000 });
  if (landed.code !== 0) throw new Error(IMAGE_NOT_IN_STORE);
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
  target?: DockerTarget | null;
}): Promise<{ containerName: string; vncPort: number }> {
  const image = await ensureBotImage({ onLog: opts.onLog, target: opts.target });
  const memoryMb = await sandboxMemoryLimitMb(opts.target);
  const created = await docker(
    opts.target,
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
  const port = await docker(opts.target, ["port", opts.name, `${BOT_NOVNC_PORT}/tcp`], {
    timeoutMs: 15_000,
  });
  const vncPort = parsePublishedPort(port.stdout);
  if (!vncPort) {
    await stopBotContainer(opts.name, opts.target);
    throw new Error("could not read the bot's published noVNC port");
  }
  return { containerName: opts.name, vncPort };
}

/**
 * The port a running computer's noVNC is published on, read from its daemon.
 * On another machine that is a port on *its* loopback, which is what an SSH
 * forward then points at (D-85); after a Nexus restart it is the only way to
 * find it again, since the forward died with the old process.
 */
export async function botScreenPort(
  name: string,
  target?: DockerTarget | null,
): Promise<number | null> {
  const res = await docker(target, ["port", name, `${BOT_NOVNC_PORT}/tcp`], {
    timeoutMs: 15_000,
  }).catch(() => null);
  if (!res || res.code !== 0) return null;
  return parsePublishedPort(res.stdout);
}

export type BotReadiness = "ready" | "starting" | { failed: string };

export async function botReadiness(
  name: string,
  target?: DockerTarget | null,
): Promise<BotReadiness> {
  const res = await docker(
    target,
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
export async function stopBotContainer(
  name: string,
  target?: DockerTarget | null,
): Promise<void> {
  await docker(target, ["rm", "-f", name], { timeoutMs: 60_000 }).catch(() => undefined);
}

/** Every bot container on this engine, running or not. */
export async function listBotContainers(target?: DockerTarget | null): Promise<string[]> {
  const res = await docker(
    target,
    ["ps", "-a", "--filter", `label=${BOT_CONTAINER_LABEL}`, "--format", "{{.Names}}"],
    { timeoutMs: 15_000 },
  ).catch(() => null);
  if (!res || res.code !== 0) return [];
  return res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Size in bytes of a file inside a bot's computer, or null if it is not a regular file. */
export async function botFileSize(
  name: string,
  path: string,
  target?: DockerTarget | null,
): Promise<number | null> {
  const res = await docker(target, ["exec", name, "stat", "-L", "-c", "%F %s", path], { timeoutMs: 15_000 }).catch(() => null);
  if (!res || res.code !== 0) return null;
  const m = res.stdout.trim().match(/^regular(?: empty)? file (\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Copy one file out of a bot's computer onto this machine. */
export async function copyFromBot(
  name: string,
  path: string,
  dest: string,
  target?: DockerTarget | null,
): Promise<boolean> {
  const res = await docker(target, ["cp", "-L", `${name}:${path}`, dest], { timeoutMs: 60_000 }).catch(() => null);
  return Boolean(res && res.code === 0);
}

/**
 * Copy one file from this machine into a bot's computer, owned by the bot
 * (files the user attached in the chat). `docker cp` streams through the
 * daemon, so this works for a computer on another machine's daemon too.
 */
export async function copyToBot(
  name: string,
  src: string,
  path: string,
  target?: DockerTarget | null,
): Promise<boolean> {
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const mk = await docker(target, ["exec", "-u", BOT_USER, name, "mkdir", "-p", dir], { timeoutMs: 15_000 }).catch(() => null);
  if (!mk || mk.code !== 0) return false;
  const cp = await docker(target, ["cp", src, `${name}:${path}`], { timeoutMs: 120_000 }).catch(() => null);
  if (!cp || cp.code !== 0) return false;
  // docker cp keeps the host's uid; the bot must be able to read and replace it.
  await docker(target, ["exec", "-u", "root", name, "chown", `${BOT_USER}:${BOT_USER}`, path], { timeoutMs: 15_000 }).catch(() => null);
  return true;
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
export async function getBotCookies(
  name: string,
  target?: DockerTarget | null,
): Promise<BotCookie[]> {
  const res = await docker(target, ["exec", "-u", BOT_USER, name, "node", BOT_COOKIE_SCRIPT, "get"], { timeoutMs: 20_000 });
  if (res.code !== 0) throw new Error(`could not read cookies: ${tail(res.stderr, 200)}`);
  return JSON.parse(res.stdout) as BotCookie[];
}

/**
 * Write the bot's own MCP servers into its computer (or remove them when it
 * has none). Their env/headers may hold API keys: they travel on stdin and the
 * file is readable by the bot user only.
 */
export async function writeBotMcpConfig(
  name: string,
  servers: Record<string, unknown> | null,
  target?: DockerTarget | null,
): Promise<void> {
  const script = servers
    ? `umask 077 && cat > ${BOT_USER_MCP_CONFIG}`
    : `rm -f ${BOT_USER_MCP_CONFIG}`;
  const res = await docker(target, ["exec", "-i", "-u", BOT_USER, name, "sh", "-c", script], {
    stdin: servers ? JSON.stringify({ mcpServers: servers }) : "",
    timeoutMs: 15_000,
  });
  if (res.code !== 0) throw new Error(`could not write the MCP config: ${tail(res.stderr, 200)}`);
}

/**
 * Register (or, with a null server, drop) one MCP server in Claude's own
 * config inside the computer — the step `claude mcp login|logout|get` needs,
 * since those read Claude's configured servers and not `--mcp-config`.
 */
export async function registerBotMcpServer(
  name: string,
  server: string,
  definition: Record<string, unknown> | null,
  target?: DockerTarget | null,
): Promise<void> {
  const res = await docker(
    target,
    ["exec", "-i", "-u", BOT_USER, name, "node", BOT_MCP_REGISTER_SCRIPT],
    { stdin: JSON.stringify({ name: server, server: definition }), timeoutMs: 20_000 },
  );
  if (res.code !== 0) throw new Error(`could not register "${server}": ${tail(res.stderr, 200)}`);
}

export type BotMcpState = "connected" | "needs-auth" | "failed" | "unknown";

/**
 * Whether one of a bot's remote MCP servers answers, and whether it wants a
 * sign-in first. `claude mcp get` health-checks the server it is asked about
 * and prints one `Status:` line; the server is registered first and left
 * registered (harmless — runs pass --strict-mcp-config).
 *
 * Only for `http`/`sse` servers: a stdio server's check would run its command,
 * which for the usual `npx -y …` means a download of a minute or more.
 */
export async function botMcpState(
  name: string,
  server: string,
  definition: Record<string, unknown>,
  target?: DockerTarget | null,
): Promise<{ state: BotMcpState; detail: string | null }> {
  await registerBotMcpServer(name, server, definition, target);
  const res = await docker(
    target,
    ["exec", "-u", BOT_USER, name, "claude", "mcp", "get", server],
    { timeoutMs: 90_000 },
  );
  return readMcpState(`${res.stdout}\n${res.stderr}`);
}

/** The `Status:` line of `claude mcp get`, as a state. */
export function readMcpState(output: string): { state: BotMcpState; detail: string | null } {
  const line = output.split(/\r?\n/).find((l) => /^\s*Status:/.test(l))?.replace(/^\s*Status:\s*/, "").trim();
  if (!line) return { state: "unknown", detail: null };
  const plain = line.replace(/^[^A-Za-z]+/, "").trim();
  if (/needs authentication/i.test(plain)) return { state: "needs-auth", detail: plain };
  if (/^connected/i.test(plain)) return { state: "connected", detail: plain };
  return { state: "failed", detail: plain || null };
}

/**
 * Open the sign-in for one remote MCP server on the bot's desktop: a terminal
 * window running `claude mcp login <server>`, which opens the consent page in
 * the bot's own Chromium. Returns at once — the user finishes it on the screen.
 */
export async function startBotMcpLogin(
  name: string,
  server: string,
  definition: Record<string, unknown>,
  target?: DockerTarget | null,
): Promise<void> {
  await registerBotMcpServer(name, server, definition, target);
  const logFile = `/tmp/nexux-mcp-login.log`;
  const res = await docker(
    target,
    [
      "exec",
      "-d",
      "-u",
      BOT_USER,
      "-e",
      "DISPLAY=:99",
      name,
      "xfce4-terminal",
      "--title",
      `Sign in to ${server}`,
      "--geometry",
      "100x24",
      "--command",
      `${BOT_MCP_LOGIN_SCRIPT} ${shq(server)} ${logFile}`,
    ],
    { timeoutMs: 20_000 },
  );
  if (res.code !== 0) {
    throw new Error(`could not open the sign-in on the computer: ${tail(res.stderr, 200)}`);
  }
}

/** Set cookies in a computer's browser. Values travel on stdin, never in argv. */
export async function setBotCookies(
  name: string,
  cookies: Record<string, unknown>[],
  target?: DockerTarget | null,
): Promise<void> {
  if (cookies.length === 0) return;
  const res = await docker(target, ["exec", "-i", "-u", BOT_USER, name, "node", BOT_COOKIE_SCRIPT, "set"], {
    stdin: JSON.stringify(cookies),
    timeoutMs: 20_000,
  });
  if (res.code !== 0) throw new Error(`could not set cookies: ${tail(res.stderr, 200)}`);
}

/**
 * Kill any Claude run still going inside a computer. Used when Nexux restarts
 * and adopts a live container: the old process's runs have no supervisor.
 */
export async function stopBotClaudeRuns(
  name: string,
  target?: DockerTarget | null,
): Promise<void> {
  // Only the CLI (`claude …` or node running @anthropic-ai/claude-code), not
  // anything else whose arguments merely mention "claude".
  await docker(target, ["exec", name, "pkill", "-f", "^claude |@anthropic-ai/claude-code"], { timeoutMs: 15_000 }).catch(
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
/** Fence of the block a bot restarts its own computer with (spec 37). */
export const BOT_RESTART_FENCE = "restart";

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
  /** Its MCP servers that could not start (a vault secret missing), described. */
  skippedMcp?: string[];
  /** Vault entries it may use through vault_fill — never the secrets. */
  vault?: { type: string; name: string; websites?: string[]; username?: string | null; hint?: string | null }[];
  /** Gmail addresses it reaches through the connector (spec 34), not the browser. */
  gmail?: string[];
  /** Google accounts whose calendars it reaches through the connector (spec 36). */
  calendar?: string[];
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
    "# Restarting your computer",
    "",
    "You cannot restart your computer with a command — the shell that would do it is inside it. Ask for it instead, by ending your reply with:",
    "",
    "```" + BOT_RESTART_FENCE,
    '{"reason": "to load the new tool the user just added"}',
    "```",
    "",
    `- Nexus deletes this computer and starts a fresh one, then sends you a short message so you can carry on. ${BOT_WORKSPACE}, your browser sign-ins and your MCP sign-ins survive it; anything else on the computer does not, so finish or save your work first (files you want the user to have go in ${BOT_OUTBOX} before the block).`,
    "- Do it when the user asks you to restart, and when something on the computer is wedged (a command that will not die, a desktop that stopped answering) and a fresh machine is the honest fix. Say in your text that you are restarting and why.",
    "- A tool the user just added does NOT need this: MCP servers are loaded fresh on every message. Only a sign-in you were told to pick up, or a broken machine, is a reason.",
    "- One restart per reply, and never twice in a row: if the first one did not help, tell the user instead.",
  );
  parts.push(
    "",
    "# Emails",
    "",
    bot.gmail?.length
      ? "Don't send emails on your own initiative. When you write one for the user to review (a reply, a follow-up, a welcome…), put each email in a block at the end of your reply (for a reply, add the conversation's \"threadId\" so it goes out in the same thread):"
      : "Never send an email on your own. When you write one for the user (a reply, a follow-up, a welcome…), put each email in a block at the end of your reply:",
    "",
    "```" + BOT_MAIL_FENCE,
    '{"from": "me@example.com", "to": "ana@example.com", "cc": "", "subject": "Welcome to Acme", "body": "Hi Ana,\\n\\nThanks for signing up…\\n\\nBest,\\nAlex"}',
    "```",
    "",
    bot.gmail?.length
      ? "- The app shows each block as an email card the user can edit, with Send and Discard. When they press Send, Nexus sends it from their Gmail itself — you don't have to do anything."
      : "- The app shows each block as an email card the user can edit, with Send and Discard. When they press Send, you get a message asking you to send it from Gmail in your browser, exactly as they left it — that is the only time you send.",
    `- One block per email (several are fine). \`body\` is plain text with \\n line breaks, complete with greeting and signature. \`from\` is ${bot.gmail?.length ? "the connected address it goes out from" : "the Google account you are signed in with, if you know it"}. \`cc\`/\`bcc\` are optional, comma-separated.`,
    "- In your text, say briefly what the emails are; don't paste them again outside the blocks.",
  );
  if (bot.gmail?.length) {
    parts.push(
      "",
      "# Gmail",
      "",
      `The user connected Gmail for you: ${bot.gmail.map((e) => `\`${e}\``).join(", ")}. Use the \`gmail\` MCP tools for it — \`gmail_search\` (Gmail's search syntax), \`gmail_read\`, \`gmail_draft\`, \`gmail_send\` — never Gmail in the browser: it is faster, it does not need a sign-in, and the browser's Google session is often signed out.`,
      "- To review an email with the user, use the mail block above (the card). Save straight to Gmail with `gmail_draft` when the user or a routine asks for drafts.",
      "- `gmail_send` sends at once and cannot be undone. Use it only when the user asked for that email to be sent — in this conversation or in a routine's instructions. When in doubt, show the card instead.",
      "- Replies go in the same conversation: pass the `threadId` from `gmail_search`/`gmail_read`, and the subject stays as is (\"Re: …\").",
    );
  }
  if (bot.calendar?.length) {
    parts.push(
      "",
      "# Google Calendar",
      "",
      `The user connected Google Calendar for you: ${bot.calendar.map((e) => `\`${e}\``).join(", ")}. Use the \`calendar\` MCP tools — \`calendar_events\` to read the agenda, \`calendar_freebusy\` to find a free slot, \`calendar_create_event\` / \`calendar_update_event\` / \`calendar_delete_event\` to change it — never Google Calendar in the browser.`,
      `- Times are in the user's timezone (${bot.timezone ?? "the host's"}) unless they say otherwise. Write a time without an offset (2026-11-24T10:00) and it is read in that zone; reading windows (timeMin/timeMax) need the offset.`,
      "- Before creating or moving an event, check the slot with `calendar_freebusy` or `calendar_events`, and say if it clashes with something.",
      "- Create, change or delete events when the user asked for it — in this conversation or in a routine's instructions — and say in your reply exactly what you put on the calendar (title, day, time).",
      "- Guests: adding someone in `attendees` puts the event on their calendar. Set `notify: true` (which emails them the invitation, the change or the cancellation) only when the user asked for invitations to go out. Never add guests the user did not name.",
    );
  }
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
      "- They are loaded fresh on every message, so a server the user adds, changes or removes in Nexus is there (or gone) on your very next message. You do not need to restart your computer for it, and you cannot add one yourself — ask the user to add it in Nexus → the bot's details → Tools.",
      `- A server that answers "not authorized", "unauthorized" or asks for a sign-in needs the user to press **Sign in** next to it in Nexus → Tools. That opens a terminal and a consent page on this very screen; approve it there if they hand you control. The sign-in is kept in ${BOT_CLAUDE_DIR}, which survives this computer, so it is asked for once — do not try to run \`claude mcp login\` yourself.`,
    );
  }
  if (bot.skippedMcp?.length) {
    parts.push(
      "",
      `These MCP servers the user set up for you could not start: ${bot.skippedMcp.join("; ")}. If a task needs one, tell the user to add the missing secret in Nexus → Vault.`,
    );
  }
  if (bot.vault?.length) {
    parts.push(
      "",
      "# Your vault",
      "",
      "The user keeps these in Nexus's vault for you. You never see the secret values: Nexus types them for you with the `vault` MCP tools.",
    );
    for (const v of bot.vault) {
      const where = v.websites?.length ? ` on ${v.websites.join(", ")}` : "";
      const who = v.username ? ` as ${v.username}` : "";
      parts.push(`- ${v.type} "${v.name}"${where}${who}${v.hint?.trim() ? ` — ${v.hint.trim()}` : ""}`);
    }
    parts.push(
      "",
      "- To sign in with a login: open the site's sign-in page, type the username yourself, click the password field, then call `vault_fill` with the entry's name and `field: \"password\"`. Then submit. Never ask the user for a password that is in the vault, and never try to read it back from the page.",
      "- Cards: click each field and call `vault_fill` with `number`, `expiry`, `cvc` or `holder`. Before you pay, buy or subscribe to anything, confirm the merchant and the amount with the user (a choices question) unless they explicitly asked for that exact purchase.",
      "- Contact details: click the field and `vault_fill` with `email`, `phone` or `address`.",
      "- If `vault_fill` refuses (wrong field, wrong site), fix that — don't work around it. If you need something that isn't in the vault, ask the user to add it in Nexus → Vault, or to type it on your screen.",
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
  // A bot's own stdio MCP servers usually start with `npx -y <pkg>`, and its
  // computer is fresh after every sleep: the first download can take a minute
  // or more (mongodb-mcp-server: ~72s), past Claude Code's 30s startup wait.
  const mcpWait = opts.userMcp ? `MCP_TIMEOUT=${BOT_MCP_STARTUP_MS} ` : "";
  return (
    `${mcpWait}claude ${resume}${model}-p ${shq(prompt)}` +
    ` --append-system-prompt ${shq(opts.systemPrompt)}` +
    // --strict-mcp-config: these files are the whole list. The computer's own
    // Claude config holds throwaway registrations (spec 37: `claude mcp login`
    // only acts on servers Claude has configured), and a run must not load a
    // server because a sign-in left it there.
    ` --mcp-config ${BOT_MCP_CONFIG}${opts.userMcp ? ` ${BOT_USER_MCP_CONFIG}` : ""} --strict-mcp-config` +
    ` --permission-mode bypassPermissions --output-format stream-json --verbose`
  );
}

/**
 * The bot's working directory, made if it is not there yet.
 *
 * `execRemote` prefixes the command with `cd`, so a missing directory fails
 * the run before Claude ever sees the prompt. On this machine the bot's folder
 * under the shared workspace is created host-side before the mount; in a named
 * volume on another daemon there is no host side to create it on, and a rename
 * moves the directory out from under a live session either way. Making it here
 * covers all of it, and `mkdir -p` on a directory that exists costs nothing.
 */
async function ensureBotCwd(
  container: string,
  cwd: string,
  target?: DockerTarget | null,
): Promise<void> {
  const res = await docker(target, ["exec", "-u", BOT_USER, container, "mkdir", "-p", cwd], {
    timeoutMs: 15_000,
  });
  if (res.code !== 0) {
    throw new Error(`could not create the working directory ${cwd}: ${tail(res.stderr, 200)}`);
  }
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
    target?: DockerTarget | null;
  },
): Promise<ClaudeRunResult> {
  const parser = createStreamParser(opts.onLog);
  const cwd = opts.cwd ?? BOT_WORKDIR;
  await ensureBotCwd(opts.container, cwd, opts.target);
  const res = await execRemote(buildBotClaudeCommand(prompt, opts), {
    container: opts.container,
    user: BOT_USER,
    dockerHost: opts.target?.host ?? null,
    cwd,
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
