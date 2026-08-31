// The `nexus` command every sandbox shell gets, plus the banner that greets it.
//
// A terminal opened into a sandbox used to land on a bare `nexux@host:/opt/nexus$`
// with no way to know which repos are checked out, which command boots them, or
// what is already running. This ships two files into the box at bootstrap:
//
//   /opt/nexus/nexus.json      the manifest — repos, dirs, commands, ports
//   /etc/profile.d/nexus-cli.sh   the banner + the `nexus` function
//
// The manifest is the reason this can work offline: the process *plans* live in
// the host's database (see apps/web/src/lib/stack/sandbox-processes.ts), and the
// sandbox has no route back to it. Rendering them into a file at provision time
// makes `nexus start web` answerable from inside the box alone. It also means
// the file goes stale when the stack canvas is edited — pushNexusCli() on the
// host re-writes it, and `nexus` prints the manifest's age so a stale answer is
// visible rather than silent.
//
// Start/stop deliberately mirror sandbox-process-manager.ts byte for byte: the
// same /tmp/nexus-proc-<key>.{sh,pid,log} paths, the same setsid + PID-file
// discipline, the same kill-by-recorded-PID rule. A process started from the
// dashboard must be stoppable from the terminal and vice versa — two supervisors
// with different bookkeeping would leak orphans the UI could never reap.

import { safeSlug } from "./slug";
import type { SandboxSpec } from "./types";

/** Where the manifest lands. Read by `nexus`, rewritten by pushNexusCli(). */
export const NEXUS_MANIFEST_PATH = "/opt/nexus/nexus.json";
/** Sourced by every login shell — both terminal spawn paths use `bash -l`. */
export const NEXUS_CLI_PATH = "/etc/profile.d/nexus-cli.sh";

/** One startable command, as the sandbox needs to know it. */
export type NexusManifestProcess = {
  /** Same key the host uses — `<nodeId>#<i>` or `repo-<repositoryId>`. */
  key: string;
  /** Short handle typed at the prompt: `nexus start web`. */
  alias: string;
  label: string;
  command: string;
  cwd: string;
  port: number | null;
  /**
   * Ports liveness may probe. Distinct from `port` (which drives the display
   * and HTTP wait): a launcher's `port` is null because its shell exits by
   * design, but its declared ports are how status can still see the services
   * it detached.
   */
  checkPorts: number[];
  role: "run" | "services";
};

export type NexusManifest = {
  version: 1;
  project: string;
  sandbox: string;
  /** ISO timestamp — rendered into the banner so staleness is visible. */
  generatedAt: string;
  repos: Array<{ name: string; alias: string; dir: string }>;
  processes: NexusManifestProcess[];
};

/**
 * Turn a label into a typeable alias.
 *
 * Aliases are what the user actually types, so they must be stable and short.
 * safeSlug already gives DNS-safe lowercase; the extra pass drops the leading
 * junk a name like "  Web (1)" would leave behind.
 */
function aliasOf(label: string): string {
  return safeSlug(label).replace(/^-+|-+$/g, "") || "proc";
}

/**
 * Alias collisions resolved by suffix, deterministically.
 *
 * Two stack nodes can share a display name ("api" in two repos). Appending the
 * ordinal keeps both addressable rather than letting the second silently
 * shadow the first.
 */
function uniqueAliases<T>(items: T[], labelOf: (item: T) => string): string[] {
  const used = new Map<string, number>();
  return items.map((item) => {
    const base = aliasOf(labelOf(item));
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  });
}

/** Build the manifest from a spec plus the host's resolved process plans. */
export function buildNexusManifest(input: {
  project: string;
  sandbox: string;
  generatedAt: string;
  repos: Array<{ name: string }>;
  processes: Array<{
    key: string;
    label: string;
    command: string;
    cwd: string;
    port: number | null;
    checkPorts?: number[];
    role: "run" | "services";
  }>;
}): NexusManifest {
  const repoAliases = uniqueAliases(input.repos, (r) => r.name);
  const procAliases = uniqueAliases(input.processes, (p) => p.label);
  return {
    version: 1,
    project: input.project,
    sandbox: input.sandbox,
    generatedAt: input.generatedAt,
    repos: input.repos.map((r, i) => ({
      name: r.name,
      alias: repoAliases[i]!,
      dir: `/opt/nexus/${safeSlug(r.name)}`,
    })),
    processes: input.processes.map((p, i) => ({
      key: p.key,
      alias: procAliases[i]!,
      label: p.label,
      command: p.command,
      cwd: p.cwd,
      port: p.port,
      checkPorts: p.checkPorts ?? [],
      role: p.role,
    })),
  };
}

