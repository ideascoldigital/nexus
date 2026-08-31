# Monorepo Migration Plan

Split current single Next.js app into pnpm workspaces with shared packages for web + native (Tauri) dual deployment.

## Target structure

```
nexux/
  apps/
    web/                          # Next.js full (SSR + API routes)
    native/                       # Tauri shell wrapping Next.js sidecar
  packages/
    core/                         # Pure TS domain logic, types, zod schemas
    ui/                           # React components + hooks (shadcn, Tailwind)
    db/                           # Prisma schema + client + generated
    storage/                      # FS/blob adapter (local | volume | s3)
    llm/                          # LLM provider adapters (ollama | anthropic | openai)
    embeddings/                   # LanceDB + Ollama embed wrapper
    config/                       # Runtime mode detection, env loader
    terminal/                     # node-pty WS server (sidecar)
  prisma/                         # → moves into packages/db/prisma
  specs/
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
  package.json                    # workspace root
```

## File mapping (current → target)

### Core (pure TS, no React, no Node-only deps)

| Current | Target |
|---------|--------|
| `src/types/*.ts` | `packages/core/src/types/` |
| `src/lib/context-builder.ts` | `packages/core/src/context/` |
| Zod schemas inline en services | `packages/core/src/schemas/` (extract) |

### DB

| Current | Target |
|---------|--------|
| `prisma/schema.prisma` | `packages/db/prisma/schema.prisma` |
| `prisma/migrations/` | `packages/db/prisma/migrations/` |
| `src/generated/prisma/` | `packages/db/src/generated/` |
| `src/lib/prisma.ts` | `packages/db/src/client.ts` (refactor: env-driven URL) |

### Storage

| Current | Target |
|---------|--------|
| Inline `fs` calls en services | `packages/storage/src/adapter.ts` (interface) |
| `data/` dir handling | `packages/storage/src/local.ts` |
| (new) S3 impl | `packages/storage/src/s3.ts` |

### LLM + Embeddings

| Current | Target |
|---------|--------|
| `src/lib/codex-api.ts` | `packages/llm/src/providers/codex.ts` |
| `src/lib/embeddings/*` | `packages/embeddings/src/` |
| Ollama calls inline | `packages/llm/src/providers/ollama.ts` |

### UI

| Current | Target |
|---------|--------|
| `src/components/ui/*` (shadcn) | `packages/ui/src/components/` |
| `src/components/{assistant,projects,terminal,...}` | `packages/ui/src/features/` (or stay in apps/web if app-specific) |
| `src/hooks/*` | `packages/ui/src/hooks/` |
| `src/app/globals.css` | `packages/ui/src/styles/globals.css` |

### Services (business logic — needs split)

`src/services/*.ts` mixed: some pure (validation), some Prisma-heavy.
- Pure → `packages/core/src/services/`
- DB-bound → `packages/db/src/repositories/`
- Keep thin API route handlers in `apps/web/src/app/api/`

### Apps/web

| Current | Target |
|---------|--------|
| `src/app/(dashboard)/*` | `apps/web/src/app/(dashboard)/` |
| `src/app/api/*` | `apps/web/src/app/api/` |
| `src/app/layout.tsx` | `apps/web/src/app/layout.tsx` |
| `src/providers/*` | `apps/web/src/providers/` |
| `next.config.ts` | `apps/web/next.config.ts` |
| `server/terminal-server.ts` | `packages/terminal/src/server.ts` |

### Apps/native (new)

```
apps/native/
  src-tauri/
    Cargo.toml
    tauri.conf.json
    src/main.rs                   # spawn Node sidecar, open webview at localhost
    binaries/                     # node sidecar bundled
  package.json
  build-sidecar.ts                # bundle Next standalone + node runtime
```

Sidecar approach:
- `apps/web` Next.js built with `output: 'standalone'`
- Bundled with `node` binary as Tauri sidecar
- Tauri main.rs spawns sidecar, waits for `:PORT` ready, opens webview

## Package interfaces

### `@nexux/config`

```ts
export type Mode = 'local' | 'server';
export const MODE: Mode = process.env.NEXUX_MODE === 'server' ? 'server' : 'local';

export const config = {
  mode: MODE,
  databaseUrl: process.env.DATABASE_URL!,
  dataDir: process.env.NEXUX_DATA_DIR ?? path.join(os.homedir(), '.nexux'),
  llm: {
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    anthropicKey: process.env.ANTHROPIC_API_KEY,
  },
};
```

### `@nexux/storage`

