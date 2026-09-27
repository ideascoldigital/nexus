/**
 * Which release channel a Nexus host follows — the tag on its image.
 *
 * release-image.yml publishes two moving tags: `edge` on every push to main,
 * and `latest` on release tags only (docs/DEPLOYMENT.md). A host picks one by
 * its image reference; switching is re-pointing that tag and updating, which
 * re-renders the compose file with it. Any other tag (a pinned `0.3.0`, a
 * `main-<sha>`) is a custom choice this does not second-guess.
 */

export type HostChannel = "edge" | "latest";

export const HOST_CHANNELS: ReadonlyArray<{ value: HostChannel; label: string; detail: string }> = [
  { value: "latest", label: "Stable", detail: "release tags only" },
  { value: "edge", label: "Edge", detail: "every merge to main" },
];

/** Split `registry/owner/repo:tag@digest` into repository and tag (null when none). */
function splitRef(imageRef: string): { repo: string; tag: string | null } {
  const ref = imageRef.trim().replace(/@sha256:[a-f0-9]+$/i, "");
  // A colon after the last slash is a tag; one before it is a registry port.
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return colon > slash ? { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) } : { repo: ref, tag: null };
}

/** The channel an image follows, or null for a pinned/custom tag. No tag means latest. */
export function channelOf(imageRef: string): HostChannel | null {
  const { tag } = splitRef(imageRef);
  if (tag === null || tag === "latest") return "latest";
  return tag === "edge" ? "edge" : null;
}

/** The same image on another channel (a digest pin is dropped: it is not a channel). */
export function withChannel(imageRef: string, channel: HostChannel): string {
  return `${splitRef(imageRef).repo}:${channel}`;
}

/**
 * Shell that repoints a VM host's docker-compose.yml from one app image to
 * another, then runs `then`; if `then` fails, the file is put back. Exact-line
 * match on the image being replaced, so an image line the user edited by hand
 * is left alone and the switch fails instead of guessing. `quote` is the
 * caller's shell quoting (shq), injected to keep this module dependency-free.
 */
export function composeImageSwapScript(
  from: string,
  to: string,
  then: string,
  quote: (s: string) => string,
  file = "docker-compose.yml",
): string {
  // awk rather than sed: the refs are compared as plain strings, so nothing
  // in them ('.', '/', ':', '@') needs regex escaping.
  const swap = (a: string, b: string) =>
    `awk -v a=${quote(`image: ${a}`)} -v b=${quote(`image: ${b}`)} ` +
    `'{ l=$0; sub(/^ */, "", l); if (l == a) { match($0, /^ */); print substr($0, 1, RLENGTH) b } else print }' ` +
    `${file} > ${file}.nexux-tmp && mv ${file}.nexux-tmp ${file}`;
  return (
    `grep -qxE ${quote(" *")}${quote(`image: ${from}`.replace(/[.[\]*^$\\+?(){}|/]/g, "\\$&"))} ${file} ` +
    `&& ${swap(from, to)} && { ${then} || { ${swap(to, from)}; false; }; }`
  );
}
