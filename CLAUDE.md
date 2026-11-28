# Nexux Local-First Mode

This project is in **local-first** mode:

- No multi-tenant, no Firebase, no cloud requirement
- Claude must always be used manually (`claude code`) on the host — never `claude -p` / headless, except the Nexus assistant (spec 39): `claude -p` with only the Nexus MCP tools allowed — see AGENTS.md
- Context is loaded natively via `.claude/` folder + symlink
- Skills, Tools, MCPs and Embeddings are brain-agnostic
- Host automation is reserved for non-Claude brains (Codex, xAI, Ollama, etc.)

## Read first

- [AGENTS.md](AGENTS.md) — full agent guide: rules, commands, repo map, conventions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — central architecture (each module also has its own `ARCHITECTURE.md`)
- [docs/PROGRESS.md](docs/PROGRESS.md) — current state & timeline
- [docs/DECISIONS.md](docs/DECISIONS.md) — why things are the way they are
- `specs/` — numbered design specs for in-flight work
