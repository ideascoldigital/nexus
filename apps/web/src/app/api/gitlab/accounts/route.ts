import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addGitLabAccount, listGitLabAccounts } from "@/services/gitlab";

// A server is a URL plus one way to authenticate against it: a saved GitLab
// credential (the common case — the token that already clones is the token
// that reads issues) or a pasted PAT.
const addSchema = z
  .object({
    baseUrl: z.string().min(1, "The GitLab URL is required"),
    label: z.string().min(1, "A label is required").max(60),
    pat: z.string().min(1).optional(),
    credentialId: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.pat) !== Boolean(v.credentialId), {
    message: "Pick a saved GitLab credential or paste a token — not both",
    path: ["credentialId"],
  });

export async function GET() {
  try {
    // Never expose tokens — accounts only ever carry metadata.
    return NextResponse.json(await listGitLabAccounts());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const parsed = addSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const { account, created } = await addGitLabAccount({
      baseUrl: parsed.data.baseUrl,
      label: parsed.data.label,
      token: parsed.data.pat,
      credentialId: parsed.data.credentialId,
    });
    // 200 rather than 201 when this re-registered a server that already
    // existed: the count in the card does not grow, and the caller has to be
    // able to say so instead of reporting an add that silently replaced one.
    return NextResponse.json(account, { status: created ? 201 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("401")) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
