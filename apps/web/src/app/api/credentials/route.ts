import { prisma } from "@nexux/db";
import { LLM_CREDENTIAL_PROVIDERS } from "@nexux/sandbox";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActiveWorkspaceId } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function mask(value: string): string {
  return value.length > 4 ? "••••" + value.slice(-4) : "••••";
}

// Secrets never leave the server — list responses carry a masked hint only.
function toSummary(cred: {
  id: string;
  name: string;
  provider: string;
  data: unknown;
  createdAt: Date;
}) {
  const data = (cred.data ?? {}) as {
    token?: string;
    accessKeyId?: string;
    apiKey?: string;
    authKey?: string;
    loginServer?: string;
    registryHost?: string;
  };
  const secret = data.token ?? data.apiKey ?? data.authKey ?? "";
  // civo/github store a single token; LLM providers a single apiKey. A
  // Tailscale credential may legitimately carry no secret at all — masking an
  // empty string would render as "••••" and read like a key that is there.
  const hint =
    cred.provider === "aws"
      ? (data.accessKeyId ?? "").slice(0, 8) + "…"
      : secret
        ? mask(secret)
        : cred.provider === "tailscale"
          ? "browser login"
          : "";
  return {
    id: cred.id,
    name: cred.name,
    provider: cred.provider,
    hint,
    // Not a secret: which coordination server this credential joins. Null for
    // Tailscale's own control plane and for every other provider.
    loginServer: data.loginServer ?? null,
    // Not a secret, and the host form needs it to tell which credential can log
    // in to the registry an image lives on.
    registryHost: data.registryHost ?? null,
    createdAt: cred.createdAt,
  };
}

export async function GET() {
  // Credentials are global: every workspace sees and can use all of them.
  // workspaceId on the row is provenance only (which workspace saved it).
  const credentials = await prisma.cloudCredential.findMany({
    orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(credentials.map(toSummary));
}

const createSchema = z.union([
  z.object({
    provider: z.literal("aws"),
    name: z.string().min(1).max(60),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
  }),
  // Tailscale (spec 19 — Nexus hosts). Unlike the other token providers both
  // fields are optional, because the two ways to join a tailnet are mutually
  // exclusive in practice: an auth key from an admin console, or — on a
  // self-hosted control plane you do not administer — a login server and an
  // interactive registration the bootstrap prints a URL for. One or the other
  // must be present; a credential with neither would join nothing.
  z
    .object({
      provider: z.literal("tailscale"),
      name: z.string().min(1).max(60),
      authKey: z.string().min(1).optional(),
      loginServer: z
        .string()
        .trim()
        .url("Expected a URL like https://vpn.example.com")
        .refine(
          (v) => /^https?:\/\//i.test(v),
          "The control server must be an http(s) URL",
        )
        .optional(),
    })
    .refine((v) => v.authKey || v.loginServer, {
      message: "Provide an auth key, a control server URL, or both",
      path: ["authKey"],
    }),
  // Single-token providers: Civo API key, git hosting tokens, Claude Code
  // OAuth tokens.
  z.object({
    provider: z.enum(["civo", "github", "gitlab", "bitbucket", "claude"]),
    name: z.string().min(1).max(60),
    token: z.string().min(1),
    // Container registry this token logs in to, for a self-hosted git install
    // whose registry is not the provider's public one. A bare host, optionally
    // with a port — a URL or a path would not be a valid `docker login` target.
    registryHost: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/i,
        "Expected a registry host like registry.example.com or registry.example.com:5000",
      )
      .optional(),
  }),
  // LLM provider API keys (spec 16) — injected into sandboxes for OpenCode.
  z.object({
    provider: z.enum(
      LLM_CREDENTIAL_PROVIDERS as [string, ...string[]],
    ),
    name: z.string().min(1).max(60),
    apiKey: z.string().min(1),
  }),
]);

/**
 * The secrets to persist for one accepted input. Discriminated on the fields
 * rather than on `provider`: the LLM branch's provider widens to `string`
 * (its values come from a runtime list), so a provider comparison would not
 * narrow the union. Tailscale is last because it is the only shape defined by
 * what it lacks — both of its fields are optional.
 */
function credentialData(
  input: z.infer<typeof createSchema>,
): Record<string, string> {
  if ("accessKeyId" in input) {
    return {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
    };
  }
  if ("apiKey" in input) return { apiKey: input.apiKey };
  if ("token" in input) {
    return {
      token: input.token,
      ...(input.registryHost
        ? { registryHost: input.registryHost.toLowerCase() }
        : {}),
    };
  }
  return {
    ...(input.authKey ? { authKey: input.authKey } : {}),
    // Trailing slash stripped so the stored value matches what goes on the
    // `--login-server` flag verbatim.
    ...(input.loginServer
      ? { loginServer: input.loginServer.replace(/\/+$/, "") }
      : {}),
  };
}

export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const data = credentialData(input);

  const created = await prisma.cloudCredential.create({
    data: {
      workspaceId: await getActiveWorkspaceId(), name: input.name.trim(), provider: input.provider, data },
  });
  return NextResponse.json(toSummary(created), { status: 201 });
}
