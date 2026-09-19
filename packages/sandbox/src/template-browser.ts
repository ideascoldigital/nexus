// Spec 23 — the interactive browser session.
//
// A sandbox running a front end and a back end cannot be tested through a
// tunnel: each process gets its own random public hostname, so the front's
// API_URL is wrong from the viewer's browser whatever it says. Inside the
// sandbox both are plain localhost ports and already agree, so the browser
// moves to the app rather than the app to the browser.
//
// Nothing here binds to a public interface. The dashboard reaches the session
// over an SSH port-forward from the host, which already holds the sandbox
// keypair — an open VNC or CDP port on a public address would hand anyone who
// finds it a browser with unrestricted access to the checkouts, the .env files
// and the git credentials on that instance.

import { shq } from "./slug";

/** Where the session's pid/log files live. Mirrors the process manager's /tmp layout. */
export const BROWSER_DIR = "/tmp/nexus-browser";
export const BROWSER_LOG = `${BROWSER_DIR}/session.log`;
export const BROWSER_READY_MARKER = `${BROWSER_DIR}/ready`;

/** Defaults — overridable per session, but these are what the UI offers. */
export const DEFAULT_DISPLAY = ":99";
export const DEFAULT_VNC_PORT = 5900;
export const DEFAULT_WS_PORT = 6080;
export const DEFAULT_CDP_PORT = 9222;
export const DEFAULT_WIDTH = 1440;
export const DEFAULT_HEIGHT = 900;

/** A VNC password is truncated to 8 bytes by the protocol; generate exactly that. */
export const VNC_TOKEN_LENGTH = 8;

export type BrowserSessionSpec = {
  /** X display to run on, e.g. ":99". */
  display?: string;
  /** VNC server port — loopback only. */
  vncPort?: number;
  /** websockify port the SSH forward lands on — loopback only. */
  wsPort?: number;
  /**
   * Bind the WebSocket bridge to every interface instead of loopback.
   *
   * Only for a container, and only because docker's port publishing cannot
   * reach a loopback-only listener: the forwarded packet arrives on the
   * container's own interface, so a bridge bound to 127.0.0.1 answers nobody.
   * What keeps it private there is the published binding itself
   * (`-p 127.0.0.1::6080`), which never leaves the host's loopback.
   *
   * On a cloud instance this must stay false: the boundary there is the bind
   * address, and "every interface" means the public one.
   */
  wsAllInterfaces?: boolean;
  /** Chrome DevTools Protocol port — loopback only. */
  cdpPort?: number;
  width?: number;
  height?: number;
  /**
   * VNC password. Written to a 0600 file and handed to x11vnc as
   * `-passwdfile`, never passed on a command line: /proc/<pid>/cmdline is
   * world-readable, so `-passwd <secret>` would publish it to every user on
   * the instance.
   */
  token: string;
};

/** X display names are ":<digits>" and reach a shell — nothing else is valid. */
export function isValidDisplay(value: string): boolean {
  return /^:\d{1,3}$/.test(value);
}

/** A port that can actually be bound, and is not a privileged one. */
export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

/** Screen dimensions reach the Xvfb geometry string; keep them sane integers. */
export function isValidDimension(value: number): boolean {
  return Number.isInteger(value) && value >= 320 && value <= 7680;
}

/**
 * The bootstrap section that installs what a session needs.
 *
 * Chromium is NOT installed here: `installAgentBrowser` already puts
 * Playwright's build on the box and links it at /usr/local/bin/google-chrome
 * for the agents' screenshots. Installing a second browser would mean two
 * builds to keep current and two paths to get wrong.
 */
export function renderBrowserInstallSection(agentUser: string): string {
  // The bootstrap runs as root; the session script runs as the agent user, and
  // everything it writes — the log, the VNC password, the pid files — lands
  // here. A root-owned 0700 directory makes every one of those fail with
  // EACCES, which surfaces as "the virtual display did not start" with an
  // empty log: the script cannot even record why. Same `mkdir` + `chown` the
  // checkout dirs get, and for the same reason.
  return `echo "[nexux] installing the browser session (xvfb, x11vnc, websockify)"
nexus_apt install -y xvfb x11vnc websockify || echo "[nexux] WARN: browser session install failed"
mkdir -p ${BROWSER_DIR}
chown ${shq(agentUser)}:${shq(agentUser)} ${BROWSER_DIR}
chmod 700 ${BROWSER_DIR}`;
}

/**
 * The script that starts one session, run over exec when the user opens the
 * Browser tab — not at bootstrap. A browser idling on every sandbox would cost
 * memory on instances nobody is looking at.
 *
 * Every listener is pinned to 127.0.0.1. The chromium flags matter as much as
 * the ports: --remote-debugging-address=127.0.0.1 is what keeps CDP off the
 * public interface, and an open CDP port is remote code execution with extra
 * steps — it can read any origin the browser can reach, including file://.
 */
