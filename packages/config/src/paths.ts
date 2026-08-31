import os from "os";

/**
 * The current user's home directory, resolved at RUNTIME.
 *
 * Why not call `os.homedir()` directly at the use site: Next.js' output-file
 * tracer (`@vercel/nft`) statically evaluates `os.homedir()` to a concrete path
 * at build time. When that path is then used as the base of a dynamic lookup
 * (e.g. `path.join(os.homedir(), ".claude", "skills", name)` or reading under
 * `~/.ssh`), nft turns the dynamic segment into a `**` glob and walks the whole
 * home tree looking for assets to bundle. On Windows that walk hits protected
 * dirs such as `~/.ssh/1Password` and dies with `EPERM: scandir`, failing the
 * native build. See fix/native-windows-sidecar-logging.
 *
 * Routing through `process.env.HOME` first makes the value un-foldable for nft
 * (it treats `process.env.HOME` as unknown), so no build-time glob is emitted,
 * while runtime behaviour is unchanged — `os.homedir()` still resolves the real
 * home on every platform. Always use this instead of a bare `os.homedir()` for
 * paths that get bundled into the server.
 */
export function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}
