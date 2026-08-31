# Contributing to Nexus

Thanks for your interest in contributing! Nexus is a local-first AI dev
orchestrator — a pnpm + Turborepo monorepo with a Next.js dashboard
(`apps/web`), a Tauri desktop shell (`apps/native`) and nine `@nexux/*`
packages.

## Getting started

**Requirements:** Node ≥ 20, pnpm ≥ 10. Docker, Ollama and Terraform are
optional (see the README's optional-dependency table).

```bash
pnpm install
pnpm db:migrate
pnpm dev          # dashboard on http://localhost:3333
```

Other useful commands:

```bash
pnpm test         # tsx --test across the monorepo
pnpm lint         # eslint
pnpm typecheck    # tsc --noEmit per package
pnpm build        # production build
pnpm dev:native   # Tauri desktop shell in dev mode
```

## Before you code

- Read [AGENTS.md](AGENTS.md) — the rules and conventions there apply to
  humans too, not only coding agents.
- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the map; each module
  has its own `ARCHITECTURE.md` next to its code.
- [docs/DECISIONS.md](docs/DECISIONS.md) records *why* things are the way they
  are. If your change fights an existing decision, open an issue first.

## Making changes

- **Branches:** `feat/…`, `fix/…`, `chore/…`, `docs/…` off `main`.
- **Commits:** conventional-commit style (`feat(scope): …`, `fix(scope): …`).
  Look at `git log` for the house voice.
- **Tests:** logic lives in pure modules (`lib/`, package sources) precisely
  so `tsx --test` can reach it — put new logic there and test it. The test
  glob is `src/**/*.test.ts`.
- **Migrations are append-only.** Never edit an existing migration under
  `packages/db/prisma/migrations/`; add a new one.
- **Secrets never land in the repo** — not in code, tests, fixtures or docs.
  Redact real hostnames, IPs and tokens from examples and logs.
- Keep docs honest: shipping something significant → add a line to
  `docs/PROGRESS.md`; making a non-obvious choice → add a `D-…` entry to
  `docs/DECISIONS.md`; changing a module's shape → touch its
  `ARCHITECTURE.md`.

## Pull requests

- One concern per PR; keep them reviewable.
- Say what you verified, not just what you changed — "tests green" and, when
  it applies, how you drove it end to end.
- CI runs lint, typecheck, and tests across every package; all three must
  pass.

## Reporting bugs & proposing features

Use the issue templates. For security vulnerabilities, **do not open a public
issue** — see [SECURITY.md](SECURITY.md).
