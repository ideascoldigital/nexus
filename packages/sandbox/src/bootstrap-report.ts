// Spec 24, piece 1 — structured per-step bootstrap results.
//
// The bootstrap has always logged what it did; it has never *recorded* it. A
// failed install degrades to `echo "[nexux] WARN: …"` and the only way back to
// "which step failed" is a regex over prose — which is how a failed
// `docker compose up` for postgres became invisible to both the retry path and
// the UI's failure count, while the sandbox still reported green.
//
// This module is the recording half: the bash that writes one line per step,
// and the parser that reads it back on the host. It carries no policy about
// which steps matter — see `severity` below.

import { shq } from "./slug";
import { SANDBOX_ROOT } from "./workspace";

/**
 * One JSON object per line, appended as each step finishes.
 *
 * JSONL rather than a document the bootstrap rewrites: the run can be killed
 * at any point — a provider timeout, a reboot, the OOM killer — and a
 * half-written array is unparseable while a half-written JSONL file is merely
 * shorter. Whatever ran is readable, which is the whole point on the runs that
 * did not finish.
 */
export const BOOTSTRAP_REPORT_PATH = `${SANDBOX_ROOT}/bootstrap-report.jsonl`;

/**
 * How much a failed step matters — the caller's decision, not the exit code's.
 *
 * A failed clone of the main checkout and a failed tailscale install both exit
 * non-zero, and the bootstrap has always treated them differently (one calls
 * `nexus_bootstrap_fatal`, the other logs and continues). That policy was
 * encoded in *which function the call site invoked*; making it a parameter is
 * what lets a reader tell "this failed and it matters" from "this failed and
 * the box is still useful" without re-deriving the distinction.
 */
export type StepSeverity = "fatal" | "warn";

export type BootstrapStep = {
  /** `<phase>:<subject>` — `apt:base`, `clone:api`, `install:api`. */
  step: string;
  severity: StepSeverity;
  exitCode: number;
  durationMs: number;
  /** ISO-8601, from the sandbox's clock. */
  at: string;
  /**
   * Last lines of the step's own output, when it failed and the caller asked
   * for them. Only steps whose failure is unactionable without context carry
   * this — a boot probe that never answered on its port, principally.
   */
  tail?: string;
};

export type BootstrapReport = {
  steps: BootstrapStep[];
  /** Lines that were not valid JSON, kept so a parse bug is visible. */
  malformed: string[];
};

/** A step name we are willing to put in a JSON string unescaped. */
const STEP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,80}$/;

/**
 * Rejects a step name the recorder would have to escape.
 *
 * The recorder builds its JSON with printf in bash, so a name containing a
 * quote or a backslash would produce a line the parser drops — silently, which
 * is the failure mode this whole module exists to remove. Names are authored
 * here in TypeScript, never taken from user input, so refusing outright is
 * safe and catches the typo at render time rather than on the box.
 */
export function assertStepName(name: string): string {
  if (!STEP_NAME.test(name)) {
    throw new Error(
      `Invalid bootstrap step name ${JSON.stringify(name)} — expected <phase>:<subject>, [a-zA-Z0-9._:-]`,
    );
  }
  return name;
}

/**
 * The bash helpers, emitted once into the bootstrap preamble.
 *
 * `nexus_step` runs a command and records the outcome; `nexus_step_status`
 * records one the caller ran itself (the many existing `cmd || echo WARN`
 * chains, where rewriting the call site into `nexus_step cmd …` would have to
 * survive another round of quoting for no gain).
 *
 * Neither ever returns non-zero. The bootstrap runs without `set -e` on
 * purpose (D-33) but is still a long `&&`-free script where an unexpected
 * failing return from a helper could short-circuit a `&&` chain at the call
 * site; the helpers are observers and must not change control flow.
 */
