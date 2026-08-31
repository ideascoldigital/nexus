import type {
  ActivityEntry,
  ActivitySandbox,
} from "@/app/api/activity/route";

export type { ActivityEntry, ActivitySandbox };

export type Activity = {
  active: ActivityEntry[];
  recent: ActivityEntry[];
  /** Every sandbox that is up, busy ones included. */
  sandboxesRunning: number;
  idleSandboxes: ActivitySandbox[];
};

export type ActivityCounts = {
  /** Machines that are up. */
  sandboxes: number;
  /** Runs actually executing right now. */
  running: number;
  /** Runs that are not moving: blocked on an answer, or queued for a slot. */
  waiting: number;
  /** Of `waiting`, the ones a person has to unblock. */
  blocked: number;
};

/**
 * The header's three numbers.
 *
 * "Waiting" deliberately merges two different stalls — a run blocked on a
 * question and a run queued behind another — because from across the room they
 * mean the same thing: nothing is happening and something could. They are told
 * apart in the tooltip, and only the blocked half is worth colouring, since
 * that is the half a person can do something about.
 */
export function activityCounts(activity: Activity | undefined): ActivityCounts {
  const active = activity?.active ?? [];
  const blocked = active.filter((t) => t.needsInput);
  const queued = active.filter((t) => !t.needsInput && t.status === "queued");
  return {
    sandboxes: activity?.sandboxesRunning ?? 0,
    running: active.filter((t) => !t.needsInput && t.status === "running")
      .length,
    waiting: blocked.length + queued.length,
    blocked: blocked.length,
  };
}

export async function getActivity(): Promise<Activity> {
  const res = await fetch("/api/activity");
  if (!res.ok) throw new Error("Failed to fetch activity");
  return res.json();
}

/**
 * Where opening an entry should land — and what should already be open when it
 * gets there.
 *
 * Landing on the right tab is not the same as arriving at the thing: a project
 * with six sandboxes still leaves you scanning for the one that was waiting.
 * `sandbox` names the row to scroll to and highlight, `dev=1` opens its console
 * so a blocked prompt is answerable in one keystroke rather than three clicks.
 *
 * Feature runs go to the board instead, which is where their card lives — the
 * same split the dashboard's activity list already uses.
 */
export function activityHref(
  entry: ActivityEntry | ActivitySandbox,
): string {
  if (entry.kind === "sandbox") {
    return `/projects/${entry.projectId}?tab=sandboxes&sandbox=${entry.id}`;
  }
  if (entry.taskKind === "dev") {
    return `/projects/${entry.projectId}?tab=sandboxes&sandbox=${entry.sandboxId}&dev=1`;
  }
  return `/projects/${entry.projectId}?tab=features&sandbox=${entry.sandboxId}`;
}

const SEEN_KEY = "nexux:activity-seen";

/**
 * When the switcher was last opened, as an ISO string.
 *
 * Kept in localStorage rather than on the row: "seen" is a property of a person
 * looking at a screen, not of the run, and this app has one user per install.
 * A column would also need a migration to answer a question the browser can
 * answer for free.
 */
export function lastSeenAt(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    // Private mode / storage disabled: everything reads as seen, which is the
    // harmless direction — a missed badge beats a crashed shell.
    return null;
  }
}

export function markSeen(at: Date = new Date()): void {
  try {
    window.localStorage.setItem(SEEN_KEY, at.toISOString());
  } catch {
    // As above.
  }
}

/**
 * What the header bell should show, and how many.
 *
 * The two halves are not the same kind of thing, and treating them alike is
 * the easy mistake: a finished run is an *event* — once you have seen it, it
 * stops counting. A run blocked on a question is a *standing state* — glancing
 * at the panel does not answer it, so it keeps counting until it is dealt with.
 * A badge that cleared both on sight would quietly drop the only item that
 * actually needed you.
 */
export function notifications(
  activity: Activity | undefined,
  seen: string | null,
): {
  blocked: ActivityEntry[];
  /** Recent finishes, seen or not — the panel's history. */
  finished: ActivityEntry[];
  /** Which of those are new, for the unread mark. */
  unseenIds: Set<string>;
  count: number;
} {
  const blocked = (activity?.active ?? []).filter((t) => t.needsInput);
  const finished = (activity?.recent ?? []).filter((t) => t.finishedAt !== null);
  const unseen = unseenSince(finished, seen);
  return {
    blocked,
    // Everything recent, not just the unread: a panel that empties itself after
    // one look is a panel you cannot go back to. Reading clears the *badge*;
    // the list is history and stays.
    finished,
    unseenIds: new Set(unseen.map((t) => t.id)),
    count: blocked.length + unseen.length,
  };
}

/**
 * Runs that finished since the last poll and have not been announced yet.
 *
 * `announced` is the set of ids already popped up, and it is also what makes
 * the first poll silent: a page that has just loaded knows nothing about what
 * happened before it existed, and greeting the user with a chime per historical
 * run would train them to ignore the thing immediately. The caller seeds the
 * set from the first response and only then starts announcing.
 */
export function newlyFinished(
  recent: ActivityEntry[],
  announced: ReadonlySet<string>,
): ActivityEntry[] {
  return recent.filter((t) => t.finishedAt !== null && !announced.has(t.id));
}

/** Finished since the switcher was last opened. */
export function unseenSince(
  recent: ActivityEntry[],
  seen: string | null,
): ActivityEntry[] {
  // No mark yet means a first run, not "everything is new" — opening the
  // switcher to a wall of old runs is noise, so nothing counts until the first
  // mark exists.
  if (!seen) return [];
  return recent.filter((t) => t.finishedAt !== null && t.finishedAt > seen);
}
