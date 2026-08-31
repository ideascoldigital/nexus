/**
 * Repo/instance names → a DNS- and path-safe directory name. Lives in its own
 * module so both `template.ts` and `workspace.ts` can use it without an import
 * cycle (template renders the workspace file, workspace slugs repo names).
 */
export function safeSlug(name: string): string {
  return slugChars(name).replace(/^[-.]+|[-.]+$/g, "") || "repo";
}

/**
 * The character-level half of `safeSlug`, without its `"repo"` fallback.
 *
 * That fallback is right for a directory that must exist under *some* name and
 * wrong everywhere a caller needs to tell "the user typed nothing usable" apart
 * from "the user typed the word repo" — which is exactly what the name and
 * prefix validators below have to answer.
 */
function slugChars(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

/** Hostnames may not open or close on a separator; docker names may not either. */
function trimToAlnum(slug: string): string {
  return slug.replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
}

/**
 * Longest hostname the kernel accepts. `sethostname(2)` rejects anything past
 * `HOST_NAME_MAX` (64) with EINVAL, and a DNS label caps at 63 — so 63 is the
 * number that satisfies both.
 */
export const MAX_HOSTNAME_LENGTH = 63;

/**
 * What generated names are prefixed with when the workspace has not said
 * otherwise. Only a default: the prefix is a setting, so a machine can be
 * called `dev-…` on one install and `nexux-…` on the next.
 */
export const DEFAULT_SANDBOX_PREFIX = "nexux-";

/**
 * Ceiling for a configured prefix. It spends the same 63 characters the
 * project slug and the id suffix need, so a prefix long enough to starve them
 * is refused at the settings form rather than producing names that are all
 * prefix and no project.
 */
export const MAX_SANDBOX_PREFIX_LENGTH = 24;

/** Why a chosen prefix cannot be used. */
export type SandboxPrefixError = "invalid" | "too-long";

/**
 * Normalize a prefix the user typed into the form generated names use, or say
 * why not. The trailing `-` is ours to add: users type `dev`, `dev-` and
 * `Dev ` meaning the same thing, and only one of those is a legal hostname
 * fragment.
 */
export function normalizeSandboxPrefix(
  input: string,
): { prefix: string } | { error: SandboxPrefixError } {
  const slug = trimToAlnum(slugChars(input.trim()));
  if (!slug) return { error: "invalid" };
  const prefix = `${slug}-`;
  if (prefix.length > MAX_SANDBOX_PREFIX_LENGTH) return { error: "too-long" };
  return { prefix };
}

/**
 * Container/instance name for a sandbox: `<prefix><project>-<id>`, bounded so
 * it is always a legal hostname.
 *
 * Docker passes `--hostname` straight through to `sethostname(2)`, so an
 * over-long name does not fail at validation — it fails deep inside container
 * init as `OCI runtime create failed: … sethostname: invalid argument`, which
 * names neither the limit nor the value that broke it. Projects are commonly
 * named by their full path (`\\wsl.localhost\Ubuntu-26.04\home\me\work\app`),
 * which blows past 63 on its own.
 *
 * The slug is trimmed from the **left**: the tail of a path is what identifies
 * the project, while the head is the share, distro and home directory that
 * every project on the machine shares.
 */
export function sandboxInstanceName(
  projectName: string,
  id: string,
  prefix: string = DEFAULT_SANDBOX_PREFIX,
): string {
  const suffix = id.replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase();
  // A configured prefix eats into the same 63 characters; `normalizeSandboxPrefix`
  // caps it, but this must still hold for a value that reached us some other way.
  const budget = Math.max(
    1,
    MAX_HOSTNAME_LENGTH - prefix.length - 1 - suffix.length,
  );

  const slug = safeSlug(projectName);
  let trimmed = slug.length > budget ? slug.slice(slug.length - budget) : slug;

  // Cutting at a fixed offset lands mid-word ("…developer/work…" → "o-work…").
  // Drop that partial leading segment when a whole one is left behind, so the
  // name reads as path segments rather than debris.
  if (trimmed.length < slug.length) {
    const sep = trimmed.indexOf("-");
    if (sep > 0 && trimmed.length - sep - 1 >= Math.floor(budget / 2)) {
      trimmed = trimmed.slice(sep + 1);
    }
  }

  // Truncation can still expose a separator at either end, and a hostname may
  // not start or end with one.
  const clean = trimmed.replace(/^[-.]+/, "").replace(/[-.]+$/, "");

  const name = `${prefix}${clean || "project"}-${suffix}`;
  // Only reachable via an over-long prefix that skipped normalization; cutting
  // is still better than handing docker a name it fails on deep in init.
  return name.length <= MAX_HOSTNAME_LENGTH
    ? name
    : trimToAlnum(name.slice(0, MAX_HOSTNAME_LENGTH));
}

/** Why a chosen sandbox name cannot be used, in words a user can act on. */
export type SandboxNameError = "empty" | "too-long";

/**
 * Normalize a name the user typed into a legal instance name, or say why not.
 *
 * The generated form ends in six characters of the sandbox id, which is what
 * makes it unique without anyone checking. A chosen name has no such tail, so
 * uniqueness stops being a property of the string and becomes a question about
 * the world — see `assertSandboxNameFree`. This function only answers the part
 * that is decidable from the input alone.
 *
 * A chosen name replaces the whole hostname, prefix included — nothing keys off
 * `nexux-`: local containers are found by the `nexux-sandbox=1` label, ssh
 * entries are delimited by their own markers around the full name, and the
 * reconciler reads rows by provider and status. Reserving the head of the name
 * would only stop a user from calling their machine what they call it.
 */
export function customSandboxName(
  input: string,
): { name: string } | { error: SandboxNameError } {
  const name = trimToAlnum(slugChars(input.trim()));
  if (!name) return { error: "empty" };
  if (name.length > MAX_HOSTNAME_LENGTH) return { error: "too-long" };
  return { name };
}

/** The longest name a user may type — the whole hostname is theirs now. */
export const MAX_CUSTOM_NAME_LENGTH = MAX_HOSTNAME_LENGTH;

/**
 * Escape a value for safe inclusion inside single quotes in bash.
 *
 * Lives here rather than in `template.ts` because both the sandbox and the
 * Nexus host bootstrap interpolate user-supplied values (instance names, image
 * references, auth keys) into generated shell. One implementation, so a fix
 * cannot land on only one of them.
 */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