export function renderStepHelpers(): string {
  return `# --- spec 24: structured step results -----------------------------------
# One JSON line per step, appended. See packages/sandbox/src/bootstrap-report.ts.
# GNU date's -Is; BSD date (macOS, where these helpers are unit-tested) has no
# -I at all and would leave the field empty, which reads as "the recorder is
# broken" rather than "this host formats dates differently".
nexus_now() { date -Is 2>/dev/null || date -u '+%Y-%m-%dT%H:%M:%S+00:00'; }

# Milliseconds since the epoch. GNU coreutils understands %3N; BSD date does
# not expand it at all and returns "1790014022" with a literal "3N" glued on —
# a string that is not a number, which every arithmetic use of it would then
# fail on. Falling back to whole seconds keeps durations honest (coarse, not
# wrong) wherever %N is unsupported.
nexus_millis() {
  local t
  t=$(date +%s%3N 2>/dev/null || echo "")
  case "$t" in
    ''|*[!0-9]*) echo "$(( $(date +%s) * 1000 ))" ;;
    *) echo "$t" ;;
  esac
}

nexus_step_status() {
  # $1 step name, $2 severity (fatal|warn), $3 exit code, $4 duration ms
  mkdir -p ${SANDBOX_ROOT} 2>/dev/null || true
  printf '{"step":"%s","severity":"%s","exitCode":%s,"durationMs":%s,"at":"%s"}\\n' \\
    "$1" "$2" "\${3:-0}" "\${4:-0}" "$(nexus_now)" >> ${BOOTSTRAP_REPORT_PATH} 2>/dev/null || true
  if [ "\${3:-0}" -ne 0 ] && [ "$2" = "fatal" ]; then
    nexus_bootstrap_fatal "$1"
  fi
  return 0
}

# Run a command as one recorded step. Never propagates the failure: the
# bootstrap decides what is fatal through the severity argument, not through
# control flow.
nexus_step() {
  local name="$1" severity="$2"; shift 2
  local started rc=0 ended
  started=$(nexus_millis)
  "$@" || rc=$?
  ended=$(nexus_millis)
  nexus_step_status "$name" "$severity" "$rc" "$((ended - started))"
  return 0
}

# The wrapper for chains that were already written as \`cmd || echo WARN\`.
# Command and failure branch arrive as strings and are re-evaluated here, so
# the call site keeps its existing quoting instead of surviving another round
# of it. \`local\` on the timing variables is what makes nested steps safe.
nexus_step_run() {
  local name="$1" severity="$2" body="$3" on_fail="$4"
  local started rc=0 ended
  started=$(nexus_millis)
  eval "$body" || rc=$?
  ended=$(nexus_millis)
  if [ "$rc" -ne 0 ] && [ -n "$on_fail" ]; then
    eval "$on_fail"
  fi
  nexus_step_status "$name" "$severity" "$rc" "$((ended - started))"
  return 0
}
# ------------------------------------------------------------------------`;
}

/**
 * Wraps an existing `cmd || echo "[nexux] WARN: …"` chain so it also records.
 *
 * The echo stays: the log is still the live surface the UI tails, and a WARN
 * that vanished from it would be a regression for anyone reading along. This
 * adds the record beside it rather than replacing one signal with another.
 *
 * Emitted as a subshell function call rather than inline `if`/`fi` with a
 * shared variable: the call sites nest (a repo section runs inside the repo
 * setup block, which the retry action also runs standalone), and a bare
 * `nexus_step_start=` would be a global that an inner step overwrites before
 * the outer one reads it — producing a plausible, wrong duration rather than
 * an error. `local` inside `nexus_step_run` is what makes nesting safe.
 */
export function stepChain(
  name: string,
  severity: StepSeverity,
  command: string,
  onFailure: string,
): string {
  assertStepName(name);
  // The command and the failure branch are passed as strings to be re-evaluated
  // by `eval` inside the helper. Both are generated here, never user input —
  // the repo names they interpolate have already been through `safeSlug`/`shq`
  // at the call site, which is the same trust boundary the surrounding
  // bootstrap already relies on.
  return `nexus_step_run ${shq(name)} ${shq(severity)} ${shq(command)} ${shq(onFailure)}`;
}

/** The shell that reads the report back, for `execRemote`. */
export function bootstrapReportCommand(
  path: string = BOOTSTRAP_REPORT_PATH,
): string {
  return `cat ${path} 2>/dev/null || true`;
}

/**
 * Parses the JSONL back.
 *
 * Lenient by construction: the file is appended to by a bash script on a box
 * that may have been killed mid-write, so a truncated final line is expected
 * rather than exceptional. Unparseable lines are kept in `malformed` — dropping
 * them silently would hide exactly the recorder bug this file is meant to make
 * visible.
 */
export function parseBootstrapReport(raw: string): BootstrapReport {
  const steps: BootstrapStep[] = [];
  const malformed: string[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed.push(trimmed);
      continue;
    }
    const o = parsed as Partial<BootstrapStep>;
    if (typeof o.step !== "string" || typeof o.exitCode !== "number") {
      malformed.push(trimmed);
      continue;
    }
    steps.push({
      step: o.step,
      severity: o.severity === "fatal" ? "fatal" : "warn",
      exitCode: o.exitCode,
      durationMs: typeof o.durationMs === "number" ? o.durationMs : 0,
      at: typeof o.at === "string" ? o.at : "",
      ...(typeof o.tail === "string" && o.tail ? { tail: o.tail } : {}),
    });
  }

  return { steps, malformed };
}

/**
 * The steps that failed, newest run wins.
 *
 * A step name can repeat: the retry action re-runs `renderRepoSetup`, so a
 * clone that failed and then succeeded appears twice. The later record is the
 * current truth — reporting a repaired step as still broken is what made the
 * old WARN-scraping retry misleading.
 */
export function failedSteps(report: BootstrapReport): BootstrapStep[] {
  const latest = new Map<string, BootstrapStep>();
  for (const step of report.steps) latest.set(step.step, step);
  return [...latest.values()].filter((s) => s.exitCode !== 0);
}
