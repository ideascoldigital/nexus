import { parseTailscaleAuthUrl } from "@nexux/sandbox";

/**
 * Reading a sandbox's bootstrap log: the shell that fetches it, and the parser
 * for what comes back.
 *
 * Split out of the route so both halves are testable without a machine. The
 * shell half earns that on its own — it is a multi-line command that travels
 * through `bash -lc` and a layer of quoting, and an unquoted token in it was
 * enough to make bash abort after the first line, return a plausible-looking
 * tail, and silently drop everything below.
 */

const LOG_PATH = "/var/log/nexus-bootstrap.log";

/** How much of the live tail the UI shows. */
export const TAIL_LINES = 400;

/** Cap on the highlight scan, so a pathological log can't return the world. */
export const HIGHLIGHT_LINES = 60;

/**
 * Separates the tail from the highlights in one command's output.
 *
 * Alphanumerics, dashes and equals only, and quoted at the call site: an
 * unquoted `<<<…>>>` reads to bash as a here-string followed by redirects,
 * which is a syntax error — and bash executes what it has already parsed
 * before hitting it, so the tail still comes back and the rest never runs.
 */
const SENTINEL = "===nexus-bootstrap-highlights===";

/**
 * Tail the log, then scan the *whole* file for the lines worth surfacing.
 *
 * A bootstrap runs to ~1500 lines, so anything that went wrong early — a failed
 * install, a registration URL — is hundreds of lines above the window the UI
 * shows by the time it finishes. That is not cosmetic: a sandbox came up with
 * tailscale silently missing (apt lost a race with unattended-upgrades) and the
 * one line saying so was unreachable from the app, so every downstream symptom
 * — no registration URL, clones timing out — pointed somewhere else.
 *
 * @param path overridable for tests; the instances only ever have the one.
 */
export function bootstrapLogCommand(path: string = LOG_PATH): string {
  return `tail -n ${TAIL_LINES} ${path} 2>/dev/null || echo "(bootstrap log not created yet)"
echo '${SENTINEL}'
grep -aE '^\\[nexux\\] (WARN|ACTION REQUIRED|tailscale-auth-url)' ${path} 2>/dev/null | tail -n ${HIGHLIGHT_LINES} || true`;
}

export type BootstrapLogView = {
  log: string;
  complete: boolean;
  warnings: string[];
  tailscaleAuthUrl: string | null;
};

export function parseBootstrapLog(stdout: string): BootstrapLogView {
  // lastIndexOf, not indexOf: the log is untrusted text — a repo's own build
  // output can print anything, this sentinel included — and the split has to
  // land on the one the command itself appended.
  const cut = stdout.lastIndexOf(SENTINEL);
  const tail = cut === -1 ? stdout : stdout.slice(0, cut);
  const highlights = cut === -1 ? "" : stdout.slice(cut + SENTINEL.length);

  return {
    log: tail.trimEnd() || "(empty)",
    complete: /bootstrap finished/.test(tail),
    // Every WARN the run produced, wherever in the file it landed. The tail
    // answers "what is it doing now?"; these answer "what did it fail to do?",
    // which on a finished bootstrap is the only question left.
    warnings: highlights
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("[nexux] WARN:")),
    // A keyless tailnet join waits on a human opening this. Lifted out of the
    // log because a link nobody notices is the same as no link — the sandbox
    // sits unregistered until it is clicked. Read from the highlights as well
    // as the tail, so a link that scrolled out of the 400-line window is still
    // reachable; the tail wins, being the more recent re-announcement.
    tailscaleAuthUrl:
      parseTailscaleAuthUrl(tail) ?? parseTailscaleAuthUrl(highlights),
  };
}
