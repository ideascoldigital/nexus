import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getGitLabBoard,
  syncGitLabBoard,
  syncGitLabEpicIssues,
  syncGitLabEpics,
  syncGitLabGroupIssues,
  syncGitLabIssues,
} from "@/services/gitlab";

const state = z.enum(["opened", "closed", "all"]).default("all");

// Three scopes, one endpoint, discriminated on `mode`. They pull from three
// different GitLab endpoints but land in the same cache, so the import dialog
// switches scope without switching route.
const syncSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("project"),
    // Numeric id, not the path: a project keeps its id across renames and
    // moves between groups, and the cache is keyed on it.
    projectId: z.number().int().positive(),
    projectPath: z.string().min(1),
    state,
  }),
  z.object({
    mode: z.literal("group"),
    groupId: z.number().int().positive(),
    groupPath: z.string().min(1),
    state,
  }),
  // Epics first, then the issues under the one being imported: the epic rows
  // carry the titles and descriptions that become phase names and goals.
  z.object({
    mode: z.literal("epics"),
    groupId: z.number().int().positive(),
    groupPath: z.string().min(1),
    state,
  }),
  z.object({
    mode: z.literal("epic-issues"),
    groupId: z.number().int().positive(),
    epicIid: z.number().int().positive(),
  }),
  // A board is addressed the way its URL addresses it — owner path plus board
  // id — because that is what the user pasted, and resolving it again here
  // keeps the client from having to hold GitLab's global ids.
  z.object({
    mode: z.literal("board"),
    ownerPath: z.string().min(1),
    owner: z.enum(["group", "project"]),
    boardId: z.number().int().positive(),
    milestoneTitle: z.string().nullable().default(null),
  }),
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;
  const body = await req.json();
  // A body with no `mode` is the pre-epics shape; treat it as a project sync so
  // an open dialog from before this shipped does not start failing mid-session.
  const parsed = syncSchema.safeParse(
    body && typeof body === "object" && !("mode" in body)
      ? { ...body, mode: "project" }
      : body,
  );
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const input = parsed.data;
    switch (input.mode) {
      case "project":
        return NextResponse.json(
          await syncGitLabIssues(
            accountId,
            input.projectId,
            input.projectPath,
            input.state,
          ),
        );
      case "group":
        return NextResponse.json(
          await syncGitLabGroupIssues(
            accountId,
            input.groupId,
            input.groupPath,
            input.state,
          ),
        );
      case "epics":
        return NextResponse.json(
          await syncGitLabEpics(
            accountId,
            input.groupId,
            input.groupPath,
            input.state,
          ),
        );
      case "epic-issues":
        return NextResponse.json(
          await syncGitLabEpicIssues(accountId, input.groupId, input.epicIid),
        );
      case "board": {
        const board = await getGitLabBoard(
          accountId,
          input.ownerPath,
          input.owner,
          input.boardId,
        );
        const result = await syncGitLabBoard(
          accountId,
          board,
          input.milestoneTitle,
        );
        // The columns ride along so the review tree can show where each issue
        // sat without a second round-trip.
        return NextResponse.json({ ...result, columns: board.columns });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
