import { strict as assert } from "node:assert";
import { test } from "node:test";

import { defaultShellId, listShells, parseShellId, spawnPlan, toWslPath } from "./shells";

// --- path translation --------------------------------------------------------
// The one piece of pure logic here, and the one that decides whether a WSL
// terminal lands in the project or in the home dir.

test("a Windows drive path maps under /mnt", () => {
  assert.equal(toWslPath("E:\\workspace\\mt5-api"), "/mnt/e/workspace/mt5-api");
  assert.equal(toWslPath("C:\\Users\\dev"), "/mnt/c/Users/dev");
});

test("a drive root maps without a trailing slash", () => {
  assert.equal(toWslPath("E:\\"), "/mnt/e");
  assert.equal(toWslPath("E:/"), "/mnt/e");
});

test("a trailing separator does not leave an empty segment", () => {
  assert.equal(toWslPath("E:\\workspace\\"), "/mnt/e/workspace");
});

test("a \\\\wsl.localhost share maps to the path inside the distro", () => {
  assert.equal(
    toWslPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\proj"),
    "/home/dev/proj",
  );
  // The legacy prefix is still what older Explorer entries carry.
  assert.equal(
    toWslPath("\\\\wsl$\\Ubuntu-26.04\\srv\\app"),
    "/srv/app",
  );
  // The distro root itself has nothing after the distro name.
  assert.equal(toWslPath("\\\\wsl.localhost\\Ubuntu-24.04"), "/");
});

test("a path that is already POSIX is left alone", () => {
  // Callers may have stored a Linux path directly; rewriting it would break it.
  assert.equal(toWslPath("/home/dev/proj"), "/home/dev/proj");
  assert.equal(toWslPath("/mnt/e/workspace"), "/mnt/e/workspace");
});

// --- spawn plans -------------------------------------------------------------

test("a WSL plan cds inside the distro and tolerates a missing path", () => {
  const plan = spawnPlan(
    { id: "wsl:Ubuntu-24.04", label: "WSL", kind: "wsl", distro: "Ubuntu-24.04" },
    "E:\\workspace\\mt5-api",
  );
  assert.deepEqual(plan.args.slice(0, 2), ["-d", "Ubuntu-24.04"]);
  const command = plan.args[plan.args.length - 1];
  assert.match(command, /cd '\/mnt\/e\/workspace\/mt5-api'/);
  // Without the redirect a path that does not exist yet kills the session
  // instead of dropping the user in their home dir.
  assert.match(command, /2>\/dev\/null/);
  // bash when the distro has it, sh otherwise — `docker-desktop` is busybox and
  // dies with "bash: not found" if bash is assumed.
  assert.match(command, /exec bash -l; else exec sh -l/);
  assert.equal(plan.args[plan.args.length - 3], "sh");
  // node-pty's cwd is a Windows directory; the Linux one is the cd above, so
  // the plan must not hand it a path Windows cannot chdir to.
  assert.equal(plan.cwd, undefined);
});

test("a path with a quote cannot break out of the WSL command", () => {
  const plan = spawnPlan(
    { id: "wsl:d", label: "WSL", kind: "wsl", distro: "d" },
    "/tmp/it's here",
  );
  const command = plan.args[plan.args.length - 1];
  assert.match(command, /cd '\/tmp\/it'\\''s here'/);
});

test("Windows shells get no POSIX -i flag", () => {
  // `-i` is what makes a POSIX shell interactive; cmd.exe and powershell.exe
  // reject it, which is why every Windows terminal failed to spawn.
  const cmd = spawnPlan({ id: "cmd", label: "cmd", kind: "cmd" }, "C:\\x");
  assert.deepEqual(cmd.args, []);
  assert.equal(cmd.cwd, "C:\\x");

  const ps = spawnPlan(
    { id: "powershell", label: "PowerShell", kind: "powershell" },
    "C:\\x",
  );
  assert.ok(!ps.args.includes("-i"));
  assert.ok(ps.args.includes("-NoLogo"));
});

test("a POSIX plan keeps the interactive flag", () => {
  const plan = spawnPlan({ id: "posix", label: "sh", kind: "posix" }, "/tmp");
  assert.deepEqual(plan.args, ["-i"]);
  assert.equal(plan.cwd, "/tmp");
});

// --- id resolution -----------------------------------------------------------

test("an unknown shell id falls back to this machine's default", () => {
  // Terminal state is restored from localStorage and may name a shell from
  // another machine, or a distro since removed. That must not be fatal — the
  // server warns and opens the default instead.
  const resolved = parseShellId("wsl-on-someone-elses-laptop");
  assert.equal(resolved.id, defaultShellId());
});

test("a wsl: id resolves to that distro even if it is not installed here", () => {
  // Enumerating distros costs a subprocess; trusting the id keeps the hot path
  // cheap, and wsl.exe reports a missing distro far better than we could.
  const resolved = parseShellId("wsl:Ubuntu-99.04");
  assert.equal(resolved.kind, "wsl");
  assert.equal(resolved.distro, "Ubuntu-99.04");
});

test("an empty id resolves to the default, and the default is offered", () => {
  assert.equal(parseShellId(null).id, defaultShellId());
  assert.equal(parseShellId("  ").id, defaultShellId());
  const shells = listShells();
  assert.ok(shells.length > 0, "no shells detected on this machine");
  assert.ok(
    shells.some((s) => s.id === defaultShellId()),
    `default ${defaultShellId()} is not among ${shells.map((s) => s.id).join(", ")}`,
  );
});