/**
 * Manifest from a spec alone — the bootstrap's fallback.
 *
 * renderCloudInit only sees SandboxSpec, which carries each repo's runCommand
 * but none of the canvas's port resolution or multi-phase keys. Callers that
 * *do* have the plans (the host) should pass them to buildNexusManifest
 * instead; this keeps a sandbox provisioned outside that path still useful.
 */
export function manifestFromSpec(
  spec: SandboxSpec,
  opts: { project?: string; generatedAt: string },
): NexusManifest {
  // The same filter renderCloudInit applies: a repo with neither a clone URL
  // nor a mount never gets a checkout, so listing it would point `nexus cd` at
  // a directory that does not exist.
  const repos = spec.repos.filter((r) => r.repoUrl || r.mountPath);
  return buildNexusManifest({
    project: opts.project ?? spec.name,
    sandbox: spec.name,
    generatedAt: opts.generatedAt,
    repos: repos.map((r) => ({ name: r.name })),
    processes: repos
      .filter((r) => r.runCommand?.trim())
      .map((r) => ({
        // `repo-<name>` here, not `repo-<repositoryId>`: the spec has no ids.
        // The host overwrites this manifest with real keys on first push.
        key: `repo-${safeSlug(r.name)}`,
        label: r.name,
        command: r.runCommand!.trim(),
        cwd: `/opt/nexus/${safeSlug(r.name)}`,
        port: null,
        role: "run" as const,
      })),
  });
}

/**
 * The shell file itself.
 *
 * Everything is quoted with a heredoc sentinel at the call site, so this body
 * is written verbatim — no host-side interpolation, and nothing here needs to
 * survive a second round of shell quoting.
 *
 * Two constraints shape it:
 *
 * 1. The banner is guarded on an interactive shell. execRemote() runs every
 *    host→sandbox command through `bash -lc`, which sources profile.d, and
 *    sandbox-process-manager.ts regexes that stdout for `PID:` / `PREVIEW:`.
 *    An unguarded banner would corrupt every one of those reads.
 * 2. `nexus` is a function, not a script in PATH, so it can be defined without
 *    a separate file and still work under `bash -l`. `nexus cd` needs to change
 *    the caller's directory, which a subprocess could never do.
 *
 * jq is not assumed — the base image has no guarantee of it. Parsing is done
 * with python3 (present on ubuntu:22.04) and degrades to a clear error.
 */
