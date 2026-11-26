// Signing a bot into one of its own MCP servers (spec 37).
//
// Claude Code keeps an MCP server's OAuth token under the server's name plus a
// hash of its type, url and headers — not under the config it was declared in.
// So a sign-in done with `claude mcp login` inside the computer is found again
// by the runs, which declare the very same server through `--mcp-config`. Two
// things make that work:
//
//   - the sign-in happens on the bot's own desktop, where there is a real
//     terminal and a browser that can reach the OAuth callback;
//   - BOT_CLAUDE_DIR is mounted from the host (bot-workspace), so the token
//     outlives the computer that got it.
//
// Only `http`/`sse` servers are in scope: a stdio server runs as a local
// command and has no sign-in of its own.

import { prisma } from "@nexux/db";
import { botMcpState, startBotMcpLogin, type BotMcpState } from "@nexux/sandbox";

import { activeSession } from "@/lib/bot-manager";
import { validateBotMcpServers } from "@/lib/bot-mcp";
import { botMayUse, resolveSecretRefs } from "@/lib/vault-items";

export type BotMcpServerInfo = {
  name: string;
  /** stdio servers are listed too — the UI says why they have no sign-in. */
  kind: "stdio" | "http" | "sse";
  /** A vault secret the server needs that this bot cannot use; it is not loaded at all. */
  missingSecret: string | null;
};

export type BotMcpServerStatus = BotMcpServerInfo & {
  state: BotMcpState | "asleep" | "not-checked";
  detail: string | null;
};

/** The bot's own servers, secrets resolved, as the sign-in and status paths need them. */
export async function botMcpServers(botId: string): Promise<{
  servers: { info: BotMcpServerInfo; definition: Record<string, unknown> }[];
}> {
  const bot = await prisma.bot.findUnique({ where: { id: botId } });
  if (!bot) throw new Error("Bot not found");
  const own = validateBotMcpServers(bot.mcpServers);
  if (!own.ok || !own.servers) return { servers: [] };

  const vault = (await prisma.vaultItem.findMany({ where: { type: "secret" } })).filter((v) =>
    botMayUse(v, botId),
  );
  const secretOf = (name: string) => {
    const value = (vault.find((v) => v.name === name)?.secret as { value?: unknown } | undefined)?.value;
    return typeof value === "string" ? value : null;
  };
  const resolved = resolveSecretRefs(own.servers, secretOf);

  return {
    servers: Object.entries(own.servers).map(([name, raw]) => {
      const kind = raw.type === "http" || raw.type === "sse" ? raw.type : "stdio";
      const missing = resolved.missing.find((m) => m.server === name)?.secret ?? null;
      return {
        info: { name, kind, missingSecret: missing },
        definition: (resolved.servers[name] ?? raw) as Record<string, unknown>,
      };
    }),
  };
}

/**
 * What each of the bot's servers says right now. Asking means health-checking
 * from inside the computer, so it needs one that is awake; with none, the list
 * still comes back (the UI shows the servers, not an empty panel).
 *
 * stdio servers are never checked: the check would run their command, and the
 * usual `npx -y <pkg>` on a fresh computer is a download of a minute or more.
 */
export async function botMcpStatus(botId: string): Promise<BotMcpServerStatus[]> {
  const { servers } = await botMcpServers(botId);
  if (servers.length === 0) return [];
  const session = await activeSession(botId);
  const live = session?.status === "ready" ? session : null;
  return Promise.all(
    servers.map(async ({ info, definition }) => {
      if (info.missingSecret) {
        return { ...info, state: "not-checked" as const, detail: `needs the vault secret "${info.missingSecret}"` };
      }
      if (info.kind === "stdio") return { ...info, state: "not-checked" as const, detail: null };
      if (!live) return { ...info, state: "asleep" as const, detail: null };
      try {
        const { state, detail } = await botMcpState(live.containerName, info.name, definition, {
          host: live.dockerHost,
        });
        return { ...info, state, detail };
      } catch (err) {
        return { ...info, state: "unknown" as const, detail: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

/**
 * Open the sign-in for one server on the bot's screen. The computer must be
 * awake: the consent page opens in its browser and the OAuth callback comes
 * back to a port inside it, so this cannot be done from the host.
 */
export async function signInBotMcp(botId: string, server: string): Promise<void> {
  const { servers } = await botMcpServers(botId);
  const found = servers.find((s) => s.info.name === server);
  if (!found) throw new Error(`"${server}" is not one of this bot's MCP servers`);
  if (found.info.kind === "stdio") {
    throw new Error(`"${server}" runs as a command inside the computer — it has no sign-in of its own`);
  }
  if (found.info.missingSecret) {
    throw new Error(`"${server}" needs the vault secret "${found.info.missingSecret}" before it can be signed into`);
  }
  const session = await activeSession(botId);
  if (session?.status !== "ready") {
    throw new Error("Wake the bot's computer first — the sign-in happens on its screen");
  }
  await startBotMcpLogin(session.containerName, server, found.definition, { host: session.dockerHost });
}
