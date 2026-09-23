// Spec 24, piece 2 — proving an app boots, during the bootstrap.
//
// A sandbox has always been declared ready without ever starting the app it
// exists to run. `runCommand` reaches /opt/nexus/nexus.json and the process
// plans, but no bootstrap section invokes it — so "provisioned successfully"
// has meant "the tooling installed", and whether the project compiles, binds
// and serves was discovered by a human clicking Start, minutes later.
//
// This renders the probe that answers it: start the app, wait for its port,
// then stop it. It is a *test*, not a deploy — leaving the app running would
// make every provision also a launch, and would race with the user's own Start
// (which kills by recorded PID and would not know about this one).

import { assertStepName, BOOTSTRAP_REPORT_PATH } from "./bootstrap-report";
import { shq } from "./slug";
import { SANDBOX_ROOT } from "./workspace";

export type BootProbeSpec = {
  /** Repo/unit name, used for the step name and the log line. */
  name: string;
  /** Directory to run in, absolute on the sandbox. */
  cwd: string;
  /** The app's start command, as the stack's run phase defines it. */
  command: string;
  /** The port it must answer on. */
  port: number;
};

/**
 * How long to wait for the port, in seconds.
 *
 * Matches the manual path's budget (`sandbox-process-manager` polls 90 times
 * at 2s). A cold first run compiles as it starts — a Next.js dev server on a
 * small instance genuinely takes over a minute — and a probe that gave up
 * sooner would report a working app as broken, which is worse than not probing
 * at all.
 */
export const BOOT_PROBE_TIMEOUT_SECONDS = 180;

/** Where a probe leaves the app's output, for the failure tail. */
export function bootProbeLogPath(name: string): string {
  return `/tmp/nexus-boot-${name}.log`;
}

/**
 * The probe for one app.
 *
 * Structured as: launch detached → poll the port → kill the process *group* →
 * record. Each of those has a reason:
 *
 * - **Detached, with `setsid`.** The command is a dev server that never exits;
 *   running it in the foreground would hang the bootstrap for good. `setsid`
 *   gives it its own process group, which is the only way to reliably kill a
 *   `pnpm dev` — the package manager spawns the real server as a child, so
 *   killing the recorded PID alone leaves the port held by an orphan, and the
 *   user's later Start then fails with EADDRINUSE on a box that had "passed".
 * - **Polls with curl, accepting any HTTP response.** `curl -f` fails on 4xx,
 *   and an app whose `/` legitimately answers 401 or 404 is nonetheless up.
 *   The question here is "does something serve HTTP on this port", not "is
 *   the root route happy" — the second is the app's business, not the
 *   provisioner's.
 * - **Kills unconditionally at the end**, including on success. The probe
 *   proves the app boots; it does not hand over a running app.
 */
export function renderBootProbe(spec: BootProbeSpec): string {
  const step = assertStepName(`boot:${spec.name}`);
  const log = bootProbeLogPath(spec.name);
  const pidFile = `/tmp/nexus-boot-${spec.name}.pid`;

  return `echo "[nexux] probing boot: ${spec.name} (port ${spec.port})"
nexus_boot_probe ${shq(step)} ${shq(spec.name)} ${shq(spec.cwd)} ${shq(spec.command)} ${shq(String(spec.port))} ${shq(log)} ${shq(pidFile)}`;
}

/**
 * The shared probe function, emitted once alongside the step helpers.
 *
 * A function rather than inline script per repo: the body is long, the quoting
 * is delicate, and N repos would mean N copies of it in a user_data blob that
 * EC2 caps at 16KB.
 */