```ts
export interface StorageAdapter {
  read(key: string): Promise<Buffer>;
  write(key: string, data: Buffer): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  exists(key: string): Promise<boolean>;
}

export function createStorage(): StorageAdapter {
  return config.mode === 'local' ? new LocalFsStorage(config.dataDir) : new S3Storage(...);
}
```

### `@nexux/db`

```ts
// Env-driven URL, no hardcoded path
export const prisma = new PrismaClient({
  adapter: createAdapter(config.databaseUrl),
});

function createAdapter(url: string) {
  if (url.startsWith('file:')) return new PrismaBetterSqlite3({ url });
  if (url.startsWith('postgresql://')) return new PrismaPg({ url });
  throw new Error(`Unsupported DATABASE_URL: ${url}`);
}
```

Schema compat:
- Audit `schema.prisma` for SQLite-only types
- Add `provider = env("DATABASE_PROVIDER")` — multi-provider Prisma 7 ok
- Generate separate clients if needed, or use `previewFeatures = ["driverAdapters"]`

### `@nexux/llm`

```ts
export interface LLMProvider {
  chat(messages: Message[], opts?: ChatOpts): AsyncIterable<string>;
  embed(text: string): Promise<number[]>;
}

export function createLLM(provider: 'ollama' | 'anthropic' | 'openai'): LLMProvider;
```

## Tooling

### `pnpm-workspace.yaml`

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "dev": { "cache": false, "persistent": true },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

### `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "baseUrl": "."
  }
}
```

Each package `tsconfig.json` extends base + own paths.

### Root `package.json` scripts

```json
{
  "scripts": {
    "dev": "turbo run dev --filter=web",
    "dev:native": "turbo run dev --filter=native",
    "build:web": "turbo run build --filter=web",
    "build:native": "turbo run tauri:build --filter=native",
    "db:migrate": "turbo run db:migrate --filter=@nexux/db",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck"
  }
}
```

## Migration order (incremental, low-risk slices)

Each slice = one PR. App keeps running between slices.

1. **Workspace skeleton** — pnpm-workspace.yaml, turbo.json, tsconfig.base.json. No code moved. Verify `pnpm install` works.
2. **Move app → apps/web** — git mv all current `src/`, `prisma/`, `server/`, configs into `apps/web/`. Update paths. Verify `pnpm dev` runs.
3. **Extract `@nexux/db`** — move Prisma schema + client. Refactor `prisma.ts` to env-driven URL. Apps/web imports from `@nexux/db`.
4. **Extract `@nexux/config`** — runtime mode + env loader.
5. **Extract `@nexux/core`** — types + pure logic. No runtime change.
6. **Extract `@nexux/ui`** — shadcn components + hooks. Tailwind config shared.
7. **Extract `@nexux/storage`** — adapter pattern. Replace inline `fs` calls.
8. **Extract `@nexux/llm` + `@nexux/embeddings`** — provider abstractions.
9. **Extract `@nexux/terminal`** — node-pty WS server as standalone package.
10. **Create `apps/native`** — Tauri scaffold + sidecar wiring.
11. **Postgres compat** — schema audit + adapter switch. Docker Compose.
12. **Auth layer** — conditional NextAuth for server mode.

## Risks / open questions

- **Prisma generated client location**: currently `src/generated/prisma`. Moving to `packages/db/src/generated/` requires updating all imports (`@/generated/prisma/client` → `@nexux/db`).
- **`@/` path alias**: currently `@/* → ./src/*`. After move per-app, each app keeps its own `@/` scoped to itself. Cross-package imports use `@nexux/*`.
- **shadcn components.json**: needs reconfig to point at `packages/ui/`.
- **node-pty native module**: ensure rebuild works inside Tauri sidecar bundle.
- **Better-sqlite3 + Tauri sidecar**: native module — bundle prebuilt binaries per platform.
- **LanceDB**: native module same concern.
- **Next.js standalone build**: verify works with `serverExternalPackages: ['@lancedb/lancedb', 'ollama']`.

## Decisions needed

1. Turborepo vs Nx vs raw pnpm workspaces? → Turborepo recommended.
2. Single Prisma schema (multi-provider) vs two schemas (SQLite/Postgres)? → multi-provider with Prisma 7 driver adapters.
3. UI package — feature components stay in `apps/web` or move? → only design-system primitives + cross-app hooks move. Feature components stay in app.
4. Tauri sidecar = full Next.js or static export + Tauri commands? → Path B: full Next.js sidecar (less rewrite).
