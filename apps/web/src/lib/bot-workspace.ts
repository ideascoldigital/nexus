// What survives a bot's computer (spec 31): the shared workspace and each
// bot's browser profile. Both are host folders bind-mounted into every
// computer, so a bot that wakes up finds its files and its sign-ins, and
// bots see each other's work — like teammates on a shared drive.

import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@nexux/config";
import { BOT_CHROME_PROFILE, BOT_WORKSPACE } from "@nexux/sandbox";

/** ~/.nexux/workspace — mounted as /workspace in every bot's computer. */
export function workspaceRoot(): string {
  return path.join(getConfig().dataDir, "workspace");
}

/** ~/.nexux/bot-profiles/<botId> — one bot's Chromium profile (cookies, sign-ins). */
export function botProfileDir(botId: string): string {
  return path.join(getConfig().dataDir, "bot-profiles", botId);
}

/** A bot's own folder under the workspace: "Creative Designer" → "creative-designer". */
export function workspaceFolderFor(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "bot";
}

/** The bot's working directory inside its computer. */
export function botWorkdir(name: string): string {
  return `${BOT_WORKSPACE}/${workspaceFolderFor(name)}`;
}

/** Create the host folders and return the mounts for a bot's computer. */
export function botMounts(bot: { id: string; name: string }): { host: string; container: string }[] {
  const root = workspaceRoot();
  fs.mkdirSync(path.join(root, workspaceFolderFor(bot.name)), { recursive: true });
  const profile = botProfileDir(bot.id);
  fs.mkdirSync(profile, { recursive: true });
  return [
    { host: root, container: BOT_WORKSPACE },
    { host: profile, container: BOT_CHROME_PROFILE },
  ];
}

/** A bot is deleted: its sign-ins go with it. Its workspace folder stays — it is shared work. */
export function removeBotProfile(botId: string): void {
  fs.rmSync(botProfileDir(botId), { recursive: true, force: true });
}
