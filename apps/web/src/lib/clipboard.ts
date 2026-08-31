/**
 * Copy text that also works outside secure contexts.
 *
 * `navigator.clipboard` only exists on https or localhost; a Nexus host is
 * reached over plain http on a tailnet IP, where reading `.writeText` off
 * `undefined` threw and broke every copy button. The fallback drives the
 * legacy execCommand path through an off-screen textarea.
 *
 * The async path is also tried-and-fallen-back-from rather than trusted: a
 * copy that awaits a network round-trip first has lost its user gesture by the
 * time it runs, and the browser answers `writeText` with a NotAllowedError
 * ("Document is not focused") whenever focus moved in the meantime. The
 * textarea path has no such requirement.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to the legacy path
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy is not available in this browser");
    }
  } finally {
    ta.remove();
  }
}
