/**
 * Reading a pasted GitLab URL.
 *
 * People navigate to the slice of work they mean — a board filtered by
 * milestone, an epic, a group's issue list — and the address bar already says
 * exactly what it is. Asking them to translate that back into a scope, a group
 * and a filter is asking them to re-derive something they are looking at.
 *
 * Prisma-free and free of `fetch`, so the parsing is a pure function the tests
 * can drive without a database or a GitLab.
 */

/** What a pasted GitLab URL points at. */
export type GitLabRef =
  | {
      kind: "board";
      /** Group or project path the board belongs to. */
      ownerPath: string;
      owner: "group" | "project";
      boardId: number;
      /** From `?milestone_title=`; boards are often scoped to one. */
      milestoneTitle: string | null;
    }
  | { kind: "epic"; groupPath: string; epicIid: number }
  | { kind: "milestone"; ownerPath: string; owner: "group" | "project"; milestoneTitle: string }
  | { kind: "group"; groupPath: string }
  | { kind: "project"; projectPath: string }
  /** A bare path — `civo/dashboard` is a group or a project, and only the
   *  instance can say which. The caller resolves it. */
  | { kind: "ambiguous"; path: string };

export interface ParsedGitLabUrl {
  /** Origin of the instance the URL points at, for matching against a server. */
  origin: string;
  ref: GitLabRef;
}

/**
 * Split a GitLab path at the `/-/` marker.
 *
 * GitLab inserts it precisely so a namespace of any depth can be told from the
 * resource under it: `civo/dashboard/volumes/-/issues/20` is unambiguous where
 * `civo/dashboard/volumes/issues/20` would not be.
 */
function splitAtMarker(pathname: string): { ownerPath: string; rest: string[] } {
  const clean = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const at = clean.indexOf("/-/");
  if (at === -1) return { ownerPath: clean, rest: [] };
  return {
    ownerPath: clean.slice(0, at),
    rest: clean.slice(at + 3).split("/").filter(Boolean),
  };
}

/**
 * Parse a GitLab URL, or null when it is not one we can act on.
 *
 * Deliberately tolerant about the instance: any host can serve GitLab, so the
 * shape of the path is the only signal, and matching the origin against a
 * registered server is the caller's job.
 */
export function parseGitLabUrl(input: string): ParsedGitLabUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!url.hostname) return null;

  const { ownerPath: raw, rest } = splitAtMarker(url.pathname);
  if (!raw) return null;

  // `/groups/<path>` is how GitLab addresses a group's own pages; a project
  // path has no such prefix.
  const isGroup = raw.startsWith("groups/");
  const ownerPath = isGroup ? raw.slice("groups/".length) : raw;
  if (!ownerPath) return null;

  const milestoneTitle = url.searchParams.get("milestone_title");
  const origin = url.origin;
  const owner = isGroup ? ("group" as const) : ("project" as const);

  const [resource, id] = rest;

  if (resource === "boards") {
    // A board with no id in the path is the group's default board, which the
    // API cannot address — treat it as the owner instead of guessing an id.
    const boardId = Number(id);
    if (Number.isInteger(boardId) && boardId > 0) {
      return {
        origin,
        ref: { kind: "board", ownerPath, owner, boardId, milestoneTitle },
      };
    }
  }

  if (resource === "epics") {
    const epicIid = Number(id);
    if (isGroup && Number.isInteger(epicIid) && epicIid > 0) {
      return { origin, ref: { kind: "epic", groupPath: ownerPath, epicIid } };
    }
  }

  // An issue list carrying a milestone filter is the same slice a
  // milestone-scoped board shows, minus the columns.
  if (resource === "issues" && milestoneTitle) {
    return {
      origin,
      ref: { kind: "milestone", ownerPath, owner, milestoneTitle },
    };
  }

  if (isGroup) return { origin, ref: { kind: "group", groupPath: ownerPath } };

  // Without the `/groups/` prefix a single segment is a user or group; two or
  // more is *probably* a project, but `civo/dashboard` is a real subgroup on a
  // real instance — so anything short of certain is handed back as ambiguous.
  if (rest.length > 0 && ownerPath.includes("/")) {
    return { origin, ref: { kind: "project", projectPath: ownerPath } };
  }
  return { origin, ref: { kind: "ambiguous", path: ownerPath } };
}

/** A short human label for what a URL resolved to, for the dialog to echo. */
export function describeRef(ref: GitLabRef): string {
  switch (ref.kind) {
    case "board":
      return ref.milestoneTitle
        ? `board #${ref.boardId} in ${ref.ownerPath}, milestone "${ref.milestoneTitle}"`
        : `board #${ref.boardId} in ${ref.ownerPath}`;
    case "epic":
      return `epic &${ref.epicIid} in ${ref.groupPath}`;
    case "milestone":
      return `milestone "${ref.milestoneTitle}" in ${ref.ownerPath}`;
    case "group":
      return `group ${ref.groupPath}`;
    case "project":
      return `project ${ref.projectPath}`;
    case "ambiguous":
      return ref.path;
  }
}