function renderCliScript(): string {
  // `@@{` stands in for bash's `${` throughout the body below. String.raw
  // still performs ${} interpolation — it only suppresses backslash escapes —
  // so a literal `${VAR}` in a raw template is a TypeScript syntax error, and
  // escaping it would emit the backslash verbatim into the shell. The
  // placeholder keeps the script readable and is substituted back here.
  return String.raw`# Nexus sandbox CLI — generated at provision time, do not edit by hand.
# Regenerated by the dashboard (Sandbox → Refresh CLI); local edits are lost.

NEXUS_MANIFEST="/opt/nexus/nexus.json"

# Read the manifest with python3 (no jq dependency on the base image).
# $1 is a python expression over 'm', the parsed manifest.
_nexus_q() {
  [ -f "$NEXUS_MANIFEST" ] || { echo "nexus: no manifest at $NEXUS_MANIFEST" >&2; return 1; }
  python3 - "$NEXUS_MANIFEST" "$1" <<'NEXUS_PY_EOF'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        m = json.load(fh)
except Exception as exc:
    print("nexus: unreadable manifest: %s" % exc, file=sys.stderr)
    raise SystemExit(1)
try:
    out = eval(sys.argv[2], {"m": m, "json": json})
except Exception as exc:
    print("nexus: query failed: %s" % exc, file=sys.stderr)
    raise SystemExit(1)
if out is None:
    raise SystemExit(1)
if isinstance(out, (list, tuple)):
    for line in out:
        print(line)
else:
    print(out)
NEXUS_PY_EOF
}

# Resolve an alias (or a raw key) to one manifest field.
_nexus_field() {
  _nexus_q "next((p[$(printf '%s' "\"$2\"")] for p in m['processes'] if p['alias']==$(printf '%s' "\"$1\"") or p['key']==$(printf '%s' "\"$1\"")), None)"
}

# PID/log/script paths — identical to sandbox-process-manager.ts, so a process
# started here is visible to (and stoppable by) the dashboard, and vice versa.
_nexus_slug() { printf '%s' "$1" | sed 's/[^a-zA-Z0-9_-]/-/g'; }

# Existing pre-rename file wins, else the current name. A process started
# before the rename recorded /tmp/nexux-proc-*, and resolving only the new name
# would report it stopped while it keeps holding its port. Start always writes
# the new name (nothing exists yet at that point), so the old set drains as
# processes are restarted.
_nexus_pick() {
  if [ -e "/tmp/nexux-proc-$1" ] && [ ! -e "/tmp/nexus-proc-$1" ]; then
    echo "/tmp/nexux-proc-$1"
  else
    echo "/tmp/nexus-proc-$1"
  fi
}
_nexus_pidfile()    { _nexus_pick "$(_nexus_slug "$1").pid"; }
_nexus_logfile()    { _nexus_pick "$(_nexus_slug "$1").log"; }
_nexus_scriptfile() { echo "/tmp/nexus-proc-$(_nexus_slug "$1").sh"; }
_nexus_tunnelpid()  { _nexus_pick "$(_nexus_slug "$1")-tunnel.pid"; }

# Alive iff the PID file exists and that pid still answers signal 0.
_nexus_alive() {
  local pidfile; pidfile="$(_nexus_pidfile "$1")"
  [ -f "$pidfile" ] || return 1
  kill -0 "$(cat "$pidfile")" 2>/dev/null
}

# TCP connect on loopback, one attempt per (space-separated) port in $1.
# A detached launcher's PID is gone by design — docker compose exits the moment
# its containers are up — so its declared ports are the honest liveness signal.
_nexus_port_open() {
  local p
  for p in $1; do
    (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null && return 0
  done
  return 1
}

# Fallback for a launcher with no declared ports: ask docker itself, in the
# launcher's cwd ($1). No sniffing of the launch command — launchers hide
# compose behind make targets (make docker-up), so the command text proves
# nothing; a cwd that is not a compose project simply answers empty.
_nexus_compose_up() {
  command -v docker >/dev/null 2>&1 || return 1
  [ -n "$(cd "$1" 2>/dev/null && docker compose ps --status=running -q 2>/dev/null)" ]
}

_nexus_banner() {
  local age
  printf '\033[38;5;39m%s\033[0m\n' '
   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
   ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
   ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
   ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
   ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║
   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝'
  if [ -f "$NEXUS_MANIFEST" ]; then
    printf '   \033[2m%s · sandbox %s\033[0m\n\n' \
      "$(_nexus_q "m['project']" 2>/dev/null || echo project)" \
      "$(_nexus_q "m['sandbox']" 2>/dev/null || echo '?')"
    _nexus_projects
    echo
    _nexus_status
  else
    printf '   \033[2mno manifest yet — sandbox still bootstrapping?\033[0m\n'
  fi
  printf '\n   \033[2mtype\033[0m \033[1mnexus help\033[0m \033[2mfor commands\033[0m\n\n'
}

_nexus_projects() {
  printf '   \033[1mProjects\033[0m\n'
  _nexus_q "['   %-14s %s' % (r['alias'], r['dir']) for r in m['repos']] or ['   \033[2m(none)\033[0m']"
}

# One line per process: a colour dot, the alias, where it runs, its port.
# Liveness is role-aware. A services launcher exits once its containers are
# up, so a dead PID says nothing — its declared ports (or docker itself) are
# asked instead. A run process with no live PID but an answering port was
# started by hand; that is worth showing, not hiding.
_nexus_status() {
  printf '   \033[1mProcesses\033[0m\n'
  # Fields ride on \x1f, not tab: tab is IFS whitespace, so an empty field (a
  # launcher's port) would collapse and shift every column after it.
  local rows; rows="$(_nexus_q "['%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s' % (p['alias'], p['key'], p['port'] or '', p['role'], ' '.join(str(x) for x in (p.get('checkPorts') or [])), p['cwd'], p['command']) for p in m['processes']]")" || return 1
  if [ -z "$rows" ]; then
    printf '   \033[2m(none configured — draw a stack or set a run command)\033[0m\n'
    return 0
  fi
  local alias key port role cports cwd cmd dot state
  while IFS="$(printf '\037')" read -r alias key port role cports cwd cmd; do
    [ -n "$alias" ] || continue
    if _nexus_alive "$key"; then
      dot='\033[32m●\033[0m'; state="running$([ -n "$port" ] && echo " :$port")"
    elif [ "$role" = "services" ] && { _nexus_port_open "$cports" || _nexus_compose_up "$cwd"; }; then
      dot='\033[32m●\033[0m'; state="up (detached)"
    elif [ "$role" != "services" ] && [ -n "$cports" ] && _nexus_port_open "$cports"; then
      dot='\033[33m●\033[0m'; state="up (external$([ -n "$port" ] && echo " :$port"))"
    else
      dot='\033[2m○\033[0m'; state="stopped"
    fi
    printf "   $dot %-14s \033[2m%s\033[0m\n" "$alias" "$state"
  done <<< "$rows"
}

# Start: write a launcher script, setsid it into its own process group, record
# the pid. Sourcing nexus-env.sh inside the script matters — setsid detaches
# from this shell, so the process must re-establish the project env itself.
_nexus_start() {
  local alias="$1"
  [ -n "$alias" ] || { echo "usage: nexus start <name>" >&2; return 2; }
  local key cwd cmd port
  key="$(_nexus_field "$alias" key)"   || { echo "nexus: unknown process '$alias'" >&2; return 1; }
  cwd="$(_nexus_field "$alias" cwd)"
  cmd="$(_nexus_field "$alias" command)"
  port="$(_nexus_field "$alias" port 2>/dev/null)"

  if _nexus_alive "$key"; then
    echo "nexus: $alias already running (pid $(cat "$(_nexus_pidfile "$key")"))"
    return 0
  fi

  local script log pidfile
  script="$(_nexus_scriptfile "$key")"; log="$(_nexus_logfile "$key")"; pidfile="$(_nexus_pidfile "$key")"
  mkdir -p "$cwd" 2>/dev/null || true
  {
    echo '#!/bin/bash'
    echo '[ -f /etc/profile.d/nexus-env.sh ] && . /etc/profile.d/nexus-env.sh'
    echo "cd $(printf '%q' "$cwd")"
    echo "exec $cmd"
  } > "$script"
  chmod +x "$script"
  : > "$log"
  # setsid gives the process its own group, which is what lets stop take a dev
  # server's children with it. It is missing on some hosts (notably macOS, where
  # these are unit-tested); fall back rather than recording the pid of a shell
  # that died on "command not found".
  if command -v setsid >/dev/null 2>&1; then
    setsid "$script" > "$log" 2>&1 < /dev/null &
  else
    "$script" > "$log" 2>&1 < /dev/null &
  fi
  local pid=$!

  # Confirm before recording: a command that dies instantly (bad path, missing
  # binary) would otherwise leave a pidfile claiming success, and every later
  # 'nexus status' would report "stopped" for something it just said it started.
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    printf '\033[31m✗\033[0m %s exited immediately\n' "$alias" >&2
    tail -n 15 "$log" >&2
    return 1
  fi

  echo "$pid" > "$pidfile"
  printf '\033[32m▸\033[0m started %s (pid %s)%s\n' "$alias" "$pid" \
    "$([ -n "$port" ] && echo " → http://localhost:$port")"
  echo "  logs: nexus logs $alias"
}

# Stop by recorded PID only. Negating the pid targets the process group setsid
# created, so 'pnpm dev' takes its child node server with it; a 'pkill -f' here
# would match this very shell's command line.
_nexus_stop() {
  local alias="$1"
  [ -n "$alias" ] || { echo "usage: nexus stop <name>" >&2; return 2; }
  local key; key="$(_nexus_field "$alias" key)" || { echo "nexus: unknown process '$alias'" >&2; return 1; }
  local stopped=1 f
  for f in "$(_nexus_pidfile "$key")" "$(_nexus_tunnelpid "$key")"; do
    if [ -f "$f" ]; then
      kill -TERM -"$(cat "$f")" 2>/dev/null || kill -TERM "$(cat "$f")" 2>/dev/null || true
      rm -f "$f"; stopped=0
    fi
  done
  if [ $stopped -eq 0 ]; then printf '\033[33m■\033[0m stopped %s\n' "$alias"
  else echo "nexus: $alias was not running"; fi
  # Killing the launcher's shell never was what stops its containers — say so
  # instead of letting "stopped" imply the services went down with it.
  if [ "$(_nexus_field "$alias" role 2>/dev/null)" = "services" ]; then
    local svc_cwd; svc_cwd="$(_nexus_field "$alias" cwd 2>/dev/null)"
    if _nexus_compose_up "$svc_cwd"; then
      echo "  note: its containers are still up — 'docker compose down' in $svc_cwd stops them"
    fi
  fi
}

_nexus_all() {
  local action="$1" rows alias
  rows="$(_nexus_q "[p['alias'] for p in m['processes']]")" || return 1
  [ -n "$rows" ] || { echo "nexus: nothing configured"; return 0; }
  while read -r alias; do
    [ -n "$alias" ] || continue
    "_nexus_$action" "$alias"
  done <<< "$rows"
}

_nexus_logs() {
  local alias="$1"
  [ -n "$alias" ] || { echo "usage: nexus logs <name> [-f]" >&2; return 2; }
  local key; key="$(_nexus_field "$alias" key)" || { echo "nexus: unknown process '$alias'" >&2; return 1; }
  local log; log="$(_nexus_logfile "$key")"
  [ -f "$log" ] || { echo "nexus: no log yet for $alias (never started?)" >&2; return 1; }
  if [ "$2" = "-f" ] || [ "$2" = "--follow" ]; then tail -f "$log"; else tail -n 200 "$log"; fi
}

_nexus_cd() {
  local alias="$1"
  [ -n "$alias" ] || { cd /opt/nexus || return 1; return 0; }
  local dir
  dir="$(_nexus_q "next((r['dir'] for r in m['repos'] if r['alias']==$(printf '%s' "\"$alias\"") or r['name']==$(printf '%s' "\"$alias\"")), None)")" \
    || { echo "nexus: unknown project '$alias'" >&2; return 1; }
  cd "$dir" || return 1
}

_nexus_help() {
  cat <<'NEXUS_HELP_EOF'

  nexus — sandbox control

    nexus                    banner, projects and process status
    nexus status             process status only
    nexus projects           checked-out repos and their paths

    nexus start <name>       start a process
    nexus stop <name>        stop it (by recorded PID, with its group)
    nexus restart <name>     stop then start
    nexus start all          start every configured process
    nexus stop all           stop every configured process

    nexus logs <name>        last 200 lines
    nexus logs <name> -f     follow
    nexus cd <project>       cd into a repo checkout
    nexus info               manifest path, age, sandbox name

  <name> is the alias shown by 'nexus status'; the full key works too.
  Processes started here are the same ones the dashboard manages — start in
  the terminal, stop from the UI, or the reverse.

NEXUS_HELP_EOF
}

_nexus_info() {
  echo "manifest : $NEXUS_MANIFEST"
  [ -f "$NEXUS_MANIFEST" ] || { echo "status   : missing"; return 0; }
  echo "project  : $(_nexus_q "m['project']")"
  echo "sandbox  : $(_nexus_q "m['sandbox']")"
  echo "written  : $(_nexus_q "m['generatedAt']")"
  echo "note     : regenerate from the dashboard if the stack changed since then"
}

nexus() {
  local cmd="@@{1:-}"
  [ $# -gt 0 ] && shift
  case "$cmd" in
    ""|dash|home)      _nexus_banner ;;
    help|-h|--help)    _nexus_help ;;
    status|ps|ls)      _nexus_status ;;
    projects|repos)    _nexus_projects ;;
    info)              _nexus_info ;;
    cd)                _nexus_cd "$@" ;;
    logs|log)          _nexus_logs "$@" ;;
    start|up)          if [ "$1" = "all" ]; then _nexus_all start; else _nexus_start "$@"; fi ;;
    stop|down)         if [ "$1" = "all" ]; then _nexus_all stop; else _nexus_stop "$@"; fi ;;
    restart)
      if [ "$1" = "all" ]; then _nexus_all stop; sleep 1; _nexus_all start
      else _nexus_stop "$1"; sleep 1; _nexus_start "$1"; fi ;;
    *) echo "nexus: unknown command '$cmd' — try 'nexus help'" >&2; return 2 ;;
  esac
}

# 'nexux' was the old spelling, on boxes provisioned before the rename. Kept as
# an alias so muscle memory (and any script that typed it) still works.
nexux() { nexus "$@"; }

# Completion over the aliases the manifest declares.
_nexus_complete() {
  local cur="@@{COMP_WORDS[COMP_CWORD]}" prev="@@{COMP_WORDS[COMP_CWORD-1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "help status projects info cd logs start stop restart" -- "$cur"))
  elif [ "$prev" = "cd" ]; then
    COMPREPLY=($(compgen -W "$(_nexus_q "[r['alias'] for r in m['repos']]" 2>/dev/null)" -- "$cur"))
  else
    COMPREPLY=($(compgen -W "all $(_nexus_q "[p['alias'] for p in m['processes']]" 2>/dev/null)" -- "$cur"))
  fi
}
complete -F _nexus_complete nexus nexux 2>/dev/null || true

# Greet interactive shells only. execRemote() runs host commands through
# 'bash -lc', which sources this file, and the host parses that stdout for
# markers like 'PID:' — a banner there would corrupt every one of those reads.
case $- in
  *i*) [ -z "@@{NEXUS_NO_BANNER:-}" ] && _nexus_banner ;;
esac
`.replaceAll("@@{", "${");
}

