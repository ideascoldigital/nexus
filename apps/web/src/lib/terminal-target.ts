/**
 * The terminal server's `cwd` for a local sandbox's container:
 * `docker://[<endpointId>@]<container><path>`.
 *
 * A container on another machine's Docker (spec 26) carries its endpoint's
 * id, which the terminal server resolves to a host itself — the browser never
 * sends one. Shared by every place that opens a sandbox terminal, so the
 * sandbox row and the terminal picker cannot disagree about the format.
 */
export function dockerTerminalTarget(
  sandbox: { instanceId: string | null; dockerEndpointId: string | null },
  path: string,
): string | null {
  if (!sandbox.instanceId) return null;
  const endpoint = sandbox.dockerEndpointId ? `${sandbox.dockerEndpointId}@` : "";
  return `docker://${endpoint}${sandbox.instanceId}${path}`;
}

/**
 * The authority a restored tab's cwd points at — a cloud host or a container
 * name — for pruning tabs whose sandbox is gone. Tolerates the endpoint prefix.
 */
export function terminalTargetAuthority(cwd: string): string | null {
  const m = cwd.match(/^(?:ssh:\/\/[^@]+@|docker:\/\/(?:[a-z0-9]+@)?)([^/]+)/i);
  return m ? m[1] : null;
}
