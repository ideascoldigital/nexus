/**
 * The decisions the GitLab import dialog makes about what to show and what is
 * selectable, pulled out of the component so they can be tested.
 *
 * Not an abstraction for its own sake: the gate below shipped broken. It
 * ignored a resolved URL, so with the scope still on its default a pasted board
 * rendered "Pick a project to load its issues." where its 48 issues should have
 * been — and the whole review tree, checkboxes included, never appeared. The
 * API had been driven end to end; nobody had looked at the dialog. Logic that
 * decides whether a list renders belongs where a test can reach it.
 *
 * Prisma-free, fetch-free, React-free.
 */

/** A review row, reduced to what these decisions actually read. */
export interface ReviewRow {
  included: boolean;
  state: string;
  projectPath: string;
  /** The board column this issue sat in, when it came from a board. */
  boardStatus: string | null;
}

export interface PromptInput {
  accountId: string;
  /** True once a pasted URL resolved — it answers what the pickers ask. */
  hasResolvedUrl: boolean;
  scope: "project" | "group" | "epic";
  hasProject: boolean;
  hasGroup: boolean;
  hasEpic: boolean;
}

/**
 * What to tell the user instead of a review tree, or null to show the tree.
 *
 * `hasResolvedUrl` short-circuits everything below it: a URL names the scope
 * *and* the selection, so asking for a picker on top of it is asking twice.
 */
export function importPrompt(input: PromptInput): string | null {
  if (!input.accountId) return null;
  if (input.hasResolvedUrl) return null;
  if (input.scope === "project" && !input.hasProject) {
    return "Pick a project to load its issues.";
  }
  if (input.scope === "group" && !input.hasGroup) {
    return "Pick a group — its subgroups come with it.";
  }
  if (input.scope === "epic" && !input.hasGroup) {
    return "Pick the group whose epics you want.";
  }
  if (input.scope === "epic" && !input.hasEpic) {
    return "Pick an epic, or sync this group to fill the list.";
  }
  return null;
}

export interface SelectionGroup {
  label: string;
  /** Indices into the review list, so a toggle can flip them all at once. */
  indices: number[];
  chosen: number;
}

/**
 * Bulk-selection groups, in the order the source presents them.
 *
 * Board columns when the rows came from a board — forty-eight issues over eight
 * columns is not a list anyone ticks by hand, and "everything not Done yet" is
 * how people describe what they want. Open/closed otherwise, which is the only
 * grouping a plain project or group listing has.
 */
export function selectionGroupsOf(
  review: ReviewRow[],
  columnOrder: string[] = [],
): SelectionGroup[] {
  if (!review.length) return [];
  const hasColumns = review.some((r) => r.boardStatus);
  const groups = new Map<string, number[]>();

  review.forEach((row, i) => {
    const label = hasColumns
      ? (row.boardStatus ?? "No column")
      : row.state === "opened"
        ? "Open"
        : "Closed";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(i);
  });

  return [...groups.entries()]
    .map(([label, indices]) => ({
      label,
      indices,
      chosen: indices.filter((i) => review[i].included).length,
    }))
    .sort((a, b) => {
      // Board order first, so the chips read left to right like the board.
      // Anything the board did not name (an issue with no column) sorts after.
      const ai = columnOrder.indexOf(a.label);
      const bi = columnOrder.indexOf(b.label);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.label.localeCompare(b.label);
    });
}

/**
 * Whether the project name earns its space on each row.
 *
 * It is what tells two issues both numbered "#12" apart, which only happens
 * once the rows span repositories — a board or a group, never one project.
 */
export function shouldShowProjectPath(review: ReviewRow[]): boolean {
  return new Set(review.map((r) => r.projectPath)).size > 1;
}
