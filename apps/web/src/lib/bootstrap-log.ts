import {
  parseTailscaleAuthUrl,
  BOOTSTRAP_COMPLETE_MARKER,
  BOOTSTRAP_FAILED_MARKER,
} from "@nexux/sandbox";

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
 * Separates the highlights from the marker state.
 *
 * Completion used to be derived by matching /bootstrap finished/ against the
 * tail — but the failing branch prints "bootstrap FAILED", which that regex
 * does not match, so a bootstrap that had already failed read as still
 * running and the log viewer polled forever while the health strip (which
 * reads the markers) already knew. The log is also untrusted text: a repo's
 * own build output can print "bootstrap finished" and used to be believed.
 */
const STATE_SENTINEL = "===nexus-bootstrap-state===";

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
 * @param markers likewise — the marker paths are fixed on a real sandbox, but
 *   a test has to be able to point them at a temp dir to cover both states.
 */
export function bootstrapLogCommand(
  path: string = LOG_PATH,
  markers: { complete?: string; failed?: string } = {},
): string {
  const completeMarker = markers.complete ?? BOOTSTRAP_COMPLETE_MARKER;
  const failedMarker = markers.failed ?? BOOTSTRAP_FAILED_MARKER;
  return `tail -n ${TAIL_LINES} ${path} 2>/dev/null || echo "(bootstrap log not created yet)"
echo '${SENTINEL}'
grep -aE '^\\[nexux\\] (WARN|ACTION REQUIRED|tailscale-auth-url)' ${path} 2>/dev/null | tail -n ${HIGHLIGHT_LINES} || true
echo '${STATE_SENTINEL}'
# \`|| true\` on both: a missing marker is the normal case while a bootstrap is
# still running, and \`test -f\` failing would otherwise be the exit status of
# this whole command — which execRemote reports as a failed read, hiding the
# log the caller asked for behind an error about a file that is absent on
# purpose.
{ test -f ${completeMarker} && echo complete; } || true
{ test -f ${failedMarker} && echo failed; } || true`;
}

export type BootstrapLogView = {
  log: string;
  /** The run reached its end with no fatal step — from the marker file. */
  complete: boolean;
  /** A fatal step recorded a reason. Complete and failed are exclusive. */
  failed: boolean;
  warnings: string[];
  tailscaleAuthUrl: string | null;
};

export function parseBootstrapLog(stdout: string): BootstrapLogView {
  // lastIndexOf, not indexOf: the log is untrusted text — a repo's own build
  // output can print anything, this sentinel included — and the split has to
  // land on the one the command itself appended.
  const cut = stdout.lastIndexOf(SENTINEL);
  const tail = cut === -1 ? stdout : stdout.slice(0, cut);
  const afterTail = cut === -1 ? "" : stdout.slice(cut + SENTINEL.length);

  // The state block is appended last, so it is what follows the final state
  // sentinel. Same lastIndexOf discipline as above, and for the same reason:
  // a repo's build output can print anything, this sentinel included.
  const stateCut = afterTail.lastIndexOf(STATE_SENTINEL);
  const highlights = stateCut === -1 ? afterTail : afterTail.slice(0, stateCut);
  const state =
    stateCut === -1 ? "" : afterTail.slice(stateCut + STATE_SENTINEL.length);
  const stateLines = state.split("\n").map((l) => l.trim());
  const failed = stateLines.includes("failed");
  // No state block at all: an ssh that died mid-stream, or a sandbox whose
  // command predates the markers being queried. Fall back to the old regex —
  // it is wrong about a FAILED run, but it is all such output carries, and an
  // empty panel that polls forever is worse.
  const legacy = stateCut === -1 && /bootstrap finished/.test(tail);

  return {
    log: tail.trimEnd() || "(empty)",
    // A failed run leaves the failure marker and no completion marker, so it
    // reads as finished — which is what stops the viewer polling. "Finished"
    // and "succeeded" are not the same question; `failed` answers the second.
    complete: stateLines.includes("complete") || failed || legacy,
    failed,
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
