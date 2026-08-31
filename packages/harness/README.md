# @nexux/harness

Brain-agnostic sandboxed execution. Gives any brain (Claude, Codex, Ollama) a
**closed feedback loop**: write code → run it → read structured result → fix.

Docker-isolated, network-off by default, ephemeral per task. See
[`specs/13-harness.md`](../../specs/13-harness.md).

## Usage

```ts
import { createHarness } from "@nexux/harness";

const harness = createHarness({ image: "node:20-bookworm" });
const sb = await harness.sandbox();

try {
  await sb.writeFile("test.js", "console.log(2 + 2)");
  const r = await sb.exec("node test.js");
  // r = { stdout: "4\n", stderr: "", exitCode: 0, durationMs, timedOut: false }
  if (r.exitCode !== 0) {
    // feed r.stderr back to the brain, regenerate, retry
  }
} finally {
  await sb.destroy();
  await harness.shutdown();
}
```

## Surface

| Method | Returns | Notes |
|---|---|---|
| `harness.sandbox()` | `Sandbox` | fresh container, started |
| `sb.exec(cmd, opts?)` | `ExecResult` | `{stdout, stderr, exitCode, durationMs, timedOut}` |
| `sb.writeFile(path, content)` | `void` | rel paths resolve under `/work` |
| `sb.readFile(path)` | `string` | |
| `sb.destroy()` | `void` | rm -f container |
| `harness.shutdown()` | `void` | tears down any leaked sandboxes |

`exec` never throws on nonzero exit — branch on `exitCode`. Timeout → `124`.

## Isolation defaults

`--network none` · `--cap-drop ALL` · `--read-only` root + tmpfs `/work` ·
`--memory 2048m` · `--cpus 2` · `--pids-limit 512` · `no-new-privileges`.

Override via `createHarness({ network: "bridge", memoryMb, cpus, mounts })`.

## Verify loop (machine-readable output)

For step "branch on result", use a JSON reporter so stdout is parseable:

| Runner | Command |
|---|---|
| node:test | `node --test --test-reporter=json` |
| vitest | `vitest run --reporter=json` |
| jest | `jest --json` |
| pytest | `pytest --json-report` |

## Status

- **P0 (done):** Docker driver, ephemeral, exec/file IO, timeouts, lockdown.
- **P1:** warm pool + reset, config wiring (`NexuxConfig.harness`).
- **P2:** brain tool adapters (Claude tool schema + MCP server).
- **P3:** artifact capture, app-run + screenshot verify.

## Requirements

Docker installed and daemon running. `dockerAvailable()` checks at runtime;
`sandbox()` throws a clear error if not.
