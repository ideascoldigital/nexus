import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSlackChannel, getBotToken, listSlackChannels } from "@/lib/slack";

export const dynamic = "force-dynamic";

/** Channels the bot can see — what the pickers offer instead of raw IDs. */
export async function GET() {
  if (!(await getBotToken())) {
    return NextResponse.json(
      { error: "Slack is not configured", channels: [] },
      { status: 400 },
    );
  }
  const channels = await listSlackChannels();
  return NextResponse.json({ channels });
}

const createSchema = z.object({ name: z.string().trim().min(1).max(80) });

/** Create a public channel (the bot joins it as creator). */
export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  try {
    const channel = await createSlackChannel(parsed.data.name);
    return NextResponse.json({ channel }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not create channel" },
      { status: 409 },
    );
  }
}