/** Heredoc sentinel guard — the same rule the compose/settings blocks use. */
function assertNoSentinel(content: string, sentinel: string): void {
  if (content.includes(sentinel)) {
    throw new Error(`Content contains the heredoc sentinel ${sentinel}`);
  }
}

/**
 * Bash that writes the manifest, the CLI, and wires it into non-login shells.
 *
 * Returned as a bootstrap section; also reused verbatim by the host's push
 * path, so a running sandbox and a fresh one end up with identical files.
 */
export function renderNexusCliSection(manifest: NexusManifest): string {
  const json = JSON.stringify(manifest, null, 2);
  assertNoSentinel(json, "NEXUS_MANIFEST_EOF");
  const script = renderCliScript();
  assertNoSentinel(script, "NEXUS_CLI_EOF");

  return `echo "[nexux] installing nexus CLI"
mkdir -p /opt/nexus
cat > ${NEXUS_MANIFEST_PATH} <<'NEXUS_MANIFEST_EOF'
${json}
NEXUS_MANIFEST_EOF
chmod 644 ${NEXUS_MANIFEST_PATH}

cat > ${NEXUS_CLI_PATH} <<'NEXUS_CLI_EOF'
${script}
NEXUS_CLI_EOF
chmod 644 ${NEXUS_CLI_PATH}

# Drop the pre-rename copy. Unlike nexux-env.sh this gets no compat symlink:
# profile.d sources every file in it, so a symlink would define the same
# functions twice, and the old copy still names the old paths.
rm -f /etc/profile.d/nexux-cli.sh

# profile.d covers login shells (both terminal spawn paths use \`bash -l\`);
# VS Code remote terminals spawn non-login interactive bash, which does not
# read it — source it from bashrc too, exactly as nexus-env.sh does.
#
# Legacy rc files carry a line sourcing the deleted nexux-cli.sh; rewrite it in
# place, otherwise every shell opens with a 'no such file' and the guard below
# (which greps for the new name) appends a second line rather than fixing it.
for rc in /root/.bashrc /home/nexus/.bashrc /home/nexux/.bashrc; do
  [ -f "$rc" ] || continue
  sed -i 's#/etc/profile.d/nexux-cli\.sh#${NEXUS_CLI_PATH}#g' "$rc" || true
  grep -qs "nexus-cli.sh" "$rc" || \\
    echo '[ -f ${NEXUS_CLI_PATH} ] && . ${NEXUS_CLI_PATH}' >> "$rc"
done`;
}
