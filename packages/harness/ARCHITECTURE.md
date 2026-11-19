# @nexux/harness — Architecture

> Brain-agnostic sandboxed execution in locked-down, short-lived Docker containers. The closed feedback loop: write code → run → read structured result → fix. Spec: `specs/13-harness.md`.

## Purpose

Give any brain (Claude, Codex, Ollama…) non-interactive, isolated, structured execution — the opposite of the human PTY in `@nexux/terminal`. Also generates docker-compose YAML from a project stack graph.

## Key files

| File | Role |
|---|---|
| `src/types.ts` | `Sandbox` / `Harness` interfaces, `HarnessConfig`, `ExecOpts` / `ExecResult`, `Mount` |
| `src/docker.ts` | Argv-based `docker()` / `run()` spawn wrapper (no shell-injection surface), `dockerAvailable()` |
| `src/sandbox.ts` | `DockerSandbox`: hardened `docker run -d` (`--cap-drop ALL`, `--read-only` root + tmpfs workdir, no-new-privileges, pids/mem/cpu limits, `--network none` default); `exec` / `writeFile` / `readFile` / `destroy` |
| `src/harness.ts` | `createHarness()` factory — ephemeral only; `warm` lifecycle throws "not implemented (P1)" |
| `src/healthcheck.ts` | Spec 24 piece 2: `healthcheckFor(image)` — readiness probes by image family, so the bootstrap's `--wait` means ready rather than running. Unknown images get null, deliberately |
| `src/compose.ts` | Pure `generateCompose()`: stack nodes/edges → compose YAML (service-name dedup, cycle detection, `depends_on`, volumes/ports/env) |

## `writeFile` streams over stdin — do not "fix" it to `docker cp`

`writeFile` pipes content through `docker exec -i … sh -c 'cat > file'` (`sandbox.ts:88-92`). This is deliberate: `docker cp` targets the container **rootfs**, which is `--read-only`, and it ignores the tmpfs mounted at the workdir — so a `docker cp` into `/work` either fails or lands somewhere the process cannot see. Streaming via `exec` writes into the writable tmpfs, and `cat >` keeps the bytes exact (no shell interpolation of the payload; only the path is quoted).

## Security defaults

Network off, root read-only, all caps dropped, pids/memory/cpu limited. Brain never gets a raw host shell.

Caveat: the tmpfs workdir is mounted `exec` (`sandbox.ts:46`, `--tmpfs <workdir>:exec,size=512m`) — written files can be executed, which the run-code loop needs but which means this is not a `noexec` posture.

## Public API

`createHarness`, `docker`, `run`, `dockerAvailable`, `generateCompose`, `slugifyServiceName` + type interfaces.

Subpaths: `./types` and `./compose`. `./compose` is pure (its only import is `yaml`), so browser code can reach `generateCompose` / `slugifyServiceName` without the root barrel, which re-exports `docker.ts` and its `child_process` import. `apps/web`'s stack canvas imports it that way — keep `compose.ts` free of node builtins.

## Dependencies

Internal: `@nexux/config` is declared in `package.json` but **never imported** — no source file in `src/` references it. External: `yaml`. Shells out to `docker` CLI (no SDK).

## State / roadmap (spec 13 phases)

- **P0 done:** Docker driver, ephemeral, exec/read/write/destroy, tested.
- **P1 pending:** warm pool + reset, config wiring (the `harness` config slice in spec 13 does not exist yet — `HarnessConfig` is a plain interface in `src/types.ts`, not env-driven), limits hardening.
- **P2 pending:** brain tool adapters (`harness_exec` / `harness_write` / `harness_read` / `harness_reset` as Claude tool + MCP).
- **P3 pending:** artifact capture, app-run + port-forward verify.

Not to be confused with `@nexux/sandbox` (remote/local full dev VMs); harness = fast local locked-down exec.
