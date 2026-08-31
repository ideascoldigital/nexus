# Spec: Project distribution with Bun

## Original query

Is it possible to compile the whole project with Bun to make it easily distributable?

## Short answer

Partially. Bun can bundle Next.js, but it does not produce a working single binary for full Next apps.

## Options evaluated

### 1. `bun build` standalone
Fails for Next.js. Next needs its own runtime (SSR, RSC, middleware, image optimization). Bun does not replace `next start`.

### 2. `next build` + `bun` runtime
Viable. Build with normal Next, run with `bun run start`.
- Distributing = `.next/` folder + `node_modules` + `bun`.
- Not single-file.

### 3. Next standalone output (recommended for distribution)
In `next.config.ts`:

```ts
module.exports = { output: 'standalone' }
```

- Generates `.next/standalone/` with `server.js` + minimal deps.
- Run with `bun .next/standalone/server.js`.
- Small size, portable.

### 4. Real single binary
- Tauri/Electron wrapping Next, or
- Migrate to Hono/Elysia + static frontend, which does compile with `bun build --compile`.

## Recommendation for Nexux (local-first, CLI-driven)

Option 3 (`output: 'standalone'`) + install script.
Alternative: Tauri if a native desktop app is required.

## Pending

- Decide the path: standalone vs Tauri.
- Test `bun .next/standalone/server.js` with the current stack (Prisma, terminal, MCP).
- Verify native binaries (Prisma engine) in distribution.