export function renderBootProbeHelper(agentUser: string): string {
  return `# --- spec 24 piece 2: does the app actually boot? ----------------------
# Starts the app, waits for its port, then stops it. A test, not a launch.
nexus_boot_probe() {
  local step="$1" name="$2" cwd="$3" command="$4" port="$5" log="$6" pidfile="$7"
  local started ended rc=1 i=0

  if [ ! -d "$cwd" ]; then
    echo "[nexux] WARN: boot probe skipped — $cwd not found"
    return 0
  fi

  started=$(nexus_millis)
  : > "$log"
  # setsid: its own process group, so the kill below reaches the real server
  # and not just the package manager that spawned it.
  local quoted_cwd
  quoted_cwd=$(printf %q "$cwd")
  # \`set -m\` puts the background job in its own process group, whose id is the
  # launched PID — so \`kill -TERM -$pid\` below reaches the whole tree.
  #
  # Bash's own job control rather than \`setsid\`: setsid is util-linux and is
  # absent on macOS, where these helpers are unit-tested, and a kill that is
  # only correct on the platform the tests cannot exercise is a kill nothing
  # verifies. The failure it guards against is specific — \`pnpm dev\` spawns
  # the real server as a child, so killing the recorded PID alone leaves the
  # port held by an orphan and the user's own Start then fails with
  # EADDRINUSE on a sandbox that had just passed its probe.
  set -m
  runuser -u ${agentUser} -- bash -lc "cd $quoted_cwd && $command" \\
    > "$log" 2>&1 < /dev/null &
  echo $! > "$pidfile"
  set +m

  # Any HTTP answer counts: an app whose / returns 401 or 404 is still up.
  while [ "$i" -lt ${BOOT_PROBE_TIMEOUT_SECONDS} ]; do
    if curl -s -o /dev/null --max-time 2 "http://localhost:$port" 2>/dev/null; then
      rc=0
      break
    fi
    # A process that has already died will never answer; stop waiting for it.
    if ! kill -0 "$(cat "$pidfile" 2>/dev/null)" 2>/dev/null; then
      echo "[nexux] WARN: $name exited before answering on port $port"
      break
    fi
    sleep 2
    i=$((i + 2))
  done
  ended=$(nexus_millis)

  # Kill the group, always — including on success. Leaving it up would make
  # every provision a launch, and would race the user's own Start, which kills
  # by its own recorded PID and knows nothing about this one.
  local pid
  pid=$(cat "$pidfile" 2>/dev/null || echo "")
  if [ -n "$pid" ]; then
    kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    sleep 2
    kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"

  if [ "$rc" -ne 0 ]; then
    echo "[nexux] WARN: boot probe failed for $name — nothing answered on port $port"
    # The last lines of the app's own output: "did not answer on port 3000"
    # is not actionable on its own, and this is the one step whose failure is
    # unreadable without the context.
    tail -n 25 "$log" 2>/dev/null || true
    nexus_step_tail "$step" warn "$rc" "$((ended - started))" "$log"
  else
    echo "[nexux] $name answered on port $port"
    nexus_step_status "$step" warn 0 "$((ended - started))"
  fi
  return 0
}
# ------------------------------------------------------------------------`;
}

/**
 * Records a step *with* the tail of a log file.
 *
 * Separate from `nexus_step_status` because it has to JSON-escape arbitrary
 * program output — a build error routinely contains quotes, backslashes and
 * newlines, any one of which would produce a line the parser drops. python3 is
 * already the bootstrap's JSON tool of choice (`nexus-cli.ts` uses it for the
 * same reason: `ubuntu:22.04` does not ship jq).
 */
export function renderStepTailHelper(): string {
  return `# Record a step together with the last lines of its log, JSON-escaped.
nexus_step_tail() {
  local step="$1" severity="$2" rc="$3" ms="$4" log="$5"
  mkdir -p ${SANDBOX_ROOT} 2>/dev/null || true
  NEXUS_STEP="$step" NEXUS_SEV="$severity" NEXUS_RC="$rc" NEXUS_MS="$ms" NEXUS_LOG="$log" \\
  python3 -c '
import json, os, sys
try:
    with open(os.environ["NEXUS_LOG"], errors="replace") as fh:
        tail = "".join(fh.readlines()[-25:])
except Exception:
    tail = ""
sys.stdout.write(json.dumps({
    "step": os.environ["NEXUS_STEP"],
    "severity": os.environ["NEXUS_SEV"],
    "exitCode": int(os.environ["NEXUS_RC"] or 1),
    "durationMs": int(os.environ["NEXUS_MS"] or 0),
    "at": __import__("datetime").datetime.now().astimezone().isoformat(),
    "tail": tail,
}) + "\\n")
' >> ${BOOTSTRAP_REPORT_PATH} 2>/dev/null \\
    || nexus_step_status "$step" "$severity" "$rc" "$ms"
  return 0
}`;
}
