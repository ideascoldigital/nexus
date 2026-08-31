import { NextRequest, NextResponse } from "next/server";
import { getLocalGitLabIssues, type IssueScope } from "@/services/gitlab";
import { mapColumnToStatus } from "@/services/github-projects";

/** The scope named by the query string, or null when none was given. */
function scopeOf(params: URLSearchParams): IssueScope | null {
  const groupPath = params.get("groupPath");
  if (groupPath) return { kind: "group", groupPath };

  // A project-owned board is scoped by exact path; a project picked from the
  // combobox is scoped by its numeric id. Both reach the same rows.
  const projectPath = params.get("projectPath");
  if (projectPath) return { kind: "projectPath", projectPath };

  if (params.has("epicId")) {
    const epicId = Number(params.get("epicId"));
    return Number.isInteger(epicId) && epicId > 0
      ? { kind: "epic", epicId }
      : null;
  }

  if (params.has("projectId")) {
    const projectId = Number(params.get("projectId"));
    return Number.isInteger(projectId) && projectId > 0
      ? { kind: "project", projectId }
      : null;
  }
  return null;
}

/**
 * Cached issues, scoped by project, group path, exact project path or epic —
 * and optionally narrowed to one milestone, which is all a board's slice is.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const accountId = searchParams.get("accountId");
    if (!accountId) {
      return NextResponse.json(
        { error: "accountId is required" },
        { status: 400 },
      );
    }

    const scope = scopeOf(searchParams);
    if (!scope) {
      return NextResponse.json(
        {
          error:
            "Scope the read with projectId, groupPath, projectPath or epicId",
        },
        { status: 400 },
      );
    }

    const state = searchParams.get("state") ?? "opened";
    const issues = await getLocalGitLabIssues(accountId, scope, {
      // "all" means no state filter — passed through it would match nothing,
      // since rows only ever hold "opened" or "closed".
      state: state === "all" ? undefined : state,
      search: searchParams.get("search") ?? undefined,
      milestone: searchParams.get("milestone") ?? undefined,
    });

    // The kanban column each issue should land in, decided here rather than in
    // the dialog: `mapColumnToStatus` lives beside a Prisma-importing module,
    // and the GitHub board dialog already pays for keeping its own copy (D-51).
    return NextResponse.json(
      issues.map((issue) => ({
        ...issue,
        suggestedStatus: issue.boardStatus
          ? mapColumnToStatus(issue.boardStatus)
          : issue.state === "opened"
            ? "backlog"
            : "done",
      })),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
