# @nexux/core — Architecture

> Shared type contracts only. Zero runtime code, zero dependencies (internal or external).

## Purpose

Cross-cutting TypeScript contracts consumed by packages and apps: Claude CLI stream-json event shapes, the terminal/process WebSocket protocol, and domain enums.

## Key files

| File | Role |
|---|---|
| `src/claude.ts` | `ClaudeStreamEvent` union + content-block types for parsing `claude --output-format stream-json`. Discriminants are `system` / `assistant` / `result` / `rate_limit_event` — note the `_event` suffix on the last one (`claude.ts:56`), which carries `rate_limit_info` |
| `src/websocket.ts` | `ClientMessage` / `ServerMessage` unions, `ProcessStartRequest`, `ProcessStatusResponse` |
| `src/enums.ts` | Const-array enums with derived union types: `FEATURE_STATUSES`, `FEATURE_PRIORITIES`, `CONVERSATION_STATUSES`, `CLONE_STATUSES`, `PLAN_STATUSES` |

## Public API

Everything above via `.`, plus subpath exports `./claude`, `./websocket`, `./enums`.

## Conventions

- Types only — if it needs a runtime dependency, it does not belong here.
- Enums are `as const` arrays + derived unions so Prisma string columns and UI selects share one source of truth.

## State

Complete. Consumed by `@nexux/terminal` (WS protocol) and apps (Claude stream parsing, enums).
