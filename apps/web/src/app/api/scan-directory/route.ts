import { NextRequest, NextResponse } from "next/server";

import { scanDirectory } from "@/lib/repo-scan";

export async function POST(req: NextRequest) {
  const { directory } = (await req.json()) as { directory: string };

  if (!directory) {
    return NextResponse.json(
      { error: "Directory path is required" },
      { status: 400 },
    );
  }

  const result = await scanDirectory(directory);
  if (!result) {
    return NextResponse.json(
      { error: "Path is not a valid directory" },
      { status: 400 },
    );
  }
  return NextResponse.json(result);
}
