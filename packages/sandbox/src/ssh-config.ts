import fs from "fs";
import path from "path";
import { homeDir } from "@nexux/config";
import { sandboxKeyDir, sandboxPrivateKeyPath } from "./keys";

// VS Code Remote-SSH resolves hosts through ~/.ssh/config. Nexux keeps its
// sandbox hosts in a managed file (<dataDir>/ssh/config) and injects a single
// Include line into the user's config, so sandbox entries come and go without
// ever rewriting anything the user wrote by hand.

export function sandboxSshConfigPath(dataDir: string): string {
  return path.join(sandboxKeyDir(dataDir), "config");
}

/** The Host alias VS Code / ssh use for a sandbox. Instance names are already
 *  DNS-safe slugs (nexux-<project>-<id>), so they double as the alias. */
export function sandboxSshHostAlias(sandboxName: string): string {
  return sandboxName;
}

function beginMarker(alias: string): string {
  return `# >>> nexux sandbox ${alias} >>>`;
}

function endMarker(alias: string): string {
  return `# <<< nexux sandbox ${alias} <<<`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Drop the marker-delimited block for `alias` from `content`, if present. */
function stripBlock(content: string, alias: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(beginMarker(alias))}[\\s\\S]*?${escapeRegExp(endMarker(alias))}\\n?`,
    "g",
  );
  return content.replace(pattern, "");
}

export interface SandboxSshHostOpts {
  dataDir: string;
  /** Sandbox instance name — becomes the Host alias. */
  name: string;
  /** Public IP (or hostname) of the instance. */
  host: string;
  /** Remote user to log in as. */
  user: string;
}

/**
 * Add or refresh the Host entry for a sandbox in Nexux's managed SSH config.
 * Idempotent: re-running with a new IP replaces the previous block.
 * Returns the Host alias to use with ssh / VS Code Remote-SSH.
 */
export function upsertSandboxSshHost(opts: SandboxSshHostOpts): string {
  const alias = sandboxSshHostAlias(opts.name);
  const configPath = sandboxSshConfigPath(opts.dataDir);
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // accept-new + a private known_hosts file: first connect records the host
  // key without an interactive prompt (fresh VMs are never in known_hosts),
  // and the user's own known_hosts stays untouched.
  const block = [
    beginMarker(alias),
    `Host ${alias}`,
    `  HostName ${opts.host}`,
    `  User ${opts.user}`,
    `  IdentityFile ${sandboxPrivateKeyPath(opts.dataDir)}`,
    `  IdentitiesOnly yes`,
    `  StrictHostKeyChecking accept-new`,
    `  UserKnownHostsFile ${path.join(dir, "known_hosts")}`,
    endMarker(alias),
    "",
  ].join("\n");

  const existing = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";
  const next = stripBlock(existing, alias) + block;
  fs.writeFileSync(configPath, next, { mode: 0o600 });
  return alias;
}

/** Remove a sandbox's Host entry from the managed config (e.g. on destroy). */
export function removeSandboxSshHost(dataDir: string, name: string): void {
  const configPath = sandboxSshConfigPath(dataDir);
  if (!fs.existsSync(configPath)) return;
  const existing = fs.readFileSync(configPath, "utf8");
  const next = stripBlock(existing, sandboxSshHostAlias(name));
  if (next !== existing) fs.writeFileSync(configPath, next, { mode: 0o600 });
}

/**
 * Make sure ~/.ssh/config includes Nexux's managed config so ssh and VS Code
 * can resolve sandbox aliases. The Include goes at the very top: OpenSSH only
 * applies an Include unconditionally when it appears before any Host block.
 */
export function ensureUserSshInclude(dataDir: string): void {
  const sshDir = path.join(homeDir(), ".ssh");
  const userConfig = path.join(sshDir, "config");
  const includeLine = `Include ${sandboxSshConfigPath(dataDir)}`;

  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(userConfig)
    ? fs.readFileSync(userConfig, "utf8")
    : "";
  if (existing.split("\n").some((line) => line.trim() === includeLine)) return;

  const header = "# Nexux sandboxes (VS Code Remote-SSH)";
  const next = `${header}\n${includeLine}\n\n${existing}`;
  fs.writeFileSync(userConfig, next, { mode: 0o600 });
}

/**
 * Deep link that opens VS Code connected to the sandbox over Remote-SSH,
 * with `folder` opened as the workspace root. A path ending in
 * `.code-workspace` opens as a multi-root workspace instead of a folder —
 * VS Code decides from the extension, the uri shape is identical.
 */
export function vsCodeRemoteUri(alias: string, folder: string): string {
  const normalized = folder.startsWith("/") ? folder : `/${folder}`;
  return `vscode://vscode-remote/ssh-remote+${alias}${encodeURI(normalized)}`;
}