export function renderBrowserStartScript(spec: BrowserSessionSpec): string {
  const display = spec.display ?? DEFAULT_DISPLAY;
  const vncPort = spec.vncPort ?? DEFAULT_VNC_PORT;
  const wsPort = spec.wsPort ?? DEFAULT_WS_PORT;
  // VNC and CDP are never widened: the VNC server is reached through this
  // bridge, and an open CDP port is remote code execution with extra steps.
  const wsBind = spec.wsAllInterfaces ? "0.0.0.0" : "127.0.0.1";
  const cdpPort = spec.cdpPort ?? DEFAULT_CDP_PORT;
  const width = spec.width ?? DEFAULT_WIDTH;
  const height = spec.height ?? DEFAULT_HEIGHT;

  if (!isValidDisplay(display)) {
    throw new Error(`Invalid X display: ${display}`);
  }
  for (const [name, port] of [
    ["vncPort", vncPort],
    ["wsPort", wsPort],
    ["cdpPort", cdpPort],
  ] as const) {
    if (!isValidPort(port)) throw new Error(`Invalid ${name}: ${port}`);
  }
  if (new Set([vncPort, wsPort, cdpPort]).size !== 3) {
    throw new Error("The VNC, WebSocket and CDP ports must differ");
  }
  for (const [name, value] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (!isValidDimension(value)) throw new Error(`Invalid ${name}: ${value}`);
  }
  if (!spec.token) throw new Error("A browser session needs a VNC password");

  const passwdFile = `${BROWSER_DIR}/vncpasswd`;

  // The token reaches the shell exactly once, quoted, written straight to the
  // passwd file. `set +x` around it keeps it out of the bootstrap's xtrace,
  // which is on for the rest of the run.
  return `set -u
mkdir -p ${BROWSER_DIR}
chmod 700 ${BROWSER_DIR}

# Replace any previous session: one browser per sandbox, restart means replace.
for f in ${BROWSER_DIR}/xvfb.pid ${BROWSER_DIR}/chromium.pid ${BROWSER_DIR}/x11vnc.pid ${BROWSER_DIR}/websockify.pid; do
  if [ -f "$f" ]; then kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; fi
done
rm -f ${BROWSER_READY_MARKER}
sleep 1

: > ${BROWSER_LOG}
chmod 600 ${BROWSER_LOG}

# The password never appears in a command line (/proc/<pid>/cmdline is
# world-readable) and never in the trace.
#
# -passwdfile reads the plaintext from the file's first line, which is exactly
# what it exists for. The form this replaced looked
# like "read the password from stdin" and is not: x11vnc takes the literal "-"
# as the password, obfuscates that, and never reads stdin — so every session
# authenticated against a dash while the panel was handed a token that could
# never work.
set +x
umask 077
echo ${shq(spec.token)} > ${passwdFile}
set -x
chmod 600 ${passwdFile}

setsid Xvfb ${display} -screen 0 ${width}x${height}x24 -nolisten tcp \\
  >> ${BROWSER_LOG} 2>&1 < /dev/null &
echo $! > ${BROWSER_DIR}/xvfb.pid

for i in $(seq 1 30); do
  DISPLAY=${display} xdpyinfo >/dev/null 2>&1 && break
  sleep 1
done
if ! DISPLAY=${display} xdpyinfo >/dev/null 2>&1; then
  echo "XVFB_FAILED"
  tail -n 25 ${BROWSER_LOG}
  exit 0
fi

# google-chrome is the symlink installAgentBrowser leaves pointing at
# Playwright's Chromium. --no-sandbox because the instance is already an
# isolated VM and the seccomp sandbox needs privileges cloud-init does not
# grant; --disable-dev-shm-usage because the default /dev/shm on these sizes
# is too small and Chromium dies mid-render without it.
DISPLAY=${display} setsid google-chrome \\
  --no-first-run --no-default-browser-check \\
  --no-sandbox --disable-dev-shm-usage \\
  --remote-debugging-port=${cdpPort} \\
  --remote-debugging-address=127.0.0.1 \\
  --window-position=0,0 --window-size=${width},${height} \\
  --user-data-dir=${BROWSER_DIR}/profile \\
  about:blank >> ${BROWSER_LOG} 2>&1 < /dev/null &
echo $! > ${BROWSER_DIR}/chromium.pid

# -localhost: the dashboard arrives over an SSH forward, so the VNC server
# must never answer on the public interface.
setsid x11vnc -display ${display} -rfbport ${vncPort} -localhost \\
  -passwdfile ${passwdFile} -forever -shared -noxdamage \\
  >> ${BROWSER_LOG} 2>&1 < /dev/null &
echo $! > ${BROWSER_DIR}/x11vnc.pid

setsid websockify ${wsBind}:${wsPort} 127.0.0.1:${vncPort} \\
  >> ${BROWSER_LOG} 2>&1 < /dev/null &
echo $! > ${BROWSER_DIR}/websockify.pid

# Report ready only once the port the forward lands on actually answers.
#
# Any HTTP status counts, which is the whole point: websockify answers a plain
# GET with 405, so curl -f (which fails on 4xx) reports exit 22 against a
# perfectly healthy bridge and the session is declared dead every time. What
# is being tested here is that something is listening and speaking HTTP, not
# that it likes this particular request — the upgrade handshake is noVNC's job.
ws_answers() {
  curl -s -o /dev/null -m 3 "http://127.0.0.1:${wsPort}" 2>/dev/null
}
for i in $(seq 1 30); do
  ws_answers && break
  sleep 1
done
if ws_answers; then
  touch ${BROWSER_READY_MARKER}
  echo "READY:${wsPort}:${cdpPort}"
else
  echo "WS_FAILED"
  tail -n 25 ${BROWSER_LOG}
fi`;
}

/** Tear the session down. By recorded PID, never by pattern — a `pkill -f`
 *  would match the shell running this script, which names what it launches. */
export function renderBrowserStopScript(): string {
  return `set -u
for f in websockify x11vnc chromium xvfb; do
  p=${BROWSER_DIR}/$f.pid
  if [ -f "$p" ]; then kill "$(cat "$p")" 2>/dev/null || true; rm -f "$p"; fi
done
rm -f ${BROWSER_READY_MARKER}
echo "STOPPED"`;
}

/** Whether the start script reported the session up, and on which ports. */
export function parseBrowserStart(
  stdout: string,
): { wsPort: number; cdpPort: number } | null {
  const match = stdout.match(/READY:(\d+):(\d+)/);
  if (!match) return null;
  return { wsPort: Number(match[1]), cdpPort: Number(match[2]) };
}
