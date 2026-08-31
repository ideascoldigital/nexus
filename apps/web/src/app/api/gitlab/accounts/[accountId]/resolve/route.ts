import { NextRequest, NextResponse } from "next/server";
import { getGitLabBoard, getGitLabProject } from "@/services/gitlab";
import { describeRef, parseGitLabUrl } from "@/lib/gitlab-url";

/**
 * Turn a pasted GitLab URL into something the import dialog can act on.
 *
 * Parsing is pure (`lib/gitlab-url`); this adds the two things only the
 * instance can answer — a board's name, milestone scope and columns, and
 * whether a bare `civo/dashboard` is a project or a subgroup.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  const parsed = parseGitLabUrl(url);
  if (!parsed) {
    return NextResponse.json(
      { error: "That does not look like a GitLab URL." },
      { status: 400 },
    );
  }

  try {
    const { ref } = parsed;

    if (ref.kind === "board") {
      const board = await getGitLabBoard(
        accountId,
        ref.ownerPath,
        ref.owner,
        ref.boardId,
      );
      return NextResponse.json({
        ref,
        origin: parsed.origin,
        label: describeRef(ref),
        board,
      });
    }

    // Only the instance can say whether a bare path is a project or a group.
    // Projects are asked first because the 404 is cheap and unambiguous.
    if (ref.kind === "ambiguous") {
      try {
        const project = await getGitLabProject(accountId, ref.path);
        return NextResponse.json({
          ref: { kind: "project", projectPath: project.path_with_namespace },
          origin: parsed.origin,
          label: `project ${project.path_with_namespace}`,
          project,
        });
      } catch {
        return NextResponse.json({
          ref: { kind: "group", groupPath: ref.path },
          origin: parsed.origin,
          label: `group ${ref.path}`,
        });
      }
    }

    return NextResponse.json({
      ref,
      origin: parsed.origin,
      label: describeRef(ref),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
