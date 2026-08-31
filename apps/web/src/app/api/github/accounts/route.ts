import { NextRequest, NextResponse } from "next/server";
import { addGitHubAccount, listGitHubAccounts } from "@/services/github";
import { z } from "zod";

const addSchema = z.object({
  pat: z.string().min(1, "Personal Access Token is required"),
  label: z.string().min(1, "Label is required"),
});

export async function GET() {
  try {
    const accounts = await listGitHubAccounts();
    // Never expose tokens — just return account metadata
    return NextResponse.json(accounts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = addSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const account = await addGitHubAccount(parsed.data.pat, parsed.data.label);
    return NextResponse.json(account, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Surface GitHub auth errors clearly
    if (message.includes("Bad credentials") || message.includes("401")) {
      return NextResponse.json(
        { error: "Invalid Personal Access Token. Please check and try again." },
        { status: 401 }
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
