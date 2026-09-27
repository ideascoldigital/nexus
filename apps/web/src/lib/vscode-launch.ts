/**
 * Opening VS Code on a remote target from the server.
 *
 * Local-first: this server runs on the user's own machine, so it can launch
 * VS Code directly instead of handing a `vscode://` link to the browser, where
 * it depends on a protocol-handler prompt that is easy to miss or block. The
 * uri stays in every response as the client-side fallback.
 *
 * Shared by the sandbox and Nexus host routes — both open a remote window, and
 * the failure modes below are the same for either.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * The Dev Containers authority for attaching to a running container.
 *
 * On this machine's daemon it is the bare hex of the name, as before. On
 * another machine's (spec 26) it is the extension's JSON form, whose
 * `settings.host` it runs every docker command with as DOCKER_HOST — so
 * `ssh://omarchy` reaches the same daemon Nexux launched the sandbox on,
 * with nothing to set up in VS Code first.
 */
export function attachedContainerAuthority(
  container: string,
  dockerHost: string | null,
): string {
  const config = dockerHost
    ? JSON.stringify({ containerName: container, settings: { host: dockerHost } })
    : container;
  return `attached-container+${Buffer.from(config, "utf8").toString("hex")}`;
}

/**
 * Launch VS Code on `uri`. False = the caller should fall back to navigating
 * the browser to it.
 *
 * The `code` CLI with --folder-uri opens the remote window directly — no
 * browser protocol prompt, no "allow extension to open URI" modal. It exits 0
 * whenever it hands the uri to a VS Code window, including when the resolver
 * then fails and nothing opens; its exit code therefore only says the CLI ran,
 * never that a window appeared. `attachedContainer` skips it for the one case
 * where that silent failure is the norm.
 */
export async function launchVsCode(
  uri: string,
  attachedContainer = false,
): Promise<boolean> {
  // The Dev Containers extension resolves "attached-container+<hex>" against
  // its own local config, which only exists once VS Code has attached to a
  // container on this machine at least once before. Handed that uri cold,
  // --folder-uri exits 0 and opens nothing. The vscode:// deep link drives the
  // full attach flow (prompt included), so for containers go straight to the
  // OS opener.
  if (!attachedContainer) {
    // vscode://vscode-remote/ssh-remote+<host><path> → the CLI's uri scheme.
    const remoteUri = uri.replace(
      /^vscode:\/\/vscode-remote\//,
      "vscode-remote://",
    );
    // A multi-root workspace is a *file*, and --folder-uri asks VS Code to
    // resolve it as a directory: the remote window opens with nothing in the
    // explorer, while the CLI still exits 0. The bug only shows when the
    // workspace file was written successfully — the failure path falls back to
    // SANDBOX_ROOT, a real directory, which is why this looked like it worked.
    const flag = remoteUri.endsWith(".code-workspace")
      ? "--file-uri"
      : "--folder-uri";
    try {
      await execFileAsync("code", [flag, remoteUri], {
        timeout: 10_000,
      });
      return true;
    } catch {
      // code CLI not on PATH — try the OS url opener.
    }
  }
  // Known gap: the deep link has no file/folder distinction to set, so a
  // `.code-workspace` target reaching this path opens an empty window just as
  // --folder-uri did. Only installs without the `code` CLI get here.
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    await execFileAsync(opener, [uri], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
