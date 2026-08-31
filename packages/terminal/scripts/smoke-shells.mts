// Manual smoke check: starts the pty server and opens one session per shell,
// asserting each lands in the requested directory. Not part of the test suite —
// it needs the machine's real shells (and a real WSL distro) to mean anything.
//
//   pnpm --filter @nexux/terminal exec tsx scripts/smoke-shells.mts
import { WebSocket } from "ws";
import { listShells } from "../src/shells";
import { startTerminalServer } from "../src/terminal-server";

const PORT = 3921;
process.env.NEXUX_TERMINAL_PORT = String(PORT);

const CWD = process.argv[2] ?? process.cwd();

type Verdict =
  | { state: "ok" }
  | { state: "elsewhere"; tail: string }
  | { state: "dead"; tail: string };

// Landing in the requested directory and opening at all are different results.
// A distro that does not mount the Windows drives (docker-desktop maps the host
// somewhere else entirely) cannot reach `/mnt/e/…`, and the `cd` is deliberately
// tolerant of that — the session is still perfectly usable, so it must not be
// reported the same way as a shell that failed to start.
function session(shellId: string, cwd: string, probe: string, expect: RegExp) {
  return new Promise<Verdict>((resolve) => {
    const qs = new URLSearchParams({ cwd, shell: shellId, cols: "100", rows: "30" });
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?${qs}`);
    let buf = "";
    const done = (verdict: Verdict) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(verdict);
    };
    const tail = () => JSON.stringify(buf.replace(/\s+/g, " ").slice(-110));
    const timer = setTimeout(() => {
      // Anything echoed back means a live shell answered the probe.
      done(buf.trim() ? { state: "elsewhere", tail: tail() } : { state: "dead", tail: tail() });
    }, 15_000);
    ws.on("open", () => setTimeout(() => ws.send(probe), 1_200));
    ws.on("message", (d) => {
      buf += d.toString();
      if (expect.test(buf)) done({ state: "ok" });
    });
    ws.on("error", () => done({ state: "dead", tail: tail() }));
  });
}

const handle = startTerminalServer();
await new Promise((r) => setTimeout(r, 300));

console.log(`\ncwd under test: ${CWD}\n`);
let dead = 0;
let elsewhere = 0;
for (const shell of listShells()) {
  // Each shell prints the working directory differently; `cd` with no argument
  // is cmd's, `pwd` covers PowerShell (aliased) and every POSIX shell.
  const probe = shell.kind === "cmd" ? "cd\r\n" : "pwd\r\n";
  const leaf = CWD.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const v = await session(shell.id, CWD, probe, new RegExp(leaf, "i"));
  if (v.state === "dead") dead++;
  if (v.state === "elsewhere") elsewhere++;
  const line =
    v.state === "ok"
      ? "OPENED IN CWD"
      : v.state === "elsewhere"
        ? `OPENED ELSEWHERE  ${v.tail}`
        : `FAILED TO OPEN    ${v.tail}`;
  console.log(`${shell.id.padEnd(26)} ${line}`);
}

await handle.close();
console.log(
  dead === 0
    ? `\nevery shell opened (${elsewhere} could not reach the requested directory)`
    : `\n${dead} shell(s) failed to open`,
);
process.exit(dead === 0 ? 0 : 1);
