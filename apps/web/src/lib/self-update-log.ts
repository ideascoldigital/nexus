/**
 * Reading the on-host updater's log (`update.sh` in `@nexux/sandbox`
 * template-host) from the browser's side of the fence.
 *
 * The self-update path deliberately reports nothing at request time — the app
 * is the thing being restarted — so "did it finish, and did it work" can only
 * be read back out of the log the updater appends to. These helpers are what
 * the Settings card polls with: completion is a *new* "finished" stamp, not
 * the presence of one, since every past update left its own.
 */

/** The last `[nexus-update] finished <ts>` line, or null if none ever ran. */
export function lastUpdateFinished(log: string | null): string | null {
  if (!log) return null;
  const matches = log.match(/^\[nexus-update\] finished .+$/gm);
  return matches ? matches[matches.length - 1] : null;
}

/** The output of the most recent run — everything after its "started" line. */
export function lastUpdateRun(log: string | null): string {
  if (!log) return "";
  const i = log.lastIndexOf("[nexus-update] started");
  return i === -1 ? log : log.slice(i);
}

/** Whether the most recent run in the log reported a failure. */
export function lastUpdateFailed(log: string | null): boolean {
  return /\[nexus-update\] FAILED/.test(lastUpdateRun(log));
}
